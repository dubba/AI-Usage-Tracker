import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  accountNeedsAttention,
  accountStatus,
  accountWindowRemaining,
  accountsNeedScheduledRefresh,
  canonicalWindow,
  displayAccountLabel,
  formatRemainingDuration,
  formatResetAtShort,
  formatUpdatedAt,
  groupAverage,
  isMonthlyWindow,
  nextResetSummary,
  orderedWindows,
  resetCountdownLabel,
  usageTone,
  windowLength,
} from "./usage-logic";
import type { Account, UsageSnapshot, UsageWindow } from "./types";

const NOW = new Date("2026-09-29T12:00:00.000Z").getTime();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function win(overrides: Partial<UsageWindow> = {}): UsageWindow {
  return {
    id: "five_hour",
    label: "5 hour limit",
    usedPercent: 20,
    remainingPercent: 80,
    resetsAt: null,
    windowSeconds: null,
    ...overrides,
  };
}

function usage(overrides: Partial<UsageSnapshot> = {}): UsageSnapshot {
  return {
    plan: null,
    email: null,
    windows: [win()],
    creditsUsd: null,
    unlimitedCredits: false,
    fetchedAt: new Date(NOW).toISOString(),
    freshness: "live",
    source: "test",
    ...overrides,
  };
}

function account(overrides: Partial<Account> = {}): Account {
  return {
    id: "a1",
    label: "Work",
    provider: "openai",
    email: null,
    providerAccountId: null,
    chatgptAccountId: null,
    plan: null,
    createdAt: new Date(NOW).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
    lastUsage: usage(),
    lastError: null,
    authRequired: false,
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("formatRemainingDuration", () => {
  it("returns null for zero, negative, and non-finite values", () => {
    expect(formatRemainingDuration(0)).toBeNull();
    expect(formatRemainingDuration(-5_000)).toBeNull();
    expect(formatRemainingDuration(Number.NaN)).toBeNull();
    expect(formatRemainingDuration(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("rounds sub-minute values down to 5s / 15s / 30s / 45s steps", () => {
    expect(formatRemainingDuration(2_000)).toBe("5s");
    expect(formatRemainingDuration(15_000)).toBe("15s");
    expect(formatRemainingDuration(29_999)).toBe("15s");
    expect(formatRemainingDuration(30_000)).toBe("30s");
    expect(formatRemainingDuration(45_000)).toBe("45s");
    expect(formatRemainingDuration(59_999)).toBe("45s");
  });

  it("formats minutes, hours and days", () => {
    expect(formatRemainingDuration(MINUTE)).toBe("1m");
    expect(formatRemainingDuration(59 * MINUTE)).toBe("59m");
    expect(formatRemainingDuration(HOUR)).toBe("1h 0m");
    expect(formatRemainingDuration(2 * HOUR + 5 * MINUTE)).toBe("2h 5m");
    expect(formatRemainingDuration(24 * HOUR)).toBe("1d");
    expect(formatRemainingDuration(50 * HOUR)).toBe("2d 2h");
  });
});

describe("resetCountdownLabel", () => {
  it("returns null without a usable reset time", () => {
    expect(resetCountdownLabel(null)).toBeNull();
    expect(resetCountdownLabel(undefined)).toBeNull();
    expect(resetCountdownLabel("not a date")).toBeNull();
  });

  it("returns null once the reset time has passed", () => {
    expect(resetCountdownLabel(new Date(NOW - MINUTE).toISOString(), NOW)).toBeNull();
  });

  it("labels the time remaining", () => {
    const resetsAt = new Date(NOW + 90 * MINUTE).toISOString();
    expect(resetCountdownLabel(resetsAt, NOW)).toBe("Reset: 1h 30m");
  });

  it("never reports more than one full window remaining", () => {
    const resetsAt = new Date(NOW + 10 * HOUR).toISOString();
    expect(resetCountdownLabel(resetsAt, NOW, 5 * 3600)).toBe("Reset: 4h 59m");
  });

  it("does not count down from a stale `now` older than the real clock", () => {
    const resetsAt = new Date(NOW + 30 * MINUTE).toISOString();
    vi.setSystemTime(NOW + 10 * MINUTE);
    expect(resetCountdownLabel(resetsAt, NOW)).toBe("Reset: 20m");
  });
});

describe("nextResetSummary", () => {
  it("reports no upcoming reset when nothing is scheduled", () => {
    expect(nextResetSummary([account()], NOW)).toEqual({ account: null, value: "—", resetsAt: null });
    expect(nextResetSummary([], NOW)).toEqual({ account: null, value: "—", resetsAt: null });
  });

  it("picks the earliest future reset across accounts and windows", () => {
    const soon = new Date(NOW + 2 * HOUR).toISOString();
    const later = new Date(NOW + 5 * HOUR).toISOString();
    const accounts = [
      account({ id: "a", label: "Later", lastUsage: usage({ windows: [win({ resetsAt: later })] }) }),
      account({
        id: "b",
        label: "Sooner",
        lastUsage: usage({ windows: [win({ resetsAt: later }), win({ id: "weekly", resetsAt: soon })] }),
      }),
    ];
    expect(nextResetSummary(accounts, NOW)).toEqual({ account: "Sooner", value: "2h 0m", resetsAt: soon });
  });

  it("ignores resets in the past and invalid dates", () => {
    const accounts = [
      account({
        lastUsage: usage({
          windows: [
            win({ resetsAt: new Date(NOW - HOUR).toISOString() }),
            win({ resetsAt: "garbage" }),
          ],
        }),
      }),
    ];
    expect(nextResetSummary(accounts, NOW).account).toBeNull();
  });
});

describe("accountsNeedScheduledRefresh", () => {
  it("is false when every account was fetched within the interval", () => {
    expect(accountsNeedScheduledRefresh([account()], 15, NOW + 14 * MINUTE)).toBe(false);
  });

  it("is true once an account is at or past the interval", () => {
    expect(accountsNeedScheduledRefresh([account()], 15, NOW + 15 * MINUTE)).toBe(true);
  });

  it("is true for accounts that were never fetched or have a bad timestamp", () => {
    expect(accountsNeedScheduledRefresh([account({ lastUsage: null })], 15, NOW)).toBe(true);
    expect(
      accountsNeedScheduledRefresh([account({ lastUsage: usage({ fetchedAt: "nope" }) })], 15, NOW),
    ).toBe(true);
  });

  it("skips accounts that need re-authentication", () => {
    const stale = account({ authRequired: true, lastUsage: null });
    expect(accountsNeedScheduledRefresh([stale], 15, NOW + HOUR)).toBe(false);
  });

  it("skips Google AI Studio accounts that only have key/model access", () => {
    const keyOnly = account({
      provider: "google_ai_studio",
      lastUsage: usage({ source: "google_ai_studio_model_access" }),
    });
    expect(accountsNeedScheduledRefresh([keyOnly], 15, NOW + HOUR)).toBe(false);
  });
});

describe("formatUpdatedAt", () => {
  it("returns null for empty or invalid input", () => {
    expect(formatUpdatedAt(null)).toBeNull();
    expect(formatUpdatedAt(undefined)).toBeNull();
    expect(formatUpdatedAt("bad")).toBeNull();
  });

  it("formats elapsed time in the largest sensible unit", () => {
    const at = (offset: number) => new Date(NOW - offset).toISOString();
    expect(formatUpdatedAt(at(20_000), NOW)).toBe("Updated just now");
    expect(formatUpdatedAt(at(5 * MINUTE), NOW)).toBe("Updated 5m ago");
    expect(formatUpdatedAt(at(3 * HOUR), NOW)).toBe("Updated 3h ago");
    expect(formatUpdatedAt(at(49 * HOUR), NOW)).toBe("Updated 2d ago");
  });

  it("treats timestamps in the future as just now", () => {
    expect(formatUpdatedAt(new Date(NOW + HOUR).toISOString(), NOW)).toBe("Updated just now");
  });
});

describe("usageTone", () => {
  it("maps remaining percent to a tone at the boundaries", () => {
    expect(usageTone(null)).toBe("neutral");
    expect(usageTone(0)).toBe("critical");
    expect(usageTone(10)).toBe("critical");
    expect(usageTone(10.1)).toBe("warning");
    expect(usageTone(30)).toBe("warning");
    expect(usageTone(30.1)).toBe("healthy");
    expect(usageTone(100)).toBe("healthy");
  });
});

describe("window classification", () => {
  it("recognises five-hour windows by id, seconds, or label", () => {
    expect(canonicalWindow(win({ id: "five-hour" }), "five_hour")).toBe(true);
    expect(canonicalWindow(win({ id: "x", label: "misc", windowSeconds: 18_000 }), "five_hour")).toBe(true);
    expect(canonicalWindow(win({ id: "x", label: "Claude · 5h limit" }), "five_hour")).toBe(true);
    expect(canonicalWindow(win({ id: "weekly", label: "Weekly" }), "five_hour")).toBe(false);
  });

  it("recognises weekly windows by id, seconds, or label", () => {
    expect(canonicalWindow(win({ id: "weekly", label: "x" }), "weekly")).toBe(true);
    expect(canonicalWindow(win({ id: "x", label: "x", windowSeconds: 604_800 }), "weekly")).toBe(true);
    expect(canonicalWindow(win({ id: "x", label: "7 day limit" }), "weekly")).toBe(true);
    expect(canonicalWindow(win({ id: "five_hour" }), "weekly")).toBe(false);
  });

  it("recognises monthly windows", () => {
    expect(isMonthlyWindow(win({ id: "monthly", label: "x" }))).toBe(true);
    expect(isMonthlyWindow(win({ id: "x", label: "30-day" }))).toBe(true);
    expect(isMonthlyWindow(win({ id: "x", label: "x", windowSeconds: 2_592_000 }))).toBe(true);
    expect(isMonthlyWindow(win({ id: "weekly", label: "Weekly", windowSeconds: 604_800 }))).toBe(false);
  });
});

describe("accountWindowRemaining / groupAverage", () => {
  const hourlyAndWeekly = account({
    lastUsage: usage({
      windows: [
        win({ id: "five_hour", remainingPercent: 40 }),
        win({ id: "weekly", label: "Weekly", remainingPercent: 70 }),
      ],
    }),
  });
  const weeklyOnly = account({
    id: "b",
    lastUsage: usage({ windows: [win({ id: "weekly", label: "Weekly", remainingPercent: 50 })] }),
  });
  const monthlyOnly = account({
    id: "c",
    lastUsage: usage({ windows: [win({ id: "monthly", label: "Monthly", remainingPercent: 90 })] }),
  });

  it("returns the matching window's remaining percent", () => {
    expect(accountWindowRemaining(hourlyAndWeekly, "five_hour")).toBe(40);
    expect(accountWindowRemaining(hourlyAndWeekly, "weekly")).toBe(70);
  });

  it("returns null for the hourly view when the account has no hourly window", () => {
    expect(accountWindowRemaining(weeklyOnly, "five_hour")).toBeNull();
  });

  it("falls back to the monthly window for the weekly view", () => {
    expect(accountWindowRemaining(monthlyOnly, "weekly")).toBe(90);
  });

  it("returns null with no usage data", () => {
    expect(accountWindowRemaining(account({ lastUsage: null }), "weekly")).toBeNull();
    expect(accountWindowRemaining(account({ lastUsage: usage({ windows: [] }) }), "weekly")).toBeNull();
  });

  it("averages only accounts that report a value", () => {
    expect(groupAverage([hourlyAndWeekly, weeklyOnly, monthlyOnly], "weekly")).toBeCloseTo(70);
    expect(groupAverage([hourlyAndWeekly, weeklyOnly], "five_hour")).toBe(40);
    expect(groupAverage([weeklyOnly], "five_hour")).toBeNull();
  });
});

describe("accountNeedsAttention / accountStatus", () => {
  it("is healthy for a live account with usage", () => {
    expect(accountNeedsAttention(account())).toBe(false);
    expect(accountStatus(account())).toEqual({ label: "LIVE", className: "success" });
  });

  it.each([
    ["auth required", { authRequired: true }],
    ["a last error", { lastError: "boom" }],
    ["no usage yet", { lastUsage: null }],
    ["stale usage", { lastUsage: usage({ freshness: "stale" }) }],
  ] as const)("needs attention with %s", (_name, overrides) => {
    expect(accountNeedsAttention(account({ ...overrides }))).toBe(true);
  });

  it("reports the right status label", () => {
    expect(accountStatus(account({ authRequired: true })).label).toBe("AUTH NEEDED");
    expect(accountStatus(account({ lastUsage: usage({ freshness: "auth_required" }) })).label).toBe("AUTH NEEDED");
    expect(accountStatus(account({ lastError: "x" })).label).toBe("ACTION NEEDED");
    expect(accountStatus(account({ lastUsage: usage({ freshness: "stale" }) })).label).toBe("ACTION NEEDED");
    expect(accountStatus(account({ lastUsage: null })).label).toBe("INACTIVE");
  });

  it("flags Google AI Studio accounts without quota windows", () => {
    const keyOnly = account({
      provider: "google_ai_studio",
      lastUsage: usage({ source: "google_ai_studio_model_access" }),
    });
    expect(accountNeedsAttention(keyOnly)).toBe(true);
    expect(accountStatus(keyOnly).label).toBe("KEY ONLY");

    const monitored = account({
      provider: "google_ai_studio",
      lastUsage: usage({ source: "google_ai_studio_cloud_monitoring" }),
    });
    expect(accountNeedsAttention(monitored)).toBe(false);
  });
});

describe("displayAccountLabel", () => {
  it("collapses obsolete branded default labels to the current provider name", () => {
    expect(displayAccountLabel(account({ provider: "antigravity", label: "Google Antigravity" }))).toBe("Antigravity");
    expect(displayAccountLabel(account({ provider: "openai", label: "Codex/GPT 2" }))).toBe("ChatGPT 2");
  });

  it("leaves custom labels alone", () => {
    expect(displayAccountLabel(account({ provider: "openai", label: "My ChatGPT" }))).toBe("My ChatGPT");
    expect(displayAccountLabel(account({ provider: "openai", label: "Codex/GPT beta" }))).toBe("Codex/GPT beta");
  });
});

describe("formatResetAtShort", () => {
  it("returns null for empty or invalid input", () => {
    expect(formatResetAtShort(null)).toBeNull();
    expect(formatResetAtShort("nope")).toBeNull();
  });

  it("uses a compact 12-hour time with a single-letter meridiem in local time", () => {
    expect(formatResetAtShort(new Date(2026, 8, 30, 14, 5).toISOString())).toMatch(/ @ 2:05p$/);
    expect(formatResetAtShort(new Date(2026, 8, 30, 0, 7).toISOString())).toMatch(/ @ 12:07a$/);
    expect(formatResetAtShort(new Date(2026, 8, 30, 12, 0).toISOString())).toMatch(/ @ 12:00p$/);
  });
});

describe("windowLength", () => {
  it("derives the label from windowSeconds", () => {
    expect(windowLength(win({ windowSeconds: 18_000 }))).toBe("5h limit");
    expect(windowLength(win({ windowSeconds: 604_800 }))).toBe("7d limit");
  });

  it("falls back to monthly detection, else null", () => {
    expect(windowLength(win({ id: "monthly", label: "x", windowSeconds: null }))).toBe("30d limit");
    expect(windowLength(win({ id: "x", label: "x", windowSeconds: null }))).toBeNull();
  });
});

describe("orderedWindows", () => {
  it("orders five-hour, weekly, monthly, then everything else", () => {
    const other = win({ id: "other", label: "Other" });
    const monthly = win({ id: "monthly", label: "Monthly" });
    const weekly = win({ id: "weekly", label: "Weekly" });
    const hourly = win({ id: "five_hour" });
    expect(orderedWindows([other, monthly, weekly, hourly]).map((w) => w.id)).toEqual([
      "five_hour",
      "weekly",
      "monthly",
      "other",
    ]);
  });

  it("keeps model groups together in first-seen order", () => {
    const gemini5 = win({ id: "g5", label: "Gemini · 5h limit" });
    const claudeWeekly = win({ id: "cw", label: "Claude · Weekly", windowSeconds: 604_800 });
    const geminiWeekly = win({ id: "gw", label: "Gemini · Weekly", windowSeconds: 604_800 });
    const claude5 = win({ id: "c5", label: "Claude · 5h limit" });
    expect(orderedWindows([gemini5, claudeWeekly, geminiWeekly, claude5]).map((w) => w.id)).toEqual([
      "g5",
      "gw",
      "c5",
      "cw",
    ]);
  });

  it("does not mutate its input", () => {
    const input = [win({ id: "weekly", label: "Weekly" }), win({ id: "five_hour" })];
    orderedWindows(input);
    expect(input.map((w) => w.id)).toEqual(["weekly", "five_hour"]);
  });
});

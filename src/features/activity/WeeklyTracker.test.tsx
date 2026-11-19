// @vitest-environment happy-dom
/// <reference types="node" />
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { click, mount, type Mounted } from "../../test-utils/react";
import { makeAccount, makeTracker, measured } from "../../test-utils/activity-fixtures";
import { displayPlan } from "../../shared/lib/display";
import { setUsageDisplayMode } from "../../shared/lib/usage-display";
import type { Account } from "../../types";
import { NoWeeklyLimitCard } from "./NoWeeklyLimitCard";
import { WeeklyTracker } from "./WeeklyTracker";

const originalZone = process.env.TZ;
let mounted: Mounted | null = null;

beforeEach(() => {
  process.env.TZ = "UTC";
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-16T12:00:00Z"));
});
afterEach(() => {
  mounted?.unmount();
  mounted = null;
  setUsageDisplayMode("left");
  vi.useRealTimers();
  if (originalZone === undefined) delete process.env.TZ;
  else process.env.TZ = originalZone;
});

const dayStarts = Array.from({ length: 8 }, (_, index) => new Date(Date.UTC(2026, 9, 9 + index)));

function render(account: Account, tracker = makeTracker({ accountId: account.id }), onReconnect?: (account: Account) => void) {
  mounted = mount(<WeeklyTracker tracker={tracker} account={account} dayStarts={dayStarts} period="7d" onReconnect={onReconnect} />);
  return mounted.container;
}

const text = (root: ParentNode, selector: string) => root.querySelector(selector)?.textContent ?? null;

describe("WeeklyTracker", () => {
  it("names the account with its plan pill and email, without a reset line", () => {
    const account = makeAccount({ id: "a1", label: "Work Claude", plan: "max", email: "work@example.com" });
    const root = render(account, makeTracker({ accountId: "a1", resetsAt: "2026-10-27T15:00:00Z" }));
    expect(text(root, ".activity-card-title")).toBe("Work Claude");
    expect(text(root, ".activity-plan-pill")).toBe(displayPlan(account));
    expect(text(root, ".activity-consolidated-email")).toBe("work@example.com");
    expect(root.querySelector(".activity-card-head .activity-card-details")).toBeNull();
    expect(root.querySelector("article")!.getAttribute("aria-labelledby")).toBe(root.querySelector(".activity-card-title")!.id);
  });

  it("hides an old percentage once the week or month has reset, and says it ended", () => {
    const account = makeAccount({ id: "a1", label: "Work Claude", plan: "max" });
    const pastReset = "2026-10-15T15:00:00Z";
    const root = render(account, makeTracker({ accountId: "a1", currentUsedPercent: 45, resetsAt: pastReset }));
    expect(text(root, ".activity-card-total strong")).toBe("—");
    expect(root.querySelector(".activity-card-total")!.classList.contains("tone-neutral")).toBe(true);
    expect(text(root, ".activity-card-total-period")).toBe("week ended");
    expect(root.querySelector(".activity-card-total strong")!.getAttribute("aria-label")).toBe("Usage unknown since reset");
    mounted!.unmount();
    mounted = null;

    const monthlyRoot = render(
      account,
      makeTracker({ accountId: "a1", windowKind: "monthly", currentUsedPercent: 30, resetsAt: pastReset }),
    );
    expect(text(monthlyRoot, ".activity-card-total strong")).toBe("—");
    expect(text(monthlyRoot, ".activity-card-total-period")).toBe("month ended");
  });

  it("leaves out what it does not know", () => {
    const root = render(makeAccount({ id: "a1", label: "Plain" }), makeTracker({ accountId: "a1", resetsAt: null }));
    expect(root.querySelector(".activity-plan-pill")).toBeNull();
    expect(root.querySelector(".activity-consolidated-email")).toBeNull();
  });

  it("shows this week's percent, toned by how little is left", () => {
    const tone = (used: number | null) => {
      const root = render(makeAccount({ id: "a1" }), makeTracker({ accountId: "a1", currentUsedPercent: used }));
      const total = root.querySelector(".activity-card-total")!;
      const result = [total.querySelector("strong")!.textContent, [...total.classList].find((name) => name.startsWith("tone-"))];
      mounted!.unmount();
      mounted = null;
      return result;
    };
    // The same tones as the account cards: amber at 30% left, red at 15% left.
    expect(tone(42)).toEqual(["42%", "tone-healthy"]);
    expect(tone(69)).toEqual(["69%", "tone-healthy"]);
    expect(tone(70)).toEqual(["70%", "tone-warning"]);
    expect(tone(84)).toEqual(["84%", "tone-warning"]);
    expect(tone(85)).toEqual(["85%", "tone-critical"]);
    expect(tone(0.4)).toEqual(["<1%", "tone-healthy"]);
    expect(tone(null)).toEqual(["—", "tone-neutral"]);
    const root = render(makeAccount({ id: "a1" }), makeTracker({ accountId: "a1", currentUsedPercent: 42 }));
    expect(text(root, ".activity-card-total-period")).toBe("used this week");
    expect(root.querySelector(".activity-card-total strong")!.getAttribute("aria-label")).toBe("42% of the weekly limit used");
  });

  it("always shows what was used, whatever the Accounts page's Left / Used choice", () => {
    for (const mode of ["left", "used"] as const) {
      setUsageDisplayMode(mode);
      const root = render(makeAccount({ id: "a1" }), makeTracker({ accountId: "a1", currentUsedPercent: 61 }));
      expect(text(root, ".activity-card-total strong")).toBe("61%");
      expect(text(root, ".activity-card-total-period")).toBe("used this week");
      mounted!.unmount();
      mounted = null;
    }
  });

  it("leaves off the unit when the usage is unknown", () => {
    const root = render(makeAccount({ id: "a1" }), makeTracker({ accountId: "a1", currentUsedPercent: null }));
    expect(text(root, ".activity-card-total strong")).toBe("—");
    expect(text(root, ".activity-card-total-period")).toBe("this week");
  });

  it("names the Antigravity model family and leaves off the weekly limit", () => {
    const families = [
      ["Gemini Models · Weekly Limit Remaining", "Gemini Models"],
      ["Claude and GPT models · Weekly Limit Remaining", "Other Models"],
      ["Gemini 4 Argon · Weekly Limit", "Argon Models"],
      ["Gemini 4 Carbon · Weekly Limit", "Carbon Models"],
    ] as const;
    for (const [windowLabel, family] of families) {
      const root = render(
        makeAccount({ id: "a1", provider: "antigravity", label: "Antigravity", email: "me@example.com" }),
        makeTracker({ accountId: "a1", windowId: "gemini", windowLabel }),
      );
      expect(text(root, ".activity-card-title")).toBe("Antigravity");
      expect(text(root, ".activity-consolidated-email")).toBe("me@example.com");
      expect(text(root, ".activity-card-limit")).toBe(family);
      expect(root.querySelector(".activity-card-family")).toBeNull();
      expect(root.querySelector('.activity-bars[role="img"]')!.getAttribute("aria-label")).toContain(`Antigravity ${family}, last 7 days`);
      mounted!.unmount();
      mounted = null;
    }

    const bare = render(
      makeAccount({ id: "a1", provider: "antigravity", label: "Antigravity" }),
      makeTracker({ accountId: "a1", windowLabel: "Weekly Limit Remaining" }),
    );
    expect(text(bare, ".activity-card-limit")).toBe("Weekly Limit Remaining");
    mounted!.unmount();
    mounted = null;

    const claude = render(
      makeAccount({ id: "a1", label: "Work Claude", email: "work@example.com" }),
      makeTracker({ accountId: "a1", windowLabel: "Gemini Models · Weekly Limit Remaining" }),
    );
    expect(claude.querySelector(".activity-card-limit")).toBeNull();
    expect(text(claude, ".activity-card-title")).toBe("Work Claude");
    expect(text(claude, ".activity-consolidated-email")).toBe("work@example.com");
  });

  it("shows the plan pill beside the name and email on its own line for every provider", () => {
    const root = render(makeAccount({ id: "a1", label: "ChatGPT", provider: "openai", plan: "plus", email: "user@example.com" }));
    expect(text(root, ".activity-card-title")).toBe("ChatGPT");
    expect(text(root, ".activity-plan-pill")).toBe("Plus/$20");
    expect(text(root, ".activity-consolidated-email")).toBe("user@example.com");
    expect(root.querySelector(".activity-card-limit")).toBeNull();
  });

  it("places the title, plan pill, and email in the identity column beside the total usage percentage", () => {
    const root = render(
      makeAccount({ id: "a1", label: "Claude123", provider: "anthropic", plan: "pro", email: "m.bahabib@yahoo.com" }),
      makeTracker({ accountId: "a1", currentUsedPercent: 27, resetsAt: "2026-10-16T22:50:00Z" }),
    );
    const identity = root.querySelector(".activity-card-identity")!;
    expect(identity).not.toBeNull();
    expect(identity.querySelector(".activity-consolidated-title-row .activity-card-title")!.textContent).toBe("Claude123");
    expect(identity.querySelector(".activity-consolidated-title-row .activity-plan-pill")!.textContent).toBe("Pro/$20");
    expect(identity.querySelector(".activity-consolidated-email")!.textContent).toBe("m.bahabib@yahoo.com");
    expect(identity.querySelector(".activity-card-details")).toBeNull();

    // Total column contains the percentage and the period label below it
    const total = root.querySelector(".activity-card-total")!;
    expect(total).not.toBeNull();
    expect(total.querySelector("strong")!.textContent).toBe("27%");
    expect(total.querySelector(".activity-card-total-period")!.textContent).toBe("used this week");
  });

  it("uses the email from the latest usage when the account has none saved", () => {
    const account = makeAccount({ id: "a1", label: "Grok", provider: "grok" });
    account.lastUsage!.email = "grok@example.com";
    const root = render(account);
    expect(text(root, ".activity-consolidated-email")).toBe("grok@example.com");
  });

  it("draws the daily bars for its days and resets", () => {
    const root = render(makeAccount({ id: "a1", label: "Work Claude" }), makeTracker({ accountId: "a1", days: Array.from({ length: 7 }, () => measured(9)) }));
    expect(root.querySelectorAll(".activity-bar")).toHaveLength(7);
    expect(root.querySelector('.activity-bars[role="img"]')!.getAttribute("aria-label")).toContain("Work Claude, last 7 days");
  });

  it("calls a monthly limit monthly: this month, the monthly summary and monthly resets", () => {
    const account = makeAccount({ id: "free", label: "ChatGPT", provider: "openai" });
    const tracker = makeTracker({ accountId: "free", windowId: "monthly", windowKind: "monthly", currentUsedPercent: 40, resets: ["2026-10-12T15:00:00Z"] }, 30);
    mounted = mount(
      <WeeklyTracker tracker={tracker} account={account} dayStarts={Array.from({ length: 31 }, (_, i) => new Date(Date.UTC(2026, 8, 16 + i)))} period="30d" />,
    );
    const root = mounted.container;
    expect(text(root, ".activity-card-total-period")).toBe("used this month");
    expect(root.querySelector(".activity-card-total strong")!.getAttribute("aria-label")).toBe("40% of the monthly limit used");
    expect(root.querySelector<HTMLElement>(".activity-reset [data-tooltip]")!.dataset.tooltip).toMatch(/^Monthly reset · /);
    expect(text(root, "table th")).toBe("Day");
    expect(root.querySelector("table thead")!.textContent).toContain("Monthly limit used");
  });

  it("is not dimmed, has no notice, and has no error border while the account is signed in", () => {
    const root = render(makeAccount({ id: "a1" }), undefined, vi.fn());
    const card = root.querySelector(".activity-card")!;
    expect(card.classList.contains("is-dimmed")).toBe(false);
    expect(card.classList.contains("needs-attention")).toBe(false);
    expect(root.querySelector(".activity-card-notice")).toBeNull();
  });

  it("dims an account that needs to sign in, keeps its data, and offers to reconnect", () => {
    const onReconnect = vi.fn();
    const account = makeAccount({ id: "a1", authRequired: true, lastError: "Sign-in expired.", health: "signed_out" });
    const root = render(account, undefined, onReconnect);
    const card = root.querySelector(".activity-card")!;
    expect(card.classList.contains("is-dimmed")).toBe(true);
    expect(card.classList.contains("needs-attention")).toBe(true);
    expect(text(root, ".activity-card-notice span")).toBe("Sign-in expired.");
    expect(text(root, ".activity-card-notice button")).toBe("Sign in again");
    expect(root.querySelectorAll(".activity-bar")).toHaveLength(7);
    click(root.querySelector<HTMLButtonElement>(".activity-card-notice button")!);
    expect(onReconnect).toHaveBeenCalledWith(account);
  });

  it("marks cards with lastError or stale usage as needing attention", () => {
    const errored = render(makeAccount({ id: "a1", lastError: "Refresh failed." }));
    expect(errored.querySelector(".activity-card")!.classList.contains("needs-attention")).toBe(true);
    mounted!.unmount();
    mounted = null;

    const staleAccount = makeAccount({ id: "a2" });
    staleAccount.lastUsage!.freshness = "stale";
    const stale = render(staleAccount);
    expect(stale.querySelector(".activity-card")!.classList.contains("needs-attention")).toBe(true);
  });

  it("treats an auth_required snapshot like a sign-in notice, with a fallback text and the Cloud wording", () => {
    const account = makeAccount({ id: "a1", provider: "google_ai_studio" });
    account.lastUsage!.freshness = "auth_required";
    account.health = "signed_out";
    const root = render(account, undefined, vi.fn());
    expect(root.querySelector(".activity-card")!.classList.contains("needs-attention")).toBe(true);
    expect(text(root, ".activity-card-notice span")).toBe("Sign in again to keep tracking this account.");
    expect(text(root, ".activity-card-notice button")).toBe("Reconnect Cloud Usage");
  });

  it("shows no reconnect button when it cannot reconnect", () => {
    const root = render(makeAccount({ id: "a1", authRequired: true, health: "signed_out" }));
    expect(root.querySelector(".activity-card-notice button")).toBeNull();
  });
});

describe("NoWeeklyLimitCard", () => {
  it("names the account, badges it, and explains why there is no chart", () => {
    mounted = mount(<NoWeeklyLimitCard account={makeAccount({ id: "s1", label: "Studio key", provider: "google_ai_studio" })} otherLimits={["daily", "per_minute"]} />);
    const root = mounted.container;
    expect(text(root, ".activity-card-title")).toBe("Studio key");
    expect(root.querySelector(".activity-card-email")).toBeNull();
    expect(text(root, ".activity-badge")).toBe("No weekly limit");
    expect(text(root, ".activity-card-details")).toBe(
      "This account only has daily and per-minute limits, so there's no weekly usage to chart. Its current limits are on the Accounts tab.",
    );
    expect(root.querySelector(".activity-card")!.classList.contains("is-no-weekly")).toBe(true);
    expect(root.querySelector(".activity-card")!.classList.contains("needs-attention")).toBe(false);
    expect(root.querySelector(".activity-bars")).toBeNull();
  });

  it("marks a no-weekly-limit card as needing attention when it has an error", () => {
    mounted = mount(<NoWeeklyLimitCard account={makeAccount({ id: "s1", label: "Studio key", provider: "google_ai_studio", lastError: "API key rejected." })} otherLimits={["daily"]} />);
    expect(mounted.container.querySelector(".activity-card")!.classList.contains("needs-attention")).toBe(true);
  });

  it("shows the account email beside the name", () => {
    mounted = mount(
      <NoWeeklyLimitCard account={makeAccount({ id: "s1", label: "Studio key", provider: "google_ai_studio", email: "studio@example.com" })} otherLimits={["daily"]} />,
    );
    expect(text(mounted.container, ".activity-card-title-line")).toBe("Studio key · studio@example.com");
    expect(text(mounted.container, ".activity-badge")).toBe("No weekly limit");
  });

  it("words a monthly-only account differently", () => {
    mounted = mount(<NoWeeklyLimitCard account={makeAccount({ id: "f1", label: "Free ChatGPT", provider: "openai" })} otherLimits={["monthly"]} />);
    expect(text(mounted.container, ".activity-card-details")).toBe(
      "This account has a monthly limit only, so there's no weekly usage to chart. Its current limit is on the Accounts tab.",
    );
  });
});

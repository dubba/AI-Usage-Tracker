import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { LimitReset, UsageWindow } from "../../types";
import { limitResetAdvice, RESET_CLEARS } from "./limit-reset-advice";

const NOW = Date.parse("2026-11-17T10:00:00Z");
const HOUR = 3_600_000;

function window(kind: UsageWindow["kind"], remainingPercent: number | null, extra: Partial<UsageWindow> = {}): UsageWindow {
  return {
    id: kind ?? "other",
    label: kind === "five_hour" ? "5-Hour" : "Weekly",
    usedPercent: remainingPercent == null ? null : 100 - remainingPercent,
    remainingPercent,
    resetsAt: null,
    windowSeconds: null,
    kind,
    ...extra,
  };
}

function grant(detail: string, expiresAt: string | null = null): LimitReset {
  return { id: "g", label: "Full reset", detail, expiresAt, usable: true };
}

const FULL = "Clears the 5-hour and 7-day limits";

describe("limitResetAdvice", () => {
  it("names what both limits would get back", () => {
    expect(limitResetAdvice(grant(FULL), [window("five_hour", 40), window("weekly", 78)], NOW)).toBe("You'd get back 60% of your 5-hour limit and 22% of your 7-day limit.");
  });

  it("says when one limit is already full", () => {
    expect(limitResetAdvice(grant(FULL), [window("five_hour", 100), window("weekly", 78)], NOW)).toBe("Your 5-hour limit is already full, so you'd only get back 22% of your 7-day limit.");
  });

  it("says when nothing would come back", () => {
    expect(limitResetAdvice(grant(FULL), [window("five_hour", 100), window("weekly", 99.6)], NOW)).toBe(
      "Your 5-hour and 7-day limits are already full, so this would restore nothing right now.",
    );
  });

  it("points out a limit that resets on its own within a day", () => {
    const fiveHour = window("five_hour", 30, { resetsAt: new Date(NOW + 2 * HOUR + 10 * 60_000).toISOString() });
    expect(limitResetAdvice(grant("Clears the 5-hour limit"), [fiveHour, window("weekly", 50)], NOW)).toBe(
      "You'd get back 70% of your 5-hour limit, which resets on its own in 2h 10m.",
    );
  });

  it("does not point out a reset days away", () => {
    const weekly = window("weekly", 50, { resetsAt: new Date(NOW + 4 * 24 * HOUR).toISOString() });
    expect(limitResetAdvice(grant("Clears the 7-day limit"), [weekly], NOW)).toBe(
      "You'd get back 50% of your 7-day limit.",
    );
  });

  it("mentions an expiry within three days", () => {
    const soon = new Date(NOW + 26 * HOUR).toISOString();
    expect(limitResetAdvice(grant("Clears the 7-day limit", soon), [window("weekly", 50)], NOW)).toBe(
      "You'd get back 50% of your 7-day limit. This reset expires in 1d 2h.",
    );
    const later = new Date(NOW + 10 * 24 * HOUR).toISOString();
    expect(limitResetAdvice(grant("Clears the 7-day limit", later), [window("weekly", 50)], NOW)).not.toContain(
      "expires",
    );
  });

  it("reads the main weekly window, not a model's, and the Fable one for a Fable reset", () => {
    const windows = [
      window("five_hour", 90),
      window("weekly", 60, { id: "seven_day", label: "Weekly" }),
      window("weekly", 10, { id: "seven_day_fable", label: "Fable · Weekly" }),
    ];
    expect(limitResetAdvice(grant("Clears the 7-day limit"), windows, NOW)).toBe(
      "You'd get back 40% of your 7-day limit.",
    );
    expect(
      limitResetAdvice(grant("Clears 7-day Fable usage and refills the 5-hour limit"), windows, NOW),
    ).toBe("You'd get back 90% of your 7-day Fable limit and 10% of your 5-hour limit.");
  });

  it("measures Grok's main 7-day window, never Grok Bot's", () => {
    const windows = [
      window("weekly", 90, { id: "grok_bot", label: "Grok Bot weekly" }),
      window("weekly", 30, { id: "grok_weekly", label: "Grok 7d" }),
    ];
    expect(limitResetAdvice(grant("Clears the 7-day limit"), windows, NOW)).toBe(
      "You'd get back 70% of your 7-day limit.",
    );
    expect(limitResetAdvice(grant("Clears the 7-day limit"), [windows[0]], NOW)).toBeNull();
  });

  it("gives no advice it cannot back up", () => {
    expect(limitResetAdvice(grant("Restores that rate limit."), [window("five_hour", 10)], NOW)).toBeNull();
    expect(limitResetAdvice(grant(FULL), [window("five_hour", 10)], NOW)).toBeNull();
    expect(limitResetAdvice(grant(FULL), [window("five_hour", 10), window("weekly", null)], NOW)).toBeNull();
    expect(limitResetAdvice(grant("Clears 7-day Fable usage"), [window("weekly", 10)], NOW)).toBeNull();
  });

  it("matches every detail the backend writes for a reset it can read", () => {
    const rust = readFileSync(resolve(__dirname, "../../../src-tauri/src/providers/limit_resets.rs"), "utf8");
    const details = [...rust.matchAll(/pub const DETAIL_\w+: &str = "([^"]+)";/g)].map((match) => match[1]);
    for (const [prefix] of RESET_CLEARS) {
      expect(details).toContain(prefix);
    }
  });
});

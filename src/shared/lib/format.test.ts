import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  formatClockTime,
  formatCount,
  formatElapsed,
  formatMonthDay,
  formatRemainingDuration,
  formatResetAtShort,
  formatUpdatedAt,
  resetCountdownLabel,
} from "./format";

const NOW = new Date("2026-09-29T12:00:00.000Z").getTime();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("formatCount", () => {
  const forms = { one: "account", other: "accounts" };

  it("picks singular and plural forms", () => {
    expect(formatCount(0, forms, "en-US")).toBe("0 accounts");
    expect(formatCount(1, forms, "en-US")).toBe("1 account");
    expect(formatCount(2, forms, "en-US")).toBe("2 accounts");
  });
});

describe("formatClockTime", () => {
  const afternoon = new Date(2026, 8, 30, 14, 5);
  const midnight = new Date(2026, 8, 30, 0, 7);
  const noon = new Date(2026, 8, 30, 12, 0);

  it("uses the compact a/p style for English 12-hour locales", () => {
    expect(formatClockTime(afternoon, "en-US")).toBe("2:05p");
    expect(formatClockTime(midnight, "en-US")).toBe("12:07a");
    expect(formatClockTime(noon, "en-US")).toBe("12:00p");
  });

  it("uses 24-hour time for 24-hour locales, English included", () => {
    expect(formatClockTime(afternoon, "en-GB")).toBe("14:05");
    expect(formatClockTime(afternoon, "de-DE")).toBe("14:05");
    expect(formatClockTime(midnight, "en-GB")).toBe("00:07");
  });

  it("leaves non-English 12-hour locales to the locale's own format", () => {
    expect(formatClockTime(afternoon, "ko-KR")).toMatch(/2:05/);
    expect(formatClockTime(afternoon, "ko-KR")).not.toMatch(/p$/);
  });
});

describe("formatMonthDay", () => {
  it("follows the locale's month/day order", () => {
    const date = new Date(2026, 9, 6);
    expect(formatMonthDay(date, "en-US")).toBe("Oct 6");
    expect(formatMonthDay(date, "en-GB")).toBe("6 Oct");
  });
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

describe("formatResetAtShort", () => {
  it("returns null for empty or invalid input", () => {
    expect(formatResetAtShort(null)).toBeNull();
    expect(formatResetAtShort("nope")).toBeNull();
  });

  it("uses a compact 12-hour time with a single-letter meridiem for English locales", () => {
    expect(formatResetAtShort(new Date(2026, 8, 30, 14, 5).toISOString(), "en-US")).toMatch(/ @ 2:05p$/);
    expect(formatResetAtShort(new Date(2026, 8, 30, 0, 7).toISOString(), "en-US")).toMatch(/ @ 12:07a$/);
    expect(formatResetAtShort(new Date(2026, 8, 30, 12, 0).toISOString(), "en-US")).toMatch(/ @ 12:00p$/);
  });

  it("uses the locale's own date and 24-hour time elsewhere", () => {
    expect(formatResetAtShort(new Date(2026, 9, 6, 14, 5).toISOString(), "en-GB")).toBe("6 Oct @ 14:05");
  });
});

describe("formatElapsed", () => {
  it("picks the largest sensible unit", () => {
    expect(formatElapsed(0)).toBe("just now");
    expect(formatElapsed(59_999)).toBe("just now");
    expect(formatElapsed(60_000)).toBe("1m ago");
    expect(formatElapsed(59 * 60_000)).toBe("59m ago");
    expect(formatElapsed(60 * 60_000)).toBe("1h ago");
    expect(formatElapsed(23 * 3_600_000)).toBe("23h ago");
    expect(formatElapsed(47 * 3_600_000)).toBe("1d ago");
    expect(formatElapsed(48 * 3_600_000)).toBe("2d ago");
  });

  it("treats a negative duration as just now", () => {
    expect(formatElapsed(-5_000)).toBe("just now");
  });
});

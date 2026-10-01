import { describe, expect, it } from "vitest";
import { formatClockTime, formatCount, formatMonthDay } from "./format";

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

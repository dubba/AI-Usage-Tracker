import { describe, expect, it } from "vitest";
import type { ActivityDay, OtherLimit } from "../../types";
import {
  barHeightPercent,
  barScale,
  chartSummary,
  dayLabel,
  describeOtherLimits,
  formatDayPercent,
  resetTimeLabel,
} from "./activity-format";

const day = (usedPercent: number | null, quality: ActivityDay["quality"] = "measured"): ActivityDay => ({
  usedPercent,
  quality: usedPercent == null ? "none" : quality,
});

// A Monday, noon in the machine's zone, so the weekday is Monday wherever the test runs.
const monday = new Date(2026, 9, 12, 12);

describe("formatDayPercent", () => {
  it("rounds, and says <1% for anything above zero and below one", () => {
    expect(formatDayPercent(15.4)).toBe("15%");
    expect(formatDayPercent(15.5)).toBe("16%");
    expect(formatDayPercent(0.01)).toBe("<1%");
    expect(formatDayPercent(0.99)).toBe("<1%");
    expect(formatDayPercent(1)).toBe("1%");
    expect(formatDayPercent(99.6)).toBe("100%");
  });

  it("shows zero as 0% and no data as a dash, never as 0%", () => {
    expect(formatDayPercent(0)).toBe("0%");
    expect(formatDayPercent(null)).toBe("—");
  });
});

describe("bar scale", () => {
  it("is the highest day in view, but at least 15", () => {
    expect(barScale([day(3), day(6)])).toBe(15);
    expect(barScale([day(3), day(40.5), day(null)])).toBe(40.5);
    expect(barScale([day(null)])).toBe(15);
    expect(barScale([])).toBe(15);
  });

  it("makes the tallest bar full height and the others proportional", () => {
    expect(barHeightPercent(40, 40)).toBe(100);
    expect(barHeightPercent(20, 40)).toBe(50);
    expect(barHeightPercent(3, 15)).toBeCloseTo(20);
    expect(barHeightPercent(0, 15)).toBe(0);
    expect(barHeightPercent(80, 40)).toBe(100);
  });
});

describe("day labels", () => {
  it("says Today for the last day, a weekday for 7 days and a date for 30", () => {
    expect(dayLabel(monday, "7d", false, "en-US")).toBe("Mon");
    expect(dayLabel(monday, "30d", false, "en-US")).toBe("Oct 12");
    expect(dayLabel(monday, "7d", true, "en-US")).toBe("Today");
    expect(dayLabel(monday, "30d", true, "en-US")).toBe("Today");
  });

  it("names a reset by its weekday and time", () => {
    expect(resetTimeLabel(new Date(2026, 9, 12, 15, 0), "en-US")).toBe("Mon 3:00p");
    expect(resetTimeLabel(new Date(2026, 9, 12, 8, 5), "en-US")).toBe("Mon 8:05a");
  });
});

describe("chartSummary", () => {
  const starts = Array.from({ length: 4 }, (_, index) => new Date(2026, 9, 12 + index, 12));

  it("reads the days in order with their values, estimates and gaps", () => {
    const summary = chartSummary("Work Claude", [day(15.2), day(null), day(7.5, "approximate")], starts, "7d", "en-US");
    expect(summary).toBe("Work Claude, last 3 days: Mon 15%, Tue no data, Today 8% (estimated)");
  });

  it("uses dates on the 30 day chart and the <1% wording", () => {
    const summary = chartSummary("Work Claude", [day(1), day(0.2)], starts.slice(0, 3), "30d", "en-US");
    expect(summary).toBe("Work Claude, last 2 days: Oct 12 1%, Today <1%");
  });

  it("says 0% for a day that was watched and used nothing", () => {
    expect(chartSummary("A", [day(0), day(0)], starts.slice(0, 3), "7d", "en-US")).toBe("A, last 2 days: Mon 0%, Today 0%");
  });
});

describe("describeOtherLimits", () => {
  const cases: Array<[OtherLimit[], string]> = [
    [
      ["daily", "per_minute"],
      "This account only has daily and per-minute limits, so there's no weekly usage to chart. Its current limits are on the Accounts tab.",
    ],
    [
      ["monthly"],
      "This account has a monthly limit only, so there's no weekly usage to chart. Its current limit is on the Accounts tab.",
    ],
    [
      ["five_hour", "monthly"],
      "This account only has 5-hour and monthly limits, so there's no weekly usage to chart. Its current limits are on the Accounts tab.",
    ],
    [
      ["five_hour", "daily", "monthly"],
      "This account only has 5-hour, daily and monthly limits, so there's no weekly usage to chart. Its current limits are on the Accounts tab.",
    ],
    [
      ["daily"],
      "This account has a daily limit only, so there's no weekly usage to chart. Its current limit is on the Accounts tab.",
    ],
    [
      ["five_hour"],
      "This account has a 5-hour limit only, so there's no weekly usage to chart. Its current limit is on the Accounts tab.",
    ],
    [
      ["per_minute", "other"],
      "This account has a per-minute limit only, so there's no weekly usage to chart. Its current limit is on the Accounts tab.",
    ],
    [
      ["other"],
      "This account has no weekly limit, so there's no weekly usage to chart. Its current limits are on the Accounts tab.",
    ],
    [
      [],
      "This account has no weekly limit, so there's no weekly usage to chart. Its current limits are on the Accounts tab.",
    ],
  ];

  it.each(cases)("%j reads as one sentence", (limits, sentence) => {
    expect(describeOtherLimits(limits)).toBe(sentence);
  });
});

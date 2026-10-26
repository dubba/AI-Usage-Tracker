import { describe, expect, it } from "vitest";
import type { ActivityDay, OtherLimit } from "../../types";
import {
  barHeightPercent,
  chartSummary,
  dayLabel,
  describeOtherLimits,
  formatDayPercent,
  resetTimeLabel,
  yAxis,
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

describe("y-axis", () => {
  const axis = (...values: Array<number | null>) => yAxis(values.map((value) => day(value)));

  it("ticks every 5% while the busiest day is 20% or less, and never ends below 15%", () => {
    expect(axis(3, 6)).toEqual({ step: 5, top: 15, ticks: [0, 5, 10, 15] });
    expect(axis(null)).toEqual({ step: 5, top: 15, ticks: [0, 5, 10, 15] });
    expect(yAxis([])).toEqual({ step: 5, top: 15, ticks: [0, 5, 10, 15] });
    expect(axis(15)).toEqual({ step: 5, top: 15, ticks: [0, 5, 10, 15] });
    expect(axis(15.1)).toEqual({ step: 5, top: 20, ticks: [0, 5, 10, 15, 20] });
    expect(axis(17, 2)).toEqual({ step: 5, top: 20, ticks: [0, 5, 10, 15, 20] });
    expect(axis(20)).toEqual({ step: 5, top: 20, ticks: [0, 5, 10, 15, 20] });
  });

  it("ticks every 10% from just above 20% up to 50%", () => {
    expect(axis(20.1)).toEqual({ step: 10, top: 30, ticks: [0, 10, 20, 30] });
    expect(axis(31, 8)).toEqual({ step: 10, top: 40, ticks: [0, 10, 20, 30, 40] });
    expect(axis(40.5, null)).toEqual({ step: 10, top: 50, ticks: [0, 10, 20, 30, 40, 50] });
    expect(axis(50)).toEqual({ step: 10, top: 50, ticks: [0, 10, 20, 30, 40, 50] });
  });

  it("ticks every 20% above 50%, as far as 100% and beyond", () => {
    expect(axis(50.1)).toEqual({ step: 20, top: 60, ticks: [0, 20, 40, 60] });
    expect(axis(61)).toEqual({ step: 20, top: 80, ticks: [0, 20, 40, 60, 80] });
    expect(axis(99.5)).toEqual({ step: 20, top: 100, ticks: [0, 20, 40, 60, 80, 100] });
    expect(axis(100)).toEqual({ step: 20, top: 100, ticks: [0, 20, 40, 60, 80, 100] });
    expect(axis(101)).toEqual({ step: 20, top: 120, ticks: [0, 20, 40, 60, 80, 100, 120] });
  });

  it("always has a tick at 0 and at the top, with room for the busiest day and at most one step to spare", () => {
    for (const highest of [0, 0.4, 4.99, 5, 12, 15, 19.99, 22, 33.3, 49.9, 50, 63, 87.5, 100, 140]) {
      const { top, step, ticks } = axis(highest);
      expect(ticks[0]).toBe(0);
      expect(ticks.at(-1)).toBe(top);
      expect(top).toBeGreaterThanOrEqual(highest);
      // Only the 15% floor may leave more than a step of room above the busiest day.
      if (highest >= 15) expect(top - highest).toBeLessThan(step);
      else expect(top).toBe(15);
      // A tick every `step`, and no more than about six of them for any day a week can hold.
      expect(ticks.every((tick, index) => tick === index * step)).toBe(true);
      if (highest <= 100) expect(ticks.length).toBeLessThanOrEqual(6);
    }
  });

  it("makes a bar as tall as its share of the axis", () => {
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

  it("names a reset by its date and time", () => {
    expect(resetTimeLabel(new Date(2026, 9, 12, 15, 0), "en-US")).toBe("Oct 12 @ 3:00p");
    expect(resetTimeLabel(new Date(2026, 9, 12, 8, 5), "en-US")).toBe("Oct 12 @ 8:05a");
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

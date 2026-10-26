// @vitest-environment happy-dom
/// <reference types="node" />
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mount, type Mounted } from "../../test-utils/react";
import { estimated, measured, noData } from "../../test-utils/activity-fixtures";
import type { ActivityDay } from "../../types";
import { APPROXIMATE_DAY_TOOLTIP, resetTimeLabel, weekdayShort } from "./activity-format";
import { DailyBars } from "./DailyBars";

const originalZone = process.env.TZ;
let mounted: Mounted | null = null;

beforeEach(() => {
  process.env.TZ = "UTC";
});
afterEach(() => {
  mounted?.unmount();
  mounted = null;
  if (originalZone === undefined) delete process.env.TZ;
  else process.env.TZ = originalZone;
});

/** `count + 1` UTC midnights from `first`. */
const startsFrom = (first: Date, count: number) =>
  Array.from({ length: count + 1 }, (_, index) => new Date(first.getTime() + index * 86_400_000));

const week = startsFrom(new Date("2026-10-09T00:00:00Z"), 7);
const month = startsFrom(new Date("2026-09-16T00:00:00Z"), 30);

function render(props: Partial<Parameters<typeof DailyBars>[0]> & { days: ActivityDay[] }) {
  const period = props.period ?? (props.days.length === 7 ? "7d" : "30d");
  mounted = mount(
    <DailyBars name="Work Claude" dayStarts={period === "7d" ? week : month} resets={[]} period={period} {...props} />,
  );
  return mounted.container;
}

const all = (root: ParentNode, selector: string) => [...root.querySelectorAll<HTMLElement>(selector)];
const texts = (root: ParentNode, selector: string) => all(root, selector).map((element) => element.textContent);

describe("DailyBars, 7 days", () => {
  const days = [measured(15.4), noData, measured(0.4), measured(0), estimated(7.6), measured(99.5), measured(3)];

  it("shows the weekday below each bar, with Today last, and no percent above the bars", () => {
    const root = render({ days });
    expect(all(root, ".activity-day-value")).toHaveLength(0);
    expect(texts(root, ".activity-bars")[0]).not.toContain("%");
    expect(texts(root, ".activity-day-label")).toEqual([
      ...week.slice(0, 6).map((start) => weekdayShort(start)),
      "Today",
    ]);
    expect(all(root, ".activity-day-label")[6].classList.contains("is-today")).toBe(true);
  });

  it("scales the bars to the top of the axis, which is the first tick above the highest day", () => {
    const bars = all(render({ days }), ".activity-bar");
    // The highest day is 99.5%, so the axis runs to 100%.
    expect(parseFloat(bars[0].style.height)).toBeCloseTo(15.4, 5);
    expect(parseFloat(bars[5].style.height)).toBeCloseTo(99.5, 5);
    expect(parseFloat(bars[3].style.height)).toBe(0);
  });

  it("scales to at least 15%, so small days do not look big", () => {
    const bars = all(render({ days: [measured(3), measured(6), measured(15), noData, noData, noData, noData] }), ".activity-bar");
    expect(parseFloat(bars[0].style.height)).toBeCloseTo(20);
    expect(parseFloat(bars[1].style.height)).toBeCloseTo(40);
    expect(parseFloat(bars[2].style.height)).toBe(100);
  });

  it("draws no data as a striped placeholder, not as an empty bar", () => {
    const bar = all(render({ days }), ".activity-bar")[1];
    expect(bar.classList.contains("is-empty")).toBe(true);
    expect(bar.style.height).toBe("");
    expect(bar.dataset.tooltip).toBe("Oct 10: no data");
  });

  it("tells the date and the value in each bar's tooltip, since the bars carry no percent", () => {
    const bars = all(render({ days }), ".activity-bar");
    expect(bars.map((bar) => bar.dataset.tooltip?.split("\n")[0])).toEqual([
      "Oct 9: 15%", "Oct 10: no data", "Oct 11: <1%", "Oct 12: 0%", "Oct 13: 8%", "Oct 14: 100%", "Today: 3%",
    ]);
  });

  it("marks estimated days and explains them on a second line", () => {
    const bars = all(render({ days }), ".activity-bar");
    expect(bars[4].classList.contains("is-approximate")).toBe(true);
    expect(bars[4].dataset.tooltip).toBe(`Oct 13: 8%\n${APPROXIMATE_DAY_TOOLTIP}`);
    expect(APPROXIMATE_DAY_TOOLTIP).toBe("Estimated: the app wasn't refreshing for part of this day");
    expect(bars[0].classList.contains("is-approximate")).toBe(false);
    expect(bars[0].dataset.tooltip).not.toContain("Estimated");
  });

  it("shows a measured zero as a thin bar, not as missing", () => {
    const bar = all(render({ days }), ".activity-bar")[3];
    expect(bar.classList.contains("is-zero")).toBe(true);
    expect(bar.classList.contains("is-empty")).toBe(false);
  });

  it("anchors tooltips to the near edge at either end of the chart", () => {
    const bars = all(render({ days: [estimated(1), estimated(1), estimated(1), estimated(1), estimated(1), estimated(1), estimated(1)] }), ".activity-bar");
    expect(bars.map((bar) => (bar.classList.contains("is-left") ? "left" : bar.classList.contains("is-right") ? "right" : "mid"))).toEqual([
      "left", "left", "mid", "mid", "mid", "right", "right",
    ]);
  });

  it("describes the chart in a sentence and in a table for screen readers", () => {
    const root = render({ days });
    const picture = root.querySelector('[role="img"]')!;
    const label = picture.getAttribute("aria-label")!;
    expect(label.startsWith("Work Claude, last 7 days: ")).toBe(true);
    expect(label).toContain(`${weekdayShort(week[0])} 15%`);
    expect(label).toContain(`${weekdayShort(week[1])} no data`);
    expect(label).toContain(`${weekdayShort(week[2])} <1%`);
    expect(label).toContain(`${weekdayShort(week[4])} 8% (estimated)`);
    expect(label.endsWith("Today 3%")).toBe(true);

    const rows = all(root, "table tbody tr");
    expect(rows).toHaveLength(7);
    expect(rows.map((row) => row.querySelector("td")!.textContent)).toEqual([
      "15%", "No data", "<1%", "0%", "8% (estimated)", "100%", "3%",
    ]);
    expect(rows[6].querySelector("th")!.textContent).toBe("Today");
    expect(root.querySelector("table")!.classList.contains("sr-only")).toBe(true);
    // The table sits in a non-table box. On the table itself, .sr-only does not cap the height.
    expect(root.querySelector("table")!.parentElement!.tagName).toBe("DIV");
    expect(root.querySelector("table")!.parentElement!.classList.contains("sr-only")).toBe(true);
    expect(root.querySelector("caption")!.textContent).toBe(label);
  });

  it("draws reset markers inside the 7 days without showing the 30d axis", () => {
    const root = render({ days, resets: ["2026-10-12T15:00:00Z"] });
    expect(all(root, ".activity-reset")).toHaveLength(1);
    expect(all(root, ".activity-axis")).toHaveLength(0);
  });

  it("keeps one reset dash, and paints it black only across a solid bar", () => {
    const root = render({
      days,
      resets: ["2026-10-09T12:00:00Z", "2026-10-10T06:00:00Z", "2026-10-12T00:00:00Z", "2026-10-13T18:00:00Z"],
    });
    const lines = all(root, ".activity-reset-line");
    const clips = all(root, ".activity-reset-clip");
    const bars = all(root, ".activity-bar");
    const fraction = (element: HTMLElement) => Number(element.style.getPropertyValue("--reset-fraction"));
    // Noon on a measured day, morning on a missing day, midnight on a zero day, evening on an estimate.
    expect(lines).toHaveLength(4);
    expect(lines.map(fraction)).toEqual([0.5, 0.25, 0, 0.75]);
    expect(all(root, ".activity-reset")).toHaveLength(4);
    // Black ink only on the solid bars (measured and estimated), sharing that line's place in the column.
    expect(clips).toHaveLength(2);
    expect(fraction(clips[0])).toBe(fraction(lines[0]));
    expect(fraction(clips[1])).toBe(fraction(lines[3]));
    expect(clips[0].style.height).toBe(bars[0].style.height);
    expect(clips[1].style.height).toBe(bars[4].style.height);
    expect(clips[0].querySelector(".activity-reset-ink")).not.toBeNull();
    expect(bars[0].parentElement!.querySelector(".activity-reset-clip")).toBe(clips[0]);
    expect(bars[1].parentElement!.querySelector(".activity-reset-clip")).toBeNull();
    expect(bars[3].parentElement!.querySelector(".activity-reset-clip")).toBeNull();
    expect(bars[4].parentElement!.querySelector(".activity-reset-clip")).toBe(clips[1]);
  });
});

describe("DailyBars y-axis", () => {
  const sevenDays = (...values: Array<number | null>): ActivityDay[] =>
    [...values, ...Array(7 - values.length).fill(null)].map((value) => (value == null ? noData : measured(value)));

  const labels = (root: ParentNode) => texts(root, ".activity-tick-label");
  const heightOf = (element: HTMLElement) => parseFloat(element.style.height);
  const bottomOf = (element: HTMLElement) => parseFloat(element.style.bottom);

  it("ticks every 5% for a quiet week, from 0 up to at least 15%", () => {
    expect(labels(render({ days: sevenDays(3, 6) }))).toEqual(["0%", "5%", "10%", "15%"]);
    mounted!.unmount();
    expect(labels(render({ days: sevenDays(17, 2) }))).toEqual(["0%", "5%", "10%", "15%", "20%"]);
  });

  it("ticks every 10% for a busier week", () => {
    expect(labels(render({ days: sevenDays(31, 8) }))).toEqual(["0%", "10%", "20%", "30%", "40%"]);
  });

  it("ticks every 20% for the busiest weeks", () => {
    expect(labels(render({ days: sevenDays(64, 8) }))).toEqual(["0%", "20%", "40%", "60%", "80%"]);
    mounted!.unmount();
    expect(labels(render({ days: sevenDays(99.5) }))).toEqual(["0%", "20%", "40%", "60%", "80%", "100%"]);
  });

  it("is on the 30 day chart too, and follows the 30 days' busiest day", () => {
    const days = Array.from({ length: 30 }, (_, index) => measured(index === 12 ? 33 : 2));
    const root = render({ days });
    expect(labels(root)).toEqual(["0%", "10%", "20%", "30%", "40%"]);
    expect(all(root, ".activity-gridline")).toHaveLength(5);
  });

  it("draws a gridline at each tick, behind the bars, with a stronger one at 0", () => {
    const root = render({ days: sevenDays(31, 8) });
    const lines = all(root, ".activity-gridline");
    expect(lines.map(bottomOf)).toEqual([0, 25, 50, 75, 100]);
    expect(lines.filter((line) => line.classList.contains("is-baseline"))).toEqual([lines[0]]);
    // The lines are inside the bars' area, before the first day, so they are painted behind it.
    const area = root.querySelector(".activity-bars")!;
    expect(area.firstElementChild!.classList.contains("activity-gridlines")).toBe(true);
    expect(area.querySelector(".activity-gridlines")!.getAttribute("aria-hidden")).toBe("true");
  });

  it("puts each tick label at the height of its gridline", () => {
    const root = render({ days: sevenDays(31, 8) });
    expect(all(root, ".activity-tick-label").map(bottomOf)).toEqual(all(root, ".activity-gridline").map(bottomOf));
    expect(root.querySelector(".activity-yaxis")!.getAttribute("aria-hidden")).toBe("true");
  });

  it("makes a bar as tall as the tick it reaches", () => {
    // A 20% day on an axis that ends at 40% is half the height of the room.
    const root = render({ days: sevenDays(40, 20) });
    const bars = all(root, ".activity-bar");
    expect(heightOf(bars[0])).toBe(100);
    expect(heightOf(bars[1])).toBe(50);
    const ticks = all(root, ".activity-tick-label");
    const tickAt = (percent: number) => ticks.find((tick) => tick.textContent === `${percent}%`)!;
    expect(bottomOf(tickAt(20))).toBe(heightOf(bars[1]));
    expect(bottomOf(tickAt(40))).toBe(heightOf(bars[0]));
  });

  it("is not read out: the summary and the table already have the numbers", () => {
    const root = render({ days: sevenDays(31, 8) });
    expect(root.querySelector('[role="img"]')!.getAttribute("aria-label")).not.toContain("40%");
    expect(root.querySelector("table")!.textContent).not.toContain("40%");
  });
});

describe("DailyBars, 30 days", () => {
  const days = Array.from({ length: 30 }, (_, index): ActivityDay => (index % 7 === 0 ? noData : index % 5 === 0 ? estimated(index) : measured(index)));

  it("has no labels on the bars, and dates under the chart: the first day, thirds of the way along, and Today", () => {
    const root = render({ days });
    expect(all(root, ".activity-bar")).toHaveLength(30);
    expect(all(root, ".activity-day-value")).toHaveLength(0);
    expect(all(root, ".activity-day-label")).toHaveLength(0);
    // Days 10 and 20 of 30 (0-based), so the month is split into thirds.
    expect(texts(root, ".activity-axis span")).toEqual(["Sep 16", "Sep 26", "Oct 6", "Today"]);
  });

  it("centers the middle dates under their bars", () => {
    const [first, second] = all(render({ days }), ".activity-axis .is-middle");
    const centerOf = (element: HTMLElement) => {
      const [, percent, offset] = /calc\(([\d.]+)% \+ (-?[\d.]+)px\)/.exec(element.style.left)!;
      return { percent: Number(percent), offset: Number(offset) };
    };
    // Column 10 and column 20 of 30, each at its middle.
    expect(centerOf(first).percent).toBeCloseTo((10.5 / 30) * 100, 5);
    expect(centerOf(second).percent).toBeCloseTo((20.5 / 30) * 100, 5);
    // The gaps between columns shift a column's middle by less than one gap.
    expect(Math.abs(centerOf(first).offset)).toBeLessThan(3);
  });

  it("tells the date and the value in each bar's tooltip", () => {
    const bars = all(render({ days }), ".activity-bar");
    expect(bars[1].dataset.tooltip).toBe("Sep 17: 1%");
    expect(bars[0].dataset.tooltip).toBe("Sep 16: no data");
    expect(bars[5].dataset.tooltip).toBe(`Sep 21: 5%\n${APPROXIMATE_DAY_TOOLTIP}`);
    expect(bars[29].dataset.tooltip).toBe("Today: 29%");
  });

  it("marks each weekly reset in its day's column at the right fraction of the day", () => {
    const resets = ["2026-09-26T12:00:00Z", "2026-10-08T06:00:00Z"];
    const root = render({ days, resets });
    const markers = all(root, ".activity-reset");
    expect(markers).toHaveLength(2);
    const position = (marker: HTMLElement) => {
      const [, percent, offset] = /calc\(([\d.]+)% \+ (-?[\d.]+)px\)/.exec(marker.style.left)!;
      return { percent: Number(percent), offset: Number(offset) };
    };
    // Day 10 (Sep 26) at noon: half a day in, so 10.5 of 30 columns.
    expect(position(markers[0]).percent).toBeCloseTo((10.5 / 30) * 100, 5);
    // Day 22 (Oct 8) at 06:00: a quarter of a day in.
    expect(position(markers[1]).percent).toBeCloseTo((22.25 / 30) * 100, 5);
    // The gaps between the columns shift the line by a fraction of a gap: never more than 3px.
    expect(Math.abs(position(markers[0]).offset)).toBeLessThanOrEqual(3);
    const tips = markers.map((marker) => marker.querySelector<HTMLElement>("[data-tooltip]")!.dataset.tooltip);
    expect(tips).toEqual([
      `Weekly reset · ${resetTimeLabel(new Date("2026-09-26T12:00:00Z"))}`,
      `Weekly reset · ${resetTimeLabel(new Date("2026-10-08T06:00:00Z"))}`,
    ]);
    expect(tips[0]!.startsWith("Weekly reset · ")).toBe(true);
  });

  it("leaves out resets outside the range and ones that are not times", () => {
    const root = render({ days, resets: ["2026-09-01T00:00:00Z", "2026-10-30T00:00:00Z", "2026-10-16T00:00:00Z", "soon", "2026-09-30T00:00:00Z"] });
    // Only Sep 30 is inside the 30 days that end Oct 16 00:00 (the end itself is tomorrow, not today).
    expect(all(root, ".activity-reset")).toHaveLength(1);
  });

  it("marks weekly resets on the 7 day chart as well", () => {
    const root = render({ days: days.slice(23), resets: ["2026-10-14T12:00:00Z"], period: "7d" });
    expect(all(root, ".activity-reset")).toHaveLength(1);
    expect(root.querySelector<HTMLElement>(".activity-reset [data-tooltip]")!.dataset.tooltip).toContain("Weekly reset · ");
  });

  it("describes the days in the summary as dates", () => {
    const label = render({ days }).querySelector('[role="img"]')!.getAttribute("aria-label")!;
    expect(label.startsWith("Work Claude, last 30 days: Sep 16 no data, Sep 17 1%")).toBe(true);
    expect(label.endsWith("Today 29%")).toBe(true);
  });
});

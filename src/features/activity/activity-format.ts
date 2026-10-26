import type { ActivityDay, OtherLimit } from "../../types";
import { formatClockTime, formatMonthDay } from "../../shared/lib/format";
import type { ActivityPeriod } from "./activity-period";

/** The axis goes up to at least this many percent, even when every day in view is lower. */
export const MIN_AXIS_TOP_PERCENT = 15;

/** The y-axis of one chart: ticks every `step` percent from 0 up to `top`, the height of a full bar. */
export interface YAxis {
  step: number;
  top: number;
  /** 0, `step`, 2 * `step`, ... `top`. */
  ticks: number[];
}

/** What a day's bar shows above it and in summaries: "—" for no data, "<1%" below one percent. */
export function formatDayPercent(value: number | null): string {
  if (value == null) return "—";
  if (value > 0 && value < 1) return "<1%";
  return `${Math.round(value)}%`;
}

/**
 * The y-axis that fits the busiest day in view: a tick every 5% while the highest day is 20% or
 * less, every 10% up to 50%, and every 20% above that. It ends at the first tick at or above the
 * highest day, and never below 15%, so a quiet week does not look like a busy one.
 */
export function yAxis(days: readonly ActivityDay[]): YAxis {
  const highest = Math.max(0, ...days.map((day) => day.usedPercent ?? 0));
  const step = highest <= 20 ? 5 : highest <= 50 ? 10 : 20;
  const top = Math.max(MIN_AXIS_TOP_PERCENT, Math.ceil(highest / step) * step);
  return { step, top, ticks: Array.from({ length: top / step + 1 }, (_, index) => index * step) };
}

/** How tall a bar is, as a percent of the room it has (the room is the axis from 0 to `top`). */
export function barHeightPercent(value: number, top: number): number {
  return Math.min(100, Math.max(0, (value / top) * 100));
}

export function weekdayShort(date: Date, locale?: string): string {
  return date.toLocaleDateString(locale, { weekday: "short" });
}

/** "Mon" for 7 days and "Oct 12" for 30, or "Today" for the last day. */
export function dayLabel(date: Date, period: ActivityPeriod, isToday: boolean, locale?: string): string {
  if (isToday) return "Today";
  return period === "7d" ? weekdayShort(date, locale) : formatMonthDay(date, locale);
}

/** "Oct 12 @ 3:00p": the date and time of a reset. */
export function resetTimeLabel(date: Date, locale?: string): string {
  return `${formatMonthDay(date, locale)} @ ${formatClockTime(date, locale)}`;
}

export const APPROXIMATE_DAY_TOOLTIP = "Estimated: the app wasn't refreshing for part of this day";

/**
 * "Work Claude, last 7 days: Mon 15%, Tue 7%, …": the chart in words, for screen readers. Estimated
 * days say so; days with nothing observed read "no data".
 */
export function chartSummary(
  name: string,
  days: readonly ActivityDay[],
  starts: readonly Date[],
  period: ActivityPeriod,
  locale?: string,
): string {
  const parts = days.map((day, index) => {
    const label = dayLabel(starts[index], period, index === days.length - 1, locale);
    if (day.usedPercent == null) return `${label} no data`;
    const estimate = day.quality === "approximate" ? " (estimated)" : "";
    return `${label} ${formatDayPercent(day.usedPercent)}${estimate}`;
  });
  return `${name}, last ${days.length} days: ${parts.join(", ")}`;
}

const LIMIT_NAMES: Record<Exclude<OtherLimit, "other">, string> = {
  five_hour: "5-hour",
  daily: "daily",
  per_minute: "per-minute",
  monthly: "monthly",
};

function joinWords(words: readonly string[]): string {
  if (words.length <= 1) return words[0] ?? "";
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

/**
 * Why an account has no weekly chart, from the limits it does have:
 * "This account only has daily and per-minute limits, so there's no weekly usage to chart. Its
 * current limits are on the Accounts tab."
 */
export function describeOtherLimits(limits: readonly OtherLimit[]): string {
  const names = limits
    .filter((limit): limit is Exclude<OtherLimit, "other"> => limit !== "other")
    .map((limit) => LIMIT_NAMES[limit]);
  if (names.length === 0) {
    return "This account has no weekly limit, so there's no weekly usage to chart. Its current limits are on the Accounts tab.";
  }
  if (names.length === 1) {
    return `This account has a ${names[0]} limit only, so there's no weekly usage to chart. Its current limit is on the Accounts tab.`;
  }
  return `This account only has ${joinWords(names)} limits, so there's no weekly usage to chart. Its current limits are on the Accounts tab.`;
}

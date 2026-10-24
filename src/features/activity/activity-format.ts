import type { ActivityDay, OtherLimit } from "../../types";
import { formatClockTime, formatMonthDay } from "../../shared/lib/format";
import type { ActivityPeriod } from "./activity-period";

/** The tallest a bar can be is this many percent, even when every day in view is lower. */
export const MIN_BAR_SCALE_PERCENT = 15;

/** What a day's bar shows above it and in summaries: "—" for no data, "<1%" below one percent. */
export function formatDayPercent(value: number | null): string {
  if (value == null) return "—";
  if (value > 0 && value < 1) return "<1%";
  return `${Math.round(value)}%`;
}

/** The value a bar of `value` percent is scaled against: the highest day in view, but at least 15. */
export function barScale(days: readonly ActivityDay[]): number {
  return Math.max(MIN_BAR_SCALE_PERCENT, ...days.map((day) => day.usedPercent ?? 0));
}

/** How tall a bar is, as a percent of the room it has. */
export function barHeightPercent(value: number, scale: number): number {
  return Math.min(100, Math.max(0, (value / scale) * 100));
}

export function weekdayShort(date: Date, locale?: string): string {
  return date.toLocaleDateString(locale, { weekday: "short" });
}

/** "Mon" for 7 days and "Oct 12" for 30, or "Today" for the last day. */
export function dayLabel(date: Date, period: ActivityPeriod, isToday: boolean, locale?: string): string {
  if (isToday) return "Today";
  return period === "7d" ? weekdayShort(date, locale) : formatMonthDay(date, locale);
}

/** "Mon 3:00p": the time of a weekly reset, with its weekday. */
export function resetTimeLabel(date: Date, locale?: string): string {
  return `${weekdayShort(date, locale)} ${formatClockTime(date, locale)}`;
}

export const APPROXIMATE_DAY_TOOLTIP = "Estimated: the app wasn't refreshing for part of this day";
export const NO_DATA_DAY_TOOLTIP = "No data: the app wasn't refreshing this day";

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

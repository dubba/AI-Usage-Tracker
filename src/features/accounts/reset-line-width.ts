import { formatClockTime, formatMonthDay, formatRemainingDuration } from "../../shared/lib/format";

/**
 * The widest a usage row's reset line can be ("Resets in 23h 59m · Wed, Nov 25 @ 12:59p"), so the
 * account cards can be given room for it on one line whatever the countdown and date are. The line
 * is built from the same formatters as `AccountUsageMetric`, so the weekday and month follow the
 * system language, and measured in the line's own font. Only the shape changes from line to line:
 * the countdown ("16m", "23h 59m", "6d 23h"), the day ("Today" or "Wed, Nov 25") and the time
 * ("8:00p", "12:59p").
 */

/** Monthly limits count down from about 31 days. */
const LONGEST_COUNTDOWN_DAYS = 31;
/** How many of the widest pieces (by a quick canvas measure) are tried together in the real font. */
const FINALISTS = 3;

let cached: { key: string; width: number } | null = null;
let context: CanvasRenderingContext2D | null | undefined;

function canvasContext(): CanvasRenderingContext2D | null {
  if (context === undefined) {
    try {
      context = document.createElement("canvas").getContext("2d");
    } catch {
      context = null;
    }
  }
  return context;
}

function fontOf(element: Element): string {
  const styles = getComputedStyle(element);
  return `${styles.fontStyle} ${styles.fontWeight} ${styles.fontSize} ${styles.fontFamily}`;
}

/** The few widest strings, by a canvas measure; all of them when there is no canvas. */
function widest(samples: Iterable<string>, font: string): string[] {
  const unique = [...new Set(samples)];
  const ctx = canvasContext();
  if (!ctx) return unique;
  ctx.font = font;
  return unique
    .map((text) => ({ text, width: ctx.measureText(text).width }))
    .sort((a, b) => b.width - a.width)
    .slice(0, FINALISTS)
    .map((sample) => sample.text);
}

function countdownSamples(): string[] {
  const samples: string[] = [];
  for (let minutes = 1; minutes < 24 * 60; minutes += 1) {
    samples.push(formatRemainingDuration(minutes * 60_000) ?? "");
  }
  for (let hours = 24; hours <= LONGEST_COUNTDOWN_DAYS * 24; hours += 1) {
    samples.push(formatRemainingDuration(hours * 3_600_000) ?? "");
  }
  return samples.filter(Boolean);
}

function weekdaySamples(): string[] {
  // 2024-01-01 was a Monday; seven days in a row give every weekday.
  return Array.from({ length: 7 }, (_, day) => new Date(2024, 0, 1 + day).toLocaleString(undefined, { weekday: "short" }));
}

function monthDaySamples(): string[] {
  // A leap year, so Feb 29 is in.
  return Array.from({ length: 366 }, (_, day) => formatMonthDay(new Date(2024, 0, 1 + day)));
}

function clockSamples(): string[] {
  return Array.from({ length: 24 * 60 }, (_, minute) => formatClockTime(new Date(2024, 0, 1, 0, minute)));
}

/** A hidden copy of a reset line, inside a real one's row so it gets the same styles. */
function buildProbe(foot: HTMLElement) {
  const probe = document.createElement("span");
  probe.className = "metric-reset";
  probe.setAttribute("aria-hidden", "true");
  probe.style.cssText = "position:absolute;left:0;top:0;visibility:hidden;white-space:nowrap;pointer-events:none";
  const countdown = document.createElement("strong");
  const date = document.createElement("span");
  date.className = "desktop-metric-date";
  probe.append("Resets in ", countdown, " · ", date);
  foot.append(probe);
  return { probe, countdown, date };
}

/**
 * The widest reset line's width in pixels, measured once and then remembered for the same fonts and
 * language. `foot` is any `.desktop-metric-foot` on screen; it lends its styles to the measurement.
 */
export function worstResetLineWidth(foot: HTMLElement): number {
  // Checked before the probe goes in: adding it changes the cards, which asks for a new measure, so
  // a remembered width must not touch the page or the measuring would never stop.
  const key = `${fontOf(foot)}|${Intl.DateTimeFormat().resolvedOptions().locale}`;
  if (cached?.key === key) return cached.width;
  const { probe, countdown, date } = buildProbe(foot);
  try {
    const regular = fontOf(probe);
    const bold = fontOf(countdown);

    const countdowns = widest(countdownSamples(), bold);
    const weekdays = widest(weekdaySamples(), regular);
    const monthDays = widest(monthDaySamples(), regular);
    const times = widest(clockSamples(), regular);
    const days = ["Today", ...weekdays.flatMap((weekday) => monthDays.map((monthDay) => `${weekday}, ${monthDay}`))];

    let width = 0;
    for (const text of countdowns) {
      countdown.textContent = text;
      for (const day of days) {
        for (const time of times) {
          date.textContent = `${day} @ ${time}`;
          width = Math.max(width, probe.getBoundingClientRect().width);
        }
      }
    }
    cached = { key, width };
    return width;
  } finally {
    probe.remove();
  }
}

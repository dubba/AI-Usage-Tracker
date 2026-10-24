import type { CSSProperties } from "react";
import { formatMonthDay } from "../../shared/lib/format";
import type { ActivityDay } from "../../types";
import {
  APPROXIMATE_DAY_TOOLTIP,
  NO_DATA_DAY_TOOLTIP,
  barHeightPercent,
  barScale,
  chartSummary,
  dayLabel,
  formatDayPercent,
  resetTimeLabel,
} from "./activity-format";
import type { ActivityPeriod } from "./activity-period";

/** Space between bars in px; the reset markers on the 30 day chart are placed with the same number. */
const GAP_PX: Record<ActivityPeriod, number> = { "7d": 8, "30d": 3 };

/** Which side a bar's tooltip hangs from, so it stays inside the card at either end of the chart. */
function tooltipSide(position: number): "is-left" | "is-right" | "" {
  if (position < 1 / 3) return "is-left";
  if (position > 2 / 3) return "is-right";
  return "";
}

function dayTooltip(day: ActivityDay, date: Date, period: ActivityPeriod, isToday: boolean): string | undefined {
  // The 30 day chart has no labels on its bars, so the tooltip says which day and how much.
  const when = isToday ? "Today" : formatMonthDay(date);
  if (day.quality === "none") return period === "30d" ? `${when}: no data` : NO_DATA_DAY_TOOLTIP;
  if (day.quality === "approximate") {
    return period === "30d"
      ? `${when}: ${formatDayPercent(day.usedPercent)}\n${APPROXIMATE_DAY_TOOLTIP}`
      : APPROXIMATE_DAY_TOOLTIP;
  }
  return period === "30d" ? `${when}: ${formatDayPercent(day.usedPercent)}` : undefined;
}

interface ResetMarker {
  instant: string;
  date: Date;
  /** Where the marker sits across the chart, 0 to 1. */
  position: number;
  left: string;
}

/** Where each weekly reset falls on the chart: in its day's column, at the right fraction of the day. */
function resetMarkers(resets: readonly string[], starts: readonly Date[], gap: number): ResetMarker[] {
  const dayCount = starts.length - 1;
  return resets.flatMap((instant) => {
    const date = new Date(instant);
    const time = date.getTime();
    if (Number.isNaN(time)) return [];
    const day = starts.findIndex((start, index) => index < dayCount && time >= start.getTime() && time < starts[index + 1].getTime());
    if (day < 0) return [];
    const dayLength = starts[day + 1].getTime() - starts[day].getTime();
    const fraction = (time - starts[day].getTime()) / dayLength;
    const position = (day + fraction) / dayCount;
    // The columns are separated by gaps, so a fraction of the whole width is off by up to one gap.
    return [{ instant, date, position, left: `calc(${position * 100}% + ${gap * (position - fraction)}px)` }];
  });
}

/**
 * One bar per day for one weekly limit. The bars are scaled to the highest day in view (at least
 * 15%), so a quiet week does not look like a busy one. Days with nothing observed are striped, days
 * partly estimated have a dotted top edge, and the 30 day chart marks each weekly reset.
 *
 * Screen readers get the chart as a sentence on the picture and as a table beside it.
 */
export function DailyBars({
  name,
  days,
  dayStarts,
  resets,
  period,
}: {
  /** Names the chart in the summary: the account, and the limit when the account has several. */
  name: string;
  days: readonly ActivityDay[];
  /** `days.length + 1` local midnights: the start of each day and the end of the last. */
  dayStarts: readonly Date[];
  /** Weekly resets inside the range, as RFC 3339 instants. */
  resets: readonly string[];
  period: ActivityPeriod;
}) {
  const scale = barScale(days);
  const gap = GAP_PX[period];
  const labelled = period === "7d";
  const summary = chartSummary(name, days, dayStarts, period);
  const markers = labelled ? [] : resetMarkers(resets, dayStarts, gap);
  const style = { "--activity-days": days.length, "--activity-gap": `${gap}px` } as CSSProperties;

  return (
    <div className={`activity-chart is-${period}`} style={style}>
      <div className="activity-bars" role="img" aria-label={summary}>
        {days.map((day, index) => {
          const isToday = index === days.length - 1;
          const empty = day.usedPercent == null;
          const barClass = [
            "activity-bar",
            empty ? "is-empty" : day.quality === "approximate" ? "is-approximate" : "",
            !empty && day.usedPercent === 0 ? "is-zero" : "",
            tooltipSide((index + 0.5) / days.length),
          ]
            .filter(Boolean)
            .join(" ");
          return (
            <div className="activity-day" key={dayStarts[index].getTime()}>
              {labelled ? <span className="activity-day-value">{formatDayPercent(day.usedPercent)}</span> : null}
              <div className="activity-bar-slot">
                <div
                  className={barClass}
                  style={empty ? undefined : { height: `${barHeightPercent(day.usedPercent ?? 0, scale)}%` }}
                  data-tooltip={dayTooltip(day, dayStarts[index], period, isToday)}
                />
              </div>
              {labelled ? (
                <span className={`activity-day-label${isToday ? " is-today" : ""}`}>
                  {dayLabel(dayStarts[index], period, isToday)}
                </span>
              ) : null}
            </div>
          );
        })}
        {markers.map((marker) => (
          <span className="activity-reset" style={{ left: marker.left }} key={marker.instant}>
            <span
              className={["activity-reset-hit", tooltipSide(marker.position)].filter(Boolean).join(" ")}
              data-tooltip={`Weekly reset · ${resetTimeLabel(marker.date)}`}
            />
          </span>
        ))}
      </div>
      {labelled ? null : (
        <div className="activity-axis" aria-hidden="true">
          <span>{formatMonthDay(dayStarts[0])}</span>
          <span>Today</span>
        </div>
      )}
      <table className="sr-only">
        <caption>{summary}</caption>
        <thead>
          <tr>
            <th scope="col">Day</th>
            <th scope="col">Weekly limit used</th>
          </tr>
        </thead>
        <tbody>
          {days.map((day, index) => (
            <tr key={dayStarts[index].getTime()}>
              <th scope="row">{dayLabel(dayStarts[index], period, index === days.length - 1)}</th>
              <td>
                {day.usedPercent == null
                  ? "No data"
                  : `${formatDayPercent(day.usedPercent)}${day.quality === "approximate" ? " (estimated)" : ""}`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

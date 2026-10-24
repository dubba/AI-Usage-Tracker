import type { CSSProperties } from "react";
import { formatMonthDay } from "../../shared/lib/format";
import type { ActivityDay } from "../../types";
import {
  APPROXIMATE_DAY_TOOLTIP,
  barHeightPercent,
  chartSummary,
  dayLabel,
  formatDayPercent,
  resetTimeLabel,
  yAxis,
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

/** Which day and how much, for the bar's tooltip: the bars carry no percent of their own. */
function dayTooltip(day: ActivityDay, date: Date, isToday: boolean): string {
  const when = isToday ? "Today" : formatMonthDay(date);
  if (day.quality === "none") return `${when}: no data`;
  const value = `${when}: ${formatDayPercent(day.usedPercent)}`;
  return day.quality === "approximate" ? `${value}\n${APPROXIMATE_DAY_TOOLTIP}` : value;
}

/** The days that split a chart of `count` days into thirds: a third and two thirds of the way along. */
function thirdsOf(count: number): number[] {
  return [Math.round(count / 3), Math.round((2 * count) / 3)];
}

/** Where the middle of day `index`'s column is, across the bars' area (the columns have gaps between). */
function columnCenter(index: number, count: number, gap: number): string {
  const position = (index + 0.5) / count;
  return `calc(${position * 100}% + ${gap * (position - 0.5)}px)`;
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
 * One bar per day for one weekly limit, on a y-axis that fits the busiest day in view: ticks every
 * 5, 10 or 20 percent (see `yAxis`), so a quiet week does not look like a busy one. Days with
 * nothing observed are striped, days partly estimated have a dotted top edge, and the 30 day chart
 * marks each weekly reset.
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
  const axis = yAxis(days);
  const gap = GAP_PX[period];
  const labelled = period === "7d";
  const summary = chartSummary(name, days, dayStarts, period);
  const markers = labelled ? [] : resetMarkers(resets, dayStarts, gap);
  const style = { "--activity-days": days.length, "--activity-gap": `${gap}px` } as CSSProperties;

  return (
    <div className={`activity-chart is-${period}`} style={style}>
      <div className="activity-yaxis" aria-hidden="true">
        <div className="activity-scale">
          {axis.ticks.map((tick) => (
            <span className="activity-tick-label" style={{ bottom: `${(tick / axis.top) * 100}%` }} key={tick}>
              {tick}%
            </span>
          ))}
        </div>
      </div>
      <div className="activity-bars" role="img" aria-label={summary}>
        <div className="activity-gridlines" aria-hidden="true">
          {axis.ticks.map((tick) => (
            <span
              className={`activity-gridline${tick === 0 ? " is-baseline" : ""}`}
              style={{ bottom: `${(tick / axis.top) * 100}%` }}
              key={tick}
            />
          ))}
        </div>
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
              <div className="activity-bar-slot">
                <div
                  className={barClass}
                  style={empty ? undefined : { height: `${barHeightPercent(day.usedPercent ?? 0, axis.top)}%` }}
                  data-tooltip={dayTooltip(day, dayStarts[index], isToday)}
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
          <span className="is-first">{formatMonthDay(dayStarts[0])}</span>
          {thirdsOf(days.length).map((index) => (
            <span className="is-middle" style={{ left: columnCenter(index, days.length, gap) }} key={index}>
              {formatMonthDay(dayStarts[index])}
            </span>
          ))}
          <span className="is-last">Today</span>
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

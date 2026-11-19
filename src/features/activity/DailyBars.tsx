import { Fragment, useState, type CSSProperties, type ReactElement } from "react";
import { ChevronIcon } from "../../shared/ui/icons";
import { formatMonthDay } from "../../shared/lib/format";
import type { ActivityDay } from "../../types";
import {
  APPROXIMATE_DAY_TOOLTIP,
  barHeightPercent,
  chartStats,
  chartSummary,
  dayLabel,
  formatDayPercent,
  resetTimeLabel,
  yAxis,
} from "./activity-format";
import type { ActivityPeriod } from "./activity-period";

/** Space between bars in px; the reset markers on the 30 and 90 day charts are placed with the same number. */
const GAP_PX: Record<ActivityPeriod, number> = { "7d": 8, "30d": 3, "90d": 3 };

/** A longer chart is shown this many days at a time, with arrows to the earlier and later pages. */
const PAGE_DAYS = 30;

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
  const value = `${when}: ${formatDayPercent(day.usedPercent)} used`;
  return day.quality === "approximate" ? `${value}\n${APPROXIMATE_DAY_TOOLTIP}` : value;
}

/**
 * The days dated under a chart without weekday labels: on each page, its first day, the days a
 * third and two thirds along, and its last. `place` anchors the date inside its page.
 */
function axisDays(count: number, perPage: number): Array<{ index: number; place: "is-first" | "is-middle" | "is-last" }> {
  const days: Array<{ index: number; place: "is-first" | "is-middle" | "is-last" }> = [];
  for (let start = 0; start < count; start += perPage) {
    const length = Math.min(perPage, count - start);
    days.push(
      { index: start, place: "is-first" },
      { index: start + Math.round(length / 3), place: "is-middle" },
      { index: start + Math.round((2 * length) / 3), place: "is-middle" },
      { index: start + length - 1, place: "is-last" },
    );
  }
  return days;
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
  /** Which day column holds the reset, and how far across that day it falls (0 to 1). */
  day: number;
  fraction: number;
  /** How full the window was when this reset passed. Null when that week was not watched. */
  usedPercent: number | null;
}

/** Where each weekly reset falls on the chart: in its day's column, at the right fraction of the day. */
function resetMarkers(
  resets: readonly string[],
  usedPercents: readonly (number | null)[] | undefined,
  starts: readonly Date[],
  gap: number,
): ResetMarker[] {
  const dayCount = starts.length - 1;
  return resets.flatMap((instant, index) => {
    const date = new Date(instant);
    const time = date.getTime();
    if (Number.isNaN(time)) return [];
    const day = starts.findIndex((start, dayIndex) => dayIndex < dayCount && time >= start.getTime() && time < starts[dayIndex + 1].getTime());
    if (day < 0) return [];
    const dayLength = starts[day + 1].getTime() - starts[day].getTime();
    const fraction = (time - starts[day].getTime()) / dayLength;
    const position = (day + fraction) / dayCount;
    // The columns are separated by gaps, so a fraction of the whole width is off by up to one gap.
    return [{
      instant,
      date,
      position,
      day,
      fraction,
      usedPercent: usedPercents?.[index] ?? null,
      left: `calc(${position * 100}% + ${gap * (position - fraction)}px)`,
    }];
  });
}

function resetTooltip(marker: ResetMarker, limit: "weekly" | "monthly"): string {
  const kind = limit === "monthly" ? "Monthly" : "Weekly";
  const when = `${kind} reset · ${resetTimeLabel(marker.date)}`;
  const period = limit === "monthly" ? "month" : "week";
  return marker.usedPercent == null ? when : `${when}\n${formatDayPercent(marker.usedPercent)} used in previous ${period}`;
}

/**
 * One bar per day for one weekly limit, on a y-axis that fits the busiest day in view: ticks every
 * 5, 10 or 20 percent (see `yAxis`), so a quiet week does not look like a busy one. Days with
 * nothing observed are striped, days partly estimated have a dotted top edge, and each weekly
 * reset is marked with one dashed purple line. A watched week shows how full it got above that line.
 *
 * A chart longer than 30 days is shown 30 days at a time, starting on the latest, with arrows to
 * move through the pages; the y-axis and the numbers below cover the whole range.
 *
 * Screen readers get the chart as a sentence on the picture and as a table beside it.
 */
export function DailyBars({
  name,
  days,
  dayStarts,
  resets,
  resetUsedPercent,
  period,
  limit = "weekly",
}: {
  /** Names the chart in the summary: the account, and the limit when the account has several. */
  name: string;
  days: readonly ActivityDay[];
  /** `days.length + 1` local midnights: the start of each day and the end of the last. */
  dayStarts: readonly Date[];
  /** Weekly resets inside the range, as RFC 3339 instants. */
  resets: readonly string[];
  /** How full the limit was at each reset. Missing entries, and null, draw no label. */
  resetUsedPercent?: readonly (number | null)[];
  period: ActivityPeriod;
  /** Which limit the bars chart, for the wording of the reset markers and the table. */
  limit?: "weekly" | "monthly";
}) {
  const axis = yAxis(days);
  const gap = GAP_PX[period];
  const labelled = period === "7d";
  const summary = chartSummary(name, days, dayStarts, period);
  const stats = chartStats(days, dayStarts);
  const markers = resetMarkers(resets, resetUsedPercent, dayStarts, gap);
  const showsUsed = markers.some((marker) => marker.usedPercent != null);
  const paged = days.length > PAGE_DAYS;
  const perPage = paged ? PAGE_DAYS : days.length;
  const pageCount = Math.ceil(days.length / perPage);
  const lastPage = pageCount - 1;
  // Counted back from the latest page, and only for the period it was chosen on, so a chart that
  // has just become 90 days long starts on today's page in its first paint. (Kept as an index from
  // the start, the 30 day chart's page 0 would show the oldest page first and then slide over.)
  const [paging, setPaging] = useState({ period, back: 0 });
  const back = paging.period === period ? paging.back : 0;
  const shownPage = Math.max(0, lastPage - back);
  const style = {
    "--activity-days": days.length,
    "--activity-gap": `${gap}px`,
    ...(paged ? { "--activity-pages": pageCount, "--activity-page": shownPage } : {}),
    ...(showsUsed ? { "--activity-pad-top": "16px" } : {}),
  } as CSSProperties;
  /** Where something sits across its own page, 0 to 1, for which way its tooltip hangs. */
  const acrossPage = (position: number) => (paged ? (position * pageCount) % 1 : position);
  const turnPage = (step: number) => setPaging({ period, back: Math.min(lastPage, Math.max(0, back - step)) });
  // Arrows only: a sideways swipe already moves between the app's pages on a phone.
  // Keyed by shape: without the keys, React would reuse the 30 day chart's divs for the 90 day one
  // (an old gridlines div would become the sliding bars), and that reused div would animate from
  // no slide to the latest page. New elements start where they belong.
  const pageView = (name: string, child: ReactElement) =>
    paged ? (
      <div className="activity-page-view" key={`${name}-paged`}>
        {child}
      </div>
    ) : (
      <Fragment key={`${name}-flat`}>{child}</Fragment>
    );

  return (
    <div className={`activity-chart is-${period}${showsUsed ? " has-used" : ""}${paged ? " is-paged" : ""}`} style={style}>
      <div className="activity-yaxis" aria-hidden="true">
        {/* The labels are placed absolutely, so this invisible copy of the widest one (the top) is
            what makes the column just wide enough for them. */}
        <span className="activity-yaxis-sizer">{axis.top}%</span>
        <div className="activity-scale">
          {/* No label at 0: the baseline speaks for itself, and the bars get the room. */}
          {axis.ticks
            .filter((tick) => tick > 0)
            .map((tick) => (
              <span className="activity-tick-label" style={{ bottom: `${(tick / axis.top) * 100}%` }} key={tick}>
                {tick}%
              </span>
            ))}
        </div>
      </div>
      {pageView("bars", <div className="activity-bars" role="img" aria-label={summary}>
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
          const side = tooltipSide(acrossPage((index + 0.5) / days.length));
          const slotClass = ["activity-bar-slot", side].filter(Boolean).join(" ");
          const barClass = [
            "activity-bar",
            empty ? "is-empty" : day.quality === "approximate" ? "is-approximate" : "",
            !empty && day.usedPercent === 0 ? "is-zero" : "",
          ]
            .filter(Boolean)
            .join(" ");
          const barHeight = empty ? undefined : `${barHeightPercent(day.usedPercent ?? 0, axis.top)}%`;
          const dayResets = markers.filter((marker) => marker.day === index);
          return (
            <div className="activity-day" key={dayStarts[index].getTime()}>
              <div className={slotClass} data-tooltip={dayTooltip(day, dayStarts[index], isToday)}>
                <div
                  className={barClass}
                  style={barHeight == null ? undefined : { height: barHeight }}
                />
                {dayResets.map((marker) => (
                  <span
                    key={marker.instant}
                    className="activity-reset-line"
                    style={{ "--reset-fraction": `${marker.fraction}` } as CSSProperties}
                  />
                ))}
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
            {!showsUsed || marker.usedPercent == null ? null : (
              <span className="activity-reset-used">{formatDayPercent(marker.usedPercent)}</span>
            )}
            <span
              className={["activity-reset-hit", tooltipSide(acrossPage(marker.position))].filter(Boolean).join(" ")}
              data-tooltip={resetTooltip(marker, limit)}
            />
          </span>
        ))}
      </div>)}
      {labelled ? null : pageView("axis",
        <div className="activity-axis" aria-hidden="true">
          {axisDays(days.length, perPage).map(({ index, place }) => {
            const left = columnCenter(index, days.length, gap);
            return (
              <span className={place} style={{ left }} key={index}>
                {/* The tick shares this span's anchor, so it lands on the bar the date names. */}
                <span className="activity-axis-tick" />
                {index === days.length - 1 ? "Today" : formatMonthDay(dayStarts[index])}
              </span>
            );
          })}
        </div>,
      )}
      <dl className="activity-chart-stats">
        <div className="activity-chart-stat">
          <dt>Today</dt>
          <dd>{stats.todayLabel}</dd>
        </div>
        {stats.peakLabel ? (
          <div className="activity-chart-stat">
            <dt>Peak</dt>
            <dd>{stats.peakLabel}</dd>
          </div>
        ) : null}
        {stats.avgLabel ? (
          <div className="activity-chart-stat">
            <dt>Avg</dt>
            <dd>{stats.avgLabel}</dd>
          </div>
        ) : null}
      </dl>
      {paged ? (
        <div className="activity-pager">
          <button
            type="button"
            className="activity-pager-button is-earlier"
            aria-label={`Earlier ${perPage} days`}
            disabled={shownPage === 0}
            onClick={() => turnPage(-1)}
          >
            <ChevronIcon />
          </button>
          <button
            type="button"
            className="activity-pager-button"
            aria-label={`Later ${perPage} days`}
            disabled={shownPage === lastPage}
            onClick={() => turnPage(1)}
          >
            <ChevronIcon />
          </button>
        </div>
      ) : null}
      {/* A table treats height as a minimum, so .sr-only on the table alone leaves a tall
          invisible box and the page scrolls past the cards. The wrapper is an ordinary 1px box. */}
      <div className="sr-only">
        <table className="sr-only">
          <caption>{summary}</caption>
          <thead>
            <tr>
              <th scope="col">Day</th>
              <th scope="col">{limit === "monthly" ? "Monthly" : "Weekly"} limit used</th>
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
    </div>
  );
}

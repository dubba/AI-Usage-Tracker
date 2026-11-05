import { useClock } from "../../shared/hooks/useClock";
import { useUsageDisplayMode } from "../../shared/hooks/useUsageDisplayMode";
import { displayPercent, usageDisplaySuffix } from "../../shared/lib/usage-display";
import { formatResetAtDate, resetCountdown } from "../../shared/lib/format";
import { usageTone, windowLength } from "../../shared/lib/usage-logic";
import { metricWindowParts } from "../../shared/lib/display";
import type {
  Provider,
  UsageWindow,
} from "../../types";

/** What a window says when it has no reset time to show. */
function noResetNote(remaining: number | null | undefined, provider: Provider | string | undefined): string {
  if (remaining == null) return "This provider has not reported a quota value yet";
  // Anthropic reports no reset time until something is used in a window.
  if (provider === "anthropic" && remaining >= 100) return "Starts on first use";
  return "Rolling window";
}

/**
 * One usage window of an account card: its span and name beside the percent, the bar, then the reset
 * time and date. The phone and a wide window draw it the same way. With `unavailable` (the provider
 * reported no windows at all) it shows an empty bar and says to refresh instead.
 */
export function AccountUsageMetric(props: WindowMetricProps | { unavailable: true; creditLabel?: string | null }) {
  if ("unavailable" in props) return <UnavailableMetric creditLabel={props.creditLabel ?? null} />;
  return <WindowMetric {...props} />;
}

function UnavailableMetric({ creditLabel }: { creditLabel: string | null }) {
  return (
    <div className="account-usage-metric unavailable-metric">
      <div className="metric-header-row">
        <span className="metric-reset">Refresh this account to retrieve its limits.</span>
      </div>
      <div className="metric-value-row">
        <span
          className="account-metric-track"
          role="progressbar"
          aria-label="Quota remaining"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuetext="Unavailable"
        ><span className="tone-neutral" style={{ width: "0%" }} /></span>
        <span className="metric-percent-line">
          <strong className="metric-full-value">Unavailable</strong>
        </span>
        {creditLabel ? <span className="metric-inline-credit">{creditLabel}</span> : null}
      </div>
    </div>
  );
}

type WindowMetricProps = {
  window: UsageWindow;
  provider?: Provider | string;
  unavailableLabel?: string;
  creditLabel?: string | null;
};

function WindowMetric({
  window,
  provider,
  unavailableLabel = "Unavailable",
  creditLabel = null,
}: WindowMetricProps) {
  const remaining = window.remainingPercent;
  const countdown = useClock((now) => resetCountdown(window.resetsAt, now, window.windowSeconds));
  const when = formatResetAtDate(window.resetsAt);
  const [displayMode] = useUsageDisplayMode();
  const shown = remaining == null ? null : displayPercent(remaining, displayMode);
  const suffix = usageDisplaySuffix(displayMode);
  const width = shown == null ? 0 : Math.min(100, Math.max(0, shown));
  const tone = usageTone(remaining);
  const { span, name } = metricWindowParts(window, provider);
  const ariaLabel = `${[span, name].filter(Boolean).join(" ") || windowLength(window) || window.label} ${displayMode === "used" ? "used" : "remaining"}`;
  return (
    <div className="account-usage-metric desktop-metric">
      <div className="desktop-metric-head">
        {span ? <span className="desktop-metric-span">{span}</span> : null}
        {name ? <span className="desktop-metric-name">{name}</span> : null}
        <span className="metric-percent-line">
          <strong className={`metric-full-value tone-${tone}`}>{shown == null ? unavailableLabel : `${Math.round(shown)}%`}</strong>
          {shown == null ? null : <span className="metric-percent-suffix">{suffix}</span>}
        </span>
      </div>
      <span
        className="account-metric-track"
        role="progressbar"
        aria-label={ariaLabel}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={shown == null ? undefined : Math.round(shown)}
        aria-valuetext={shown == null ? unavailableLabel : `${Math.round(shown)}% ${suffix}`}
      ><span className={`tone-${tone}`} style={{ width: `${width}%` }} /></span>
      <div className="desktop-metric-foot">
        <span className="metric-reset">
          {countdown ? <>Resets in <strong>{countdown}</strong></> : when ? "Resets" : noResetNote(remaining, provider)}
        </span>
        {when ? <span className="desktop-metric-date">{when}</span> : null}
        {creditLabel ? <span className="metric-inline-credit">{creditLabel}</span> : null}
      </div>
    </div>
  );
}

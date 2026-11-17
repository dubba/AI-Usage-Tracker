import { useClock } from "../../shared/hooks/useClock";
import { useUsageDisplayMode } from "../../shared/hooks/useUsageDisplayMode";
import { displayPercent, usageDisplaySuffix } from "../../shared/lib/usage-display";
import { formatMonthDay, formatResetAtDay, resetCountdown } from "../../shared/lib/format";
import { isWindowExpired, usageTone, windowLength } from "../../shared/lib/usage-logic";
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
 * One usage window of an account card: its span and name beside the percent, the bar, then one line
 * with the countdown and the reset day and time ("Resets in 4h 24m · Today, 2:29p"). The phone and a wide window draw it the same way. With `unavailable` (the provider
 * reported no windows at all) it shows an empty bar and says to refresh instead, or, while the account
 * is signed out, that usage comes after signing in (a refresh can't fetch it then).
 */
export function AccountUsageMetric(
  props: WindowMetricProps | { unavailable: true; signedOut?: boolean; creditLabel?: string | null },
) {
  if ("unavailable" in props) {
    return <UnavailableMetric signedOut={props.signedOut ?? false} creditLabel={props.creditLabel ?? null} />;
  }
  return <WindowMetric {...props} />;
}

function UnavailableMetric({ signedOut, creditLabel }: { signedOut: boolean; creditLabel: string | null }) {
  return (
    <div className="account-usage-metric unavailable-metric">
      <div className="metric-header-row">
        <span className="metric-reset">
          {signedOut ? "Usage appears after you sign in." : "Refresh this account to retrieve its limits."}
        </span>
      </div>
      <div className="metric-value-row">
        <span
          className="account-metric-track is-hatched"
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
  /** The account is signed out, or this reading is no longer current. A bar that still has a percent is striped. */
  stale?: boolean;
};

function WindowMetric({
  window,
  provider,
  unavailableLabel = "Unavailable",
  creditLabel = null,
  stale = false,
}: WindowMetricProps) {
  const remaining = window.remainingPercent;
  const countdown = useClock((now) => resetCountdown(window.resetsAt, now, window.windowSeconds));
  const expired = useClock((now) => isWindowExpired(window.resetsAt, Math.max(now, Date.now())));
  const when = useClock((now) => formatResetAtDay(window.resetsAt, now));
  const resetDay = expired && window.resetsAt ? formatMonthDay(new Date(window.resetsAt)) : null;
  const [displayMode] = useUsageDisplayMode();
  const shown = remaining == null ? null : displayPercent(remaining, displayMode);
  const suffix = usageDisplaySuffix(displayMode);
  const lastSeen = shown == null ? null : `${Math.round(shown)}% ${suffix}`;
  const width = expired || shown == null ? 0 : Math.min(100, Math.max(0, shown));
  const tone = expired ? "neutral" : usageTone(remaining);
  const { span, name } = metricWindowParts(window, provider);
  const ariaLabel = `${[span, name].filter(Boolean).join(" ") || windowLength(window) || window.label} ${displayMode === "used" ? "used" : "remaining"}`;
  // No percent or expired limit: stripe the whole track. A live/unexpired out-of-date percent: stripe only the fill.
  const hatchTrack = expired || shown == null;
  const staleFill = stale && !hatchTrack;
  const valueText = expired ? "—" : shown == null ? unavailableLabel : `${Math.round(shown)}%`;
  const ariaValueText = expired
    ? (lastSeen ? `Reset on ${resetDay}, last seen ${lastSeen}` : `Reset on ${resetDay}`)
    : (shown == null ? unavailableLabel : `${Math.round(shown)}% ${suffix}`);

  return (
    <div className={`account-usage-metric desktop-metric${staleFill ? " is-stale" : ""}${expired ? " is-expired" : ""}`}>
      <div className="desktop-metric-head">
        {span ? <span className="desktop-metric-span">{span}</span> : null}
        {name ? <span className="desktop-metric-name">{name}</span> : null}
        <span className="metric-percent-line">
          <strong className={`metric-full-value tone-${tone}`}>{valueText}</strong>
          {!expired && shown != null ? <span className="metric-percent-suffix">{suffix}</span> : null}
        </span>
      </div>
      <span
        className={`account-metric-track${hatchTrack ? " is-hatched" : ""}`}
        role="progressbar"
        aria-label={ariaLabel}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={expired || shown == null ? undefined : Math.round(shown)}
        aria-valuetext={ariaValueText}
      ><span className={`tone-${tone}`} style={{ width: `${width}%` }} /></span>
      <div className="desktop-metric-foot">
        <span className="metric-reset">
          {expired
            ? (lastSeen ? `Reset on ${resetDay} · last seen ${lastSeen}` : `Reset on ${resetDay}`)
            : <>
              {countdown ? <>Resets in <strong>{countdown}</strong></> : when ? "Resets" : noResetNote(remaining, provider)}
              {when ? <> · <span className="desktop-metric-date">{when}</span></> : null}
            </>}
        </span>
        {creditLabel ? <span className="metric-inline-credit">{creditLabel}</span> : null}
      </div>
    </div>
  );
}

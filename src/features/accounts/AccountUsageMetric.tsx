import { useClock } from "../../shared/hooks/useClock";
import { useUsageDisplayMode } from "../../shared/hooks/useUsageDisplayMode";
import { displayPercent, usageDisplaySuffix } from "../../shared/lib/usage-display";
import {
  formatResetAtShort,
  usageTone,
  windowLength,
  resetCountdownLabel,
} from "../../shared/lib/usage-logic";
import {
  metricGroupLabel,
  windowPillClass,
} from "../../shared/lib/display";
import type {
  Provider,
  UsageWindow,
} from "../../types";

function resetSummaryLine(
  window: UsageWindow,
  remaining: number | null | undefined,
  provider: Provider | string | undefined,
  nowMs?: number,
): string {
  const countdown = resetCountdownLabel(window.resetsAt, nowMs, window.windowSeconds);
  const when = formatResetAtShort(window.resetsAt);
  if (countdown && when) return `${countdown} (${when})`;
  if (countdown) return countdown;
  if (when) return `Reset: ${when}`;
  if (remaining == null) return "This provider has not reported a quota value yet";
  // Anthropic reports no reset time until something is used in a window.
  if (provider === "anthropic" && remaining >= 100) return "Starts on first use";
  return "Rolling window";
}

export function AccountUsageMetric({
  window,
  provider,
  unavailableLabel = "Unavailable",
  creditLabel = null,
}: {
  window: UsageWindow;
  provider?: Provider | string;
  unavailableLabel?: string;
  creditLabel?: string | null;
}) {
  const remaining = window.remainingPercent;
  const resetLine = useClock((now) => resetSummaryLine(window, remaining, provider, now));
  const [displayMode] = useUsageDisplayMode();
  const shown = remaining == null ? null : displayPercent(remaining, displayMode);
  const suffix = usageDisplaySuffix(displayMode);
  const width = shown == null ? 0 : Math.min(100, Math.max(0, shown));
  const tone = usageTone(remaining);
  const length = windowLength(window);
  const group = metricGroupLabel(window, provider);
  const pillText = length && group ? `${length} · ${group}` : length;
  return (
    <div className="account-usage-metric">
      <div className="metric-divider-row">
        {pillText ? (
          <span className={`metric-window-pill ${windowPillClass(window)}`}>
            {pillText}
          </span>
        ) : null}
        <span className="metric-divider-line" aria-hidden="true" />
      </div>
      <div className="metric-value-row">
        <span
          className="account-metric-track"
          role="progressbar"
          aria-label={`${length ?? window.label} ${displayMode === "used" ? "used" : "remaining"}`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={shown == null ? undefined : Math.round(shown)}
          aria-valuetext={shown == null ? unavailableLabel : `${Math.round(shown)}% ${suffix}`}
        ><span className={`tone-${tone}`} style={{ width: `${width}%` }} /></span>
        {creditLabel ? <span className="metric-inline-credit">{creditLabel}</span> : null}
      </div>
      <div className="metric-detail-row">
        <span className="metric-percent-line">
          <strong className={`metric-full-value tone-${tone}`}>{shown == null ? unavailableLabel : `${Math.round(shown)}%`}</strong>
          {shown == null ? null : <span className="metric-percent-suffix">{suffix}</span>}
        </span>
        <span className="metric-reset">{resetLine}</span>
      </div>
    </div>
  );
}

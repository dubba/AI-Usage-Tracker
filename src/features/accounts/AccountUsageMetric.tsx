import { useClock } from "../../shared/hooks/useClock";
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
  const width = remaining == null ? 0 : Math.min(100, Math.max(0, remaining));
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
        <span className="account-metric-track"><span className={`tone-${tone}`} style={{ width: `${width}%` }} /></span>
        {creditLabel ? <span className="metric-inline-credit">{creditLabel}</span> : null}
      </div>
      <div className="metric-detail-row">
        <span className="metric-percent-line">
          <strong className="metric-full-value">{remaining == null ? unavailableLabel : `${Math.round(remaining)}%`}</strong>
          {remaining == null ? null : <span className="metric-percent-suffix">left</span>}
        </span>
        <span className="metric-reset">{resetLine}</span>
      </div>
    </div>
  );
}

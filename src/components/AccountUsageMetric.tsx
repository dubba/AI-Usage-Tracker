import {
  formatResetAtShort,
  usageTone,
  windowLength,
  resetCountdownLabel,
} from "../usage-logic";
import {
  antigravityGroupLabel,
  windowPillClass,
} from "../display";
import type {
  Provider,
  UsageWindow,
} from "../types";

function resetSummaryLine(
  window: UsageWindow,
  remaining: number | null | undefined,
  nowMs?: number,
): string {
  const countdown = resetCountdownLabel(window.resetsAt, nowMs, window.windowSeconds);
  const when = formatResetAtShort(window.resetsAt);
  if (countdown && when) return `${countdown} (${when})`;
  if (countdown) return countdown;
  if (when) return `Reset: ${when}`;
  if (remaining == null) return "This provider has not reported a quota value yet";
  return "Rolling window";
}

export function AccountUsageMetric({
  window,
  provider,
  nowMs,
  unavailableLabel = "Unavailable",
  creditLabel = null,
}: {
  window: UsageWindow;
  provider?: Provider | string;
  nowMs?: number;
  unavailableLabel?: string;
  creditLabel?: string | null;
}) {
  const remaining = window.remainingPercent;
  const width = remaining == null ? 0 : Math.min(100, Math.max(0, remaining));
  const tone = usageTone(remaining);
  const length = windowLength(window);
  const group = provider === "antigravity" ? antigravityGroupLabel(window) : null;
  const pillText = length && group ? `${length} · ${group}` : length;
  return (
    <div className="account-usage-metric">
      <div className="metric-reset-row">
        {pillText ? (
          <span className="metric-reset-lead">
            <span className={`metric-window-pill ${windowPillClass(window)}`}>
              {pillText}
            </span>
          </span>
        ) : <span className="metric-window-pill-spacer" />}
        <span className="metric-reset">
          {resetSummaryLine(window, remaining, nowMs)}
        </span>
      </div>
      <div className="metric-value-row">
        <strong className="metric-full-value">{remaining == null ? unavailableLabel : `${Math.round(remaining)}%`}</strong>
        <span className="account-metric-track"><span className={`tone-${tone}`} style={{ width: `${width}%` }} /></span>
        {creditLabel ? <span className="metric-inline-credit">{creditLabel}</span> : null}
      </div>
    </div>
  );
}

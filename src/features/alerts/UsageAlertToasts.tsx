import { useEffect, useState } from "react";
import { formatAlertTime } from "../../shared/lib/format";
import { BellIcon, CloseIcon } from "../../shared/ui/icons";
import type { UsageAlertToast } from "./usage-alerts";

/**
 * The container stays mounted so it is a real live region by the time a toast
 * arrives (a region inserted together with its content is often not announced).
 * One polite region announces every toast, instead of each toast interrupting
 * with role="alert".
 */
export function UsageAlertToasts({
  alerts,
  onDismiss,
  onDismissAll,
  onSelectAlert,
  onPauseChange,
}: {
  alerts: UsageAlertToast[];
  onDismiss: (id: string) => void;
  onDismissAll?: () => void;
  onSelectAlert?: (alert: UsageAlertToast) => void;
  onPauseChange?: (paused: boolean) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (alerts.length <= 1) setExpanded(false);
  }, [alerts.length]);

  const latest = alerts[alerts.length - 1];
  const stacked = alerts.length > 1;
  const remainingCount = Math.max(0, alerts.length - 1);

  const handleCloseAll = () => {
    if (stacked && onDismissAll) {
      onDismissAll();
      return;
    }
    if (stacked) {
      for (const alert of alerts) onDismiss(alert.id);
      return;
    }
    if (latest) onDismiss(latest.id);
  };

  return (
    <div className="usage-alert-toast-container" role="status" aria-live="polite">
      {latest ? (
        <div
          className={`usage-alert-toast${stacked ? " is-stacked" : ""}`}
          onMouseEnter={() => onPauseChange?.(true)}
          onMouseLeave={() => onPauseChange?.(false)}
          onTouchStart={() => onPauseChange?.(true)}
          onTouchEnd={() => onPauseChange?.(false)}
          onTouchCancel={() => onPauseChange?.(false)}
          onFocusCapture={() => onPauseChange?.(true)}
          onBlurCapture={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
              onPauseChange?.(false);
            }
          }}
        >
          <div className="usage-alert-toast-top">
            <button
              type="button"
              className="usage-alert-toast-main"
              onClick={() => onSelectAlert?.(latest)}
              aria-label={`Jump to ${latest.accountLabel ?? latest.title}`}
            >
              <div className="usage-alert-toast-icon">
                <BellIcon />
              </div>
              <div className="usage-alert-toast-content">
                <div className="usage-alert-toast-header">
                  <span className="usage-alert-toast-title">{latest.title}</span>
                  {stacked ? (
                    <span className="usage-alert-toast-count">{alerts.length} alerts</span>
                  ) : null}
                  <span className="usage-alert-toast-time">{formatAlertTime(latest.timestamp)}</span>
                </div>
                <div className="usage-alert-toast-body">
                  {latest.body}
                  {stacked && !expanded ? (
                    <span className="usage-alert-toast-more"> (+{remainingCount} more)</span>
                  ) : null}
                </div>
              </div>
            </button>
            <div className="usage-alert-toast-actions">
              {stacked ? (
                <button
                  type="button"
                  className="usage-alert-toast-expand"
                  onClick={() => setExpanded((current) => !current)}
                  aria-expanded={expanded}
                  aria-label={expanded ? "Collapse alert list" : `Show all ${alerts.length} alerts`}
                >
                  {expanded ? "Hide" : "All"}
                </button>
              ) : null}
              <button
                type="button"
                className="usage-alert-toast-close"
                onClick={handleCloseAll}
                aria-label={stacked ? "Dismiss all alerts" : "Dismiss alert"}
                data-tooltip={stacked ? "Dismiss all" : "Dismiss"}
              >
                <CloseIcon />
              </button>
            </div>
          </div>

          {stacked && expanded ? (
            <div className="usage-alert-toast-list" role="list">
              {[...alerts].reverse().map((alert) => (
                <div key={alert.id} className="usage-alert-toast-item" role="listitem">
                  <button
                    type="button"
                    className="usage-alert-toast-item-jump"
                    onClick={() => onSelectAlert?.(alert)}
                  >
                    <span className="usage-alert-toast-item-title">{alert.title}</span>
                    <span className="usage-alert-toast-item-body">{alert.body}</span>
                  </button>
                  <button
                    type="button"
                    className="usage-alert-toast-item-close"
                    onClick={() => onDismiss(alert.id)}
                    aria-label={`Dismiss ${alert.title}`}
                  >
                    <CloseIcon />
                  </button>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}


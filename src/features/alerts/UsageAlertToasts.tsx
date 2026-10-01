import { formatAlertTime } from "../../shared/lib/display";
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
}: {
  alerts: UsageAlertToast[];
  onDismiss: (id: string) => void;
}) {
  return (
    <div className="usage-alert-toast-container" role="status" aria-live="polite">
      {alerts.map((alert) => (
        <div key={alert.id} className="usage-alert-toast">
          <div className="usage-alert-toast-icon">
            <BellIcon />
          </div>
          <div className="usage-alert-toast-content">
            <div className="usage-alert-toast-header">
              <span className="usage-alert-toast-title">{alert.title}</span>
              <span className="usage-alert-toast-time">{formatAlertTime(alert.timestamp)}</span>
            </div>
            <div className="usage-alert-toast-body">{alert.body}</div>
          </div>
          <button
            type="button"
            className="usage-alert-toast-close"
            onClick={() => onDismiss(alert.id)}
            aria-label="Dismiss alert"
            data-tooltip="Dismiss"
          >
            <CloseIcon />
          </button>
        </div>
      ))}
    </div>
  );
}

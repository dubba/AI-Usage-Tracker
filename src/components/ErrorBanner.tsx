import type { AppError } from "../errors";
import { CloseIcon } from "../icons";

export function ErrorBanner({
  errors,
  onDismiss,
}: {
  errors: AppError[];
  onDismiss: (source: string) => void;
}) {
  if (errors.length === 0) return null;
  return (
    <div className="app-error-stack" role="region" aria-label="Errors">
      {errors.map((entry) => (
        <div key={entry.source} className="app-error-banner" role="alert">
          <span className="app-error-message">{entry.message}</span>
          <button
            type="button"
            className="app-error-dismiss"
            onClick={() => onDismiss(entry.source)}
            aria-label="Dismiss error"
            data-tooltip="Dismiss"
          >
            <CloseIcon />
          </button>
        </div>
      ))}
    </div>
  );
}

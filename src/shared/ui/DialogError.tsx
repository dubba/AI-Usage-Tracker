import { CloseIcon } from "./icons";

/**
 * A dialog's red error banner, with an X in its top right corner that hides it (`useDialogError`).
 */
export function DialogError({
  message,
  onDismiss,
  className,
}: {
  message: string;
  onDismiss: () => void;
  /** Extra classes for a dialog's own placement (for example `modal-error-message`). */
  className?: string;
}) {
  return (
    <div className={`error-panel modal-error dialog-error${className ? ` ${className}` : ""}`} role="alert">
      <span>{message}</span>
      <button type="button" className="dialog-error-dismiss" aria-label="Dismiss error" onClick={onDismiss}>
        <CloseIcon aria-hidden="true" />
      </button>
    </div>
  );
}

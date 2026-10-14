import { useId, useRef, type ReactNode } from "react";
import { useModalA11y } from "../hooks/useModalA11y";
import { backdropMouseDown, useModalClosePolicy } from "../hooks/useModalClosePolicy";
import { ModalCloseButton } from "./ModalCloseButton";

/**
 * The shared confirm-before-acting dialog (deletions, discarding unsaved
 * edits). One pattern everywhere: what happens to what, a danger-styled
 * confirm, and a Cancel that always returns to the dialog that opened it
 * without touching its state. Focus returns to the control that opened it via
 * useModalA11y.
 */
export function ConfirmDialog({
  open,
  kicker,
  title,
  body,
  confirmLabel,
  busyLabel,
  busy = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  /** Small uppercase line above the title, e.g. "Delete group". */
  kicker: string;
  title: ReactNode;
  /** Say exactly what is removed or lost, and what is unaffected. */
  body: ReactNode;
  confirmLabel: string;
  /** Shown on the confirm button while busy; defaults to the confirm label. */
  busyLabel?: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  const titleId = useId();
  const bodyId = useId();
  const requestCancel = useModalClosePolicy(!busy, onCancel);
  useModalA11y(dialogRef, open, requestCancel);
  if (!open) return null;

  return (
    <div
      className="modal-backdrop confirm-dialog-backdrop"
      role="presentation"
      onMouseDown={backdropMouseDown(requestCancel)}
    >
      <section
        ref={dialogRef}
        className="modal-card remove-account-modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        tabIndex={-1}
      >
        <ModalCloseButton onClose={requestCancel} disabled={busy} />
        <div className="modal-kicker">{kicker}</div>
        <h2 id={titleId}>{title}</h2>
        <p id={bodyId}>{body}</p>
        <div className="modal-actions">
          <button type="button" className="button ghost" disabled={busy} onClick={requestCancel}>
            Cancel
          </button>
          <button type="button" className="button remove-confirm-button" disabled={busy} onClick={onConfirm}>
            {busy ? (busyLabel ?? confirmLabel) : confirmLabel}
          </button>
        </div>
      </section>
    </div>
  );
}

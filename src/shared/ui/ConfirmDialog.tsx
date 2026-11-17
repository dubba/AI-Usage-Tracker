import { useId, useRef, type ReactNode } from "react";
import { useModalA11y } from "../hooks/useModalA11y";
import { useModalClosePolicy } from "../hooks/useModalClosePolicy";
import { AlertCircleIcon } from "./icons";
import { ModalDialog } from "./ModalDialog";

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
  note,
  noteTone = "info",
  cancelLabel = "Cancel",
  confirmLabel,
  confirmDanger = true,
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
  /** An optional callout under the body: advice that bears on the choice. */
  note?: ReactNode;
  /** `caution` tints the note amber. */
  noteTone?: "info" | "caution";
  cancelLabel?: string;
  confirmLabel: string;
  /** Danger-red for deletions; primary for other actions such as Turn On Wi-Fi. */
  confirmDanger?: boolean;
  /** Shown on the confirm button while busy; defaults to the confirm label. */
  busyLabel?: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  const titleId = useId();
  const bodyId = useId();
  const noteId = useId();
  const requestCancel = useModalClosePolicy(!busy, onCancel);
  useModalA11y(dialogRef, open, requestCancel);
  if (!open) return null;

  return (
    <ModalDialog
      dialogRef={dialogRef}
      role="alertdialog"
      labelledBy={titleId}
      describedBy={note ? `${bodyId} ${noteId}` : bodyId}
      className="remove-account-modal"
      backdropClassName="confirm-dialog-backdrop"
      onClose={requestCancel}
      closeDisabled={busy}
    >
      <div className="modal-kicker">{kicker}</div>
      <h2 id={titleId}>{title}</h2>
      <p id={bodyId}>{body}</p>
      {note ? (
        <div id={noteId} className={`confirm-dialog-note is-${noteTone}`}>
          {noteTone === "caution" ? <AlertCircleIcon className="confirm-dialog-note-icon" /> : null}
          <span>{note}</span>
        </div>
      ) : null}
      <div className="modal-actions">
        <button type="button" className="button ghost" disabled={busy} onClick={requestCancel}>
          {cancelLabel}
        </button>
        <button
          type="button"
          className={confirmDanger ? "button remove-confirm-button" : "button primary"}
          disabled={busy}
          onClick={onConfirm}
        >
          {busy ? (busyLabel ?? confirmLabel) : confirmLabel}
        </button>
      </div>
    </ModalDialog>
  );
}

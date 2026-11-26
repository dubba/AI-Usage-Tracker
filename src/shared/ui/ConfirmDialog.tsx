import { useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useModalA11y } from "../hooks/useModalA11y";
import { useModalClosePolicy } from "../hooks/useModalClosePolicy";
import { AlertTriangleIcon } from "./icons";
import { ModalDialog } from "./ModalDialog";

/**
 * The shared confirm-before-acting dialog (deletions, discarding unsaved
 * edits). One pattern everywhere: what happens to what, a danger-styled
 * confirm, and a Cancel that always returns to the dialog that opened it
 * without touching its state. Focus returns to the control that opened it via
 * useModalA11y.
 *
 * It is drawn at the end of <body>, not where it is used: a page section that is a containing
 * block (a transform, a filter or `container-type` on an ancestor) would otherwise hold its fixed
 * backdrop, which then dims only that section and leaves the rest of the window clickable.
 */
export function ConfirmDialog({
  open,
  kicker,
  title,
  body,
  richBody = false,
  className,
  note,
  noteTone = "info",
  noteIcon,
  cancelLabel = "Cancel",
  confirmLabel,
  confirmDanger = true,
  splitActions = false,
  busyLabel,
  busy = false,
  onConfirm,
  onCancel,
  onDismiss,
}: {
  open: boolean;
  /** Small uppercase line above the title, e.g. "Delete group". */
  kicker: string;
  title: ReactNode;
  /** Say exactly what is removed or lost, and what is unaffected. */
  body: ReactNode;
  /** The body holds its own blocks (headings, paragraphs, callouts) instead of one sentence. */
  richBody?: boolean;
  /** Added to the dialog card's class, for a dialog with a layout of its own. */
  className?: string;
  /** An optional callout under the body: advice that bears on the choice. */
  note?: ReactNode;
  /** `caution` tints the note amber with a warning icon; `inline` renders a clean borderless instruction row. */
  noteTone?: "info" | "caution" | "inline";
  /** Optional leading icon for the note row (defaults to the warning triangle for `caution`). */
  noteIcon?: ReactNode;
  cancelLabel?: string;
  confirmLabel: string;
  /** Danger-red for deletions; primary for other actions such as Open Wi-Fi Settings. */
  confirmDanger?: boolean;
  /** Places the cancel button on the left as a borderless secondary action, opposite the primary confirm button. */
  splitActions?: boolean;
  /** Shown on the confirm button while busy; defaults to the confirm label. */
  busyLabel?: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  /** The X, Escape and the backdrop, when they should do something other than the cancel button. */
  onDismiss?: () => void;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  const titleId = useId();
  const bodyId = useId();
  const noteId = useId();
  const requestCancel = useModalClosePolicy(!busy, onCancel);
  const requestDismiss = useModalClosePolicy(!busy, onDismiss ?? onCancel);
  useModalA11y(dialogRef, open, requestDismiss);
  if (!open) return null;

  return createPortal(
    <ModalDialog
      dialogRef={dialogRef}
      role="alertdialog"
      labelledBy={titleId}
      describedBy={note ? `${bodyId} ${noteId}` : bodyId}
      className={className ? `remove-account-modal ${className}` : "remove-account-modal"}
      backdropClassName="confirm-dialog-backdrop"
      onClose={requestDismiss}
      closeDisabled={busy}
    >
      <div className="modal-kicker">{kicker}</div>
      <h2 id={titleId}>{title}</h2>
      {richBody ? (
        <div id={bodyId} className="confirm-dialog-body">
          {body}
        </div>
      ) : (
        <p id={bodyId}>{body}</p>
      )}
      {note ? (
        <div id={noteId} className={`confirm-dialog-note is-${noteTone}`}>
          {noteIcon ?? (noteTone === "caution" ? <AlertTriangleIcon className="confirm-dialog-note-icon" /> : null)}
          <span>{note}</span>
        </div>
      ) : null}
      <div className={splitActions ? "modal-actions is-split" : "modal-actions"}>
        <button
          type="button"
          className={splitActions ? "button ghost button-tertiary" : "button ghost"}
          disabled={busy}
          onClick={requestCancel}
        >
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
    </ModalDialog>,
    document.body,
  );
}

import type { ReactNode, RefObject } from "react";
import { backdropMouseDown } from "../hooks/useModalClosePolicy";
import { ModalCloseButton } from "./ModalCloseButton";

/**
 * The shell every dialog shares: the backdrop (a press on it closes the dialog), the dialog
 * section with its role and label, and the × button. The rest of the dialog goes in `children`:
 * the kicker (`.modal-kicker`) and title (`h2`) must stay direct children of the dialog section,
 * because the styles select them that way (`.modal-card[role="dialog"] > h2`).
 *
 * `onClose` should be the dialog's close-policy callback (`useModalClosePolicy`), so the ×, the
 * backdrop, Escape and Cancel all follow one rule.
 */
export function ModalDialog({
  dialogRef,
  labelledBy,
  describedBy,
  role = "dialog",
  className = "",
  backdropClassName = "",
  onClose,
  closeDisabled,
  afterDialog,
  children,
}: {
  dialogRef: RefObject<HTMLElement | null>;
  /** Id of the element (the `h2`) that names the dialog. */
  labelledBy: string;
  describedBy?: string;
  role?: "dialog" | "alertdialog";
  /** Classes of the dialog section, after `modal-card`. */
  className?: string;
  /** Classes of the backdrop, after `modal-backdrop`. */
  backdropClassName?: string;
  onClose: () => void;
  closeDisabled?: boolean;
  /** Rendered inside the backdrop, after the dialog section: dialogs opened from this one. */
  afterDialog?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className={`modal-backdrop ${backdropClassName}`.trim()} role="presentation" onMouseDown={backdropMouseDown(onClose)}>
      <section
        ref={dialogRef}
        className={`modal-card ${className}`.trim()}
        role={role}
        aria-modal="true"
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        tabIndex={-1}
      >
        <ModalCloseButton onClose={onClose} disabled={closeDisabled} />
        {children}
      </section>
      {afterDialog}
    </div>
  );
}

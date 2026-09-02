import { useRef } from "react";
import type { Account } from "../types";
import { useModalA11y } from "./useModalA11y";

export function RemoveAccountModal({
  account,
  busy,
  onClose,
  onConfirm,
}: {
  account: Account | null;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  useModalA11y(dialogRef, account != null, () => {
    if (!busy) onClose();
  });
  if (!account) return null;

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}>
      <section ref={dialogRef} className="modal-card remove-account-modal" role="dialog" aria-modal="true" aria-labelledby="remove-account-title" tabIndex={-1}>
        <div className="modal-kicker">Remove account</div>
        <h2 id="remove-account-title">Remove {account.label}?</h2>
        <p>Deletes stored credentials for this account from device. The provider account itself will not be canceled.</p>
        <div className="modal-actions">
          <button type="button" className="button ghost" disabled={busy} onClick={onClose}>Cancel</button>
          <button type="button" className="button remove-confirm-button" disabled={busy} onClick={onConfirm}>{busy ? "Removing…" : "Remove"}</button>
        </div>
      </section>
    </div>
  );
}

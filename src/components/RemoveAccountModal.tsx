import type { Account } from "../types";

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
  if (!account) return null;

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}>
      <section className="modal-card remove-account-modal" role="dialog" aria-modal="true" aria-labelledby="remove-account-title">
        <div className="modal-kicker">Remove account</div>
        <h2 id="remove-account-title">Remove {account.label}?</h2>
        <p>This deletes stored credentials for this account from this computer. The provider account itself is not cancelled.</p>
        <div className="modal-actions">
          <button type="button" className="button ghost" disabled={busy} onClick={onClose}>Cancel</button>
          <button type="button" className="button remove-confirm-button" disabled={busy} onClick={onConfirm}>{busy ? "Removing…" : "Remove"}</button>
        </div>
      </section>
    </div>
  );
}

import { useRef } from "react";
import type { Account } from "../../types";
import { useModalA11y } from "../../shared/hooks/useModalA11y";
import { backdropMouseDown, useModalClosePolicy } from "../../shared/hooks/useModalClosePolicy";
import { providerName } from "../../shared/lib/providers";
import { displayAccountLabel } from "../../shared/lib/usage-logic";
import { ModalCloseButton } from "../../shared/ui/ModalCloseButton";

export type UnprotectedSignInsBusy = "retry" | "remove" | null;

/**
 * Asks what to do about saved sign-ins the phone's secure storage could not
 * encrypt. The app does not use them, so those accounts are paused: retry the
 * encryption (it can fail right after a restart), or remove the accounts and
 * sign in again so the new sign-ins are stored encrypted.
 */
export function UnprotectedSignInsModal({
  accounts,
  busy,
  retryFailed,
  onRetry,
  onRemove,
  onClose,
}: {
  /** The affected accounts; the dialog is closed while this is null. */
  accounts: Account[] | null;
  busy: UnprotectedSignInsBusy;
  /** The last retry left some sign-ins unencrypted. */
  retryFailed: boolean;
  onRetry: () => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  const open = accounts != null && accounts.length > 0;
  const requestClose = useModalClosePolicy(!busy, onClose);
  useModalA11y(dialogRef, open, requestClose);
  if (!open) return null;
  const one = accounts.length === 1;

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={backdropMouseDown(requestClose)}>
      <section ref={dialogRef} className="modal-card remove-account-modal" role="dialog" aria-modal="true" aria-labelledby="unprotected-sign-ins-title" tabIndex={-1}>
        <ModalCloseButton onClose={requestClose} disabled={busy != null} />
        <div className="modal-kicker">Secure storage</div>
        <h2 id="unprotected-sign-ins-title">{one ? "A sign-in isn't encrypted" : "Some sign-ins aren't encrypted"}</h2>
        <p>
          The app couldn't lock {one ? "this saved sign-in" : "these saved sign-ins"} with your phone's secure storage, so it
          isn't using {one ? "it" : "them"}:
        </p>
        <ul>
          {accounts.map((account) => (
            <li key={account.id}>
              {displayAccountLabel(account)} ({providerName(account.provider)})
            </li>
          ))}
        </ul>
        <p>
          If your phone just restarted, try again. Otherwise remove {one ? "the account" : "these accounts"} and sign in again,
          so the new sign-in is stored encrypted. The provider account itself is not affected.
        </p>
        <div className="modal-actions">
          <button type="button" className="button ghost" disabled={busy != null} onClick={requestClose}>Not now</button>
          <button type="button" className="button ghost" disabled={busy != null} onClick={onRetry}>{busy === "retry" ? "Retrying…" : "Retry"}</button>
          <button type="button" className="button remove-confirm-button" disabled={busy != null} onClick={onRemove}>
            {busy === "remove" ? "Removing…" : "Remove and sign in again"}
          </button>
        </div>
        {retryFailed ? (
          <p role="status" className="modal-error">Still couldn't encrypt {one ? "it" : "them"}.</p>
        ) : null}
      </section>
    </div>
  );
}

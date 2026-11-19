import { ConfirmDialog } from "../../shared/ui/ConfirmDialog";
import type { Account } from "../../types";

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
  return (
    <ConfirmDialog
      open={account != null}
      kicker="Remove account"
      title={account ? `Remove ${account.label}?` : "Remove account?"}
      body={
        <>
          Deletes the stored credentials for this account from <strong>this device only</strong>.
          The provider account itself will not be canceled.
        </>
      }
      note="This only removes the account from this device. Other synced devices, if any, remain unchanged."
      noteTone="caution"
      confirmLabel="Remove"
      busyLabel="Removing…"
      busy={busy}
      onConfirm={onConfirm}
      onCancel={onClose}
    />
  );
}

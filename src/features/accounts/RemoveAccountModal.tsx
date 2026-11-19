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
          Removes this account&rsquo;s saved credentials from <strong>this device only</strong>. Your AI provider
          account won&rsquo;t be deleted or canceled.
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

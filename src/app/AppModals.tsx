import { useUnprotectedSignIns } from "../features/accounts/useUnprotectedSignIns";
import { AccountAlertModal } from "../features/accounts/AccountAlertModal";
import { GoogleAiStudioUsageModal } from "../features/accounts/GoogleAiStudioUsageModal";
import { RemoveAccountModal } from "../features/accounts/RemoveAccountModal";
import { UnprotectedSignInsModal } from "../features/accounts/UnprotectedSignInsModal";
import { AddAccountModal } from "../features/add-account/AddAccountModal";
import { BucketModal } from "../features/buckets/BucketModal";
import { PairingModal } from "../features/pairing/PairingModal";
import type { AppUpdateState } from "../features/settings/settings-context";
import { UpdateNotesModal } from "../features/settings/UpdateNotesModal";
import { busyKey, type BusyKeys } from "../shared/lib/busy";
import type { Account, AccountBucket } from "../types";
import type { ModalAction, ModalState } from "./modal-state";

/**
 * Every dialog the app can show over the dashboard. Which one is open comes from `modal`
 * (see `modal-state.ts`); pairing and the update notes have state of their own because other
 * parts of the app open them. Each dialog's "done" callback is made by `App`.
 */
export function AppModals({
  modal,
  dispatchModal,
  accounts,
  busy,
  openLink,
  onAccountAdded,
  onBucketSaved,
  onBucketDeleted,
  googleUsageAccount,
  onGoogleUsageClose,
  onGoogleUsageConnected,
  onAlertSaved,
  onRemoveAccount,
  unprotectedSignIns,
  pairing,
  update,
  onCloseUpdateNotes,
}: {
  modal: ModalState;
  dispatchModal: (action: ModalAction) => void;
  accounts: Account[];
  busy: BusyKeys;
  openLink: (url: string) => void;
  onAccountAdded: (account: Account) => Promise<void>;
  onBucketSaved: (bucket: AccountBucket) => Promise<void>;
  onBucketDeleted: (bucketId: string) => Promise<void>;
  googleUsageAccount: Account | null;
  onGoogleUsageClose: () => void;
  onGoogleUsageConnected: () => Promise<void>;
  onAlertSaved: () => Promise<void>;
  /** Removes `account`, calling `onStarted` once the removal is accepted. */
  onRemoveAccount: (account: Account, onStarted: () => void) => void;
  unprotectedSignIns: ReturnType<typeof useUnprotectedSignIns>;
  pairing: { open: boolean; initialUri: string | null; onClose: () => void; onCompleted: () => void };
  update: AppUpdateState;
  onCloseUpdateNotes: () => void;
}) {
  const addModal = modal?.kind === "add" ? modal : null;
  const bucketModal = modal?.kind === "bucket" ? modal : null;
  const alertAccount = modal?.kind === "alert" ? modal.account : null;
  const accountToRemove = modal?.kind === "remove" ? modal.account : null;
  const close = (kind: NonNullable<ModalState>["kind"]) => () => dispatchModal({ type: "close", kind });

  return (
    <>
      <AddAccountModal
        open={addModal != null}
        initialLabel={addModal?.label ?? ""}
        initialProvider={addModal?.provider}
        reconnectAccountId={addModal?.reconnectAccountId}
        onClose={close("add")}
        onAdded={onAccountAdded}
      />
      <BucketModal
        open={bucketModal != null}
        bucket={bucketModal?.bucket ?? null}
        initialProvider={bucketModal?.provider ?? null}
        accounts={accounts}
        initialConfirmDelete={bucketModal?.confirmDelete ?? false}
        onClose={close("bucket")}
        onSaved={onBucketSaved}
        onDeleted={onBucketDeleted}
      />
      <GoogleAiStudioUsageModal
        account={googleUsageAccount}
        onClose={onGoogleUsageClose}
        onConnected={onGoogleUsageConnected}
      />
      <AccountAlertModal account={alertAccount} onClose={close("alert")} onSaved={onAlertSaved} />
      <RemoveAccountModal
        account={accountToRemove}
        busy={Boolean(accountToRemove && busy.has(busyKey("remove", accountToRemove.id)))}
        onClose={close("remove")}
        onConfirm={() => {
          if (accountToRemove) onRemoveAccount(accountToRemove, close("remove"));
        }}
      />
      <UnprotectedSignInsModal
        accounts={unprotectedSignIns.accounts}
        busy={unprotectedSignIns.busy}
        retryFailed={unprotectedSignIns.retryFailed}
        onRetry={() => void unprotectedSignIns.retry()}
        onRemove={() => void unprotectedSignIns.remove()}
        onClose={unprotectedSignIns.dismiss}
      />
      <PairingModal
        open={pairing.open}
        initialJoinUri={pairing.initialUri}
        onClose={pairing.onClose}
        onCompleted={pairing.onCompleted}
      />
      <UpdateNotesModal
        open={update.updateNotesOpen}
        version={update.appUpdate?.availableVersion ?? update.pendingUpdateVersion ?? null}
        releaseDate={update.appUpdate?.date}
        releaseNotes={update.appUpdate?.body}
        onClose={onCloseUpdateNotes}
        onInstallUpdate={() => void update.installUpdate()}
        onOpenLink={openLink}
        updateBusy={update.updateBusy}
        updatePercent={update.updateProgress?.percent ?? null}
        updateError={update.updateError}
      />
    </>
  );
}

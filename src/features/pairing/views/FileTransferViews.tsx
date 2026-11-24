import type { ReactNode } from "react";
import { CheckIcon, ChevronIcon, NearbyShareIcon } from "../../../shared/ui/icons";
import type { FilePreview } from "../../../types";
import type { FileSendState } from "../hooks/useFileTransfer";
import { isIOS } from "../../../shared/lib/platform";
import { SearchingRow } from "./HostCodeView";

function accounts(count: number): string {
  return count === 1 ? "1 account" : `${count} accounts`;
}

function BackButton({ onClick, disabled }: { onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" className="button ghost pairing-back-btn" onClick={onClick} disabled={disabled}>
      <ChevronIcon style={{ transform: "rotate(180deg)" }} />
      <span>Back</span>
    </button>
  );
}

/** The steps of the file route, the ones done ticked and the current one marked. */
function TransferSteps({ steps, current }: { steps: ReactNode[]; current: number }) {
  return (
    <ol className="pairing-transfer-steps">
      {steps.map((step, index) => (
        <li key={index} className={index < current ? "is-done" : index === current ? "is-current" : ""}>
          <span className="pairing-transfer-step-mark" aria-hidden="true">
            {index < current ? <CheckIcon /> : index + 1}
          </span>
          <span>{step}</span>
        </li>
      ))}
    </ol>
  );
}

/**
 * Ways to send the file again: the share menu (where there is one) and a saved copy. An iPhone
 * saves from the share sheet (Save to Files), so it gets no separate Save.
 */
function SendAgainLinks({
  nearbyName,
  canShare,
  busy,
  onShare,
  onSave,
}: {
  nearbyName: string;
  canShare: boolean;
  busy: boolean;
  onShare: () => void;
  onSave: () => void;
}) {
  return (
    <div className="pairing-file-links">
      {canShare ? (
        <button type="button" className="button pairing-nearby-btn" disabled={busy} onClick={onShare}>
          <NearbyShareIcon />
          <span>Send again by {nearbyName}</span>
        </button>
      ) : null}
      {isIOS() ? null : (
        <button type="button" className="pairing-other-ways" disabled={busy} onClick={onSave}>
          Save to a file instead
        </button>
      )}
    </div>
  );
}

/** Sender: the accounts are encrypted with the code into one file, which goes out by itself. */
export function FileSendView({
  state,
  nearbyName,
  canShare,
  busy,
  onSendAgain,
  onShare,
  onSave,
  onBack,
  onDone,
}: {
  state: FileSendState;
  nearbyName: string;
  canShare: boolean;
  busy: boolean;
  /** Makes and sends the file again, after it failed. */
  onSendAgain: () => void;
  onShare: () => void;
  onSave: () => void;
  /** Back to the code entry. */
  onBack: () => void;
  onDone: () => void;
}) {
  const steps = [
    "Accounts encrypted with the code",
    <>Choose the other device in {nearbyName}</>,
    "Accept on the other device",
  ];
  if (state.made) {
    return (
      <div className="pairing-panel-status pairing-file-view">
        <TransferSteps steps={steps} current={1} />
        <p>
          {state.notOnNetwork
            ? `The other device wasn't found on this Wi-Fi network (a VPN on either device can hide it), so the accounts go by ${nearbyName}. `
            : ""}
          Once the other device accepts the file and confirms, the accounts are added there.
        </p>
        <SendAgainLinks nearbyName={nearbyName} canShare={canShare} busy={busy} onShare={onShare} onSave={onSave} />
        <div className="pairing-nav-row is-single">
          <button type="button" className="button settings-update-action button-green" onClick={onDone}>
            Done
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="pairing-panel-status pairing-file-view">
      <TransferSteps steps={steps} current={0} />
      {busy ? (
        <SearchingRow>Encrypting the accounts with the code…</SearchingRow>
      ) : (
        <div className="pairing-nav-row">
          <BackButton onClick={onBack} />
          <button type="button" className="button primary" onClick={onSendAgain}>
            Try Again
          </button>
        </div>
      )}
    </div>
  );
}

/** Receiver: the file arrived and opened with the code; its accounts are added once the user confirms here. */
export function FileReceiveView({
  preview,
  nearbyName,
  busy,
  awaitingConfirm,
  onConfirm,
  onCancel,
  onBack,
}: {
  preview: FilePreview | null;
  nearbyName: string;
  busy: boolean;
  /** The file opened; its accounts are added only once the user agrees here. */
  awaitingConfirm: boolean;
  /** Add the accounts. */
  onConfirm: () => void;
  /** Add nothing and close Sync Devices (which drops the opened file). */
  onCancel: () => void;
  /** Back to the role choice (the code is used up). */
  onBack: () => void;
}) {
  const steps = [
    <>File received via {nearbyName}</>,
    preview ? `Adding ${accounts(preview.accountCount)}` : "Adding the accounts",
  ];
  if (awaitingConfirm && preview) {
    return (
      <div className="pairing-panel-status pairing-file-view">
        <TransferSteps steps={steps} current={1} />
        <p className="pairing-add-question">
          Are you sure you want to add {preview.accountCount === 1 ? "this account" : `these ${accounts(preview.accountCount)}`}{" "}
          from the other device?
        </p>
        <div className="pairing-nav-row is-end">
          <button type="button" className="button ghost" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="button primary" onClick={onConfirm}>
            Add Accounts
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="pairing-panel-status pairing-file-view">
      <TransferSteps steps={steps} current={1} />
      {busy && preview ? (
        <SearchingRow>Adding {accounts(preview.accountCount)}…</SearchingRow>
      ) : busy ? null : (
        <div className="pairing-nav-row is-single">
          <BackButton onClick={onBack} />
        </div>
      )}
    </div>
  );
}

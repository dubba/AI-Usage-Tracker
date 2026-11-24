import type { ReactNode } from "react";
import { CheckIcon, ChevronIcon, NearbyShareIcon } from "../../../shared/ui/icons";
import type { FilePreview } from "../../../types";
import type { FileSendState } from "../hooks/useFileTransfer";
import { isIOS } from "../../../shared/lib/platform";
import { FileAccessNote, SearchingRow } from "./HostCodeView";

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
 * Ways to send the file made last again: the share menu (where there is one) and a saved copy. An
 * iPhone saves from the share sheet (Save to Files), so it gets no separate Save.
 */
function SendAgainLinks({
  what,
  nearbyName,
  canShare,
  busy,
  onShare,
  onSave,
  children,
}: {
  what: "request" | "reply";
  nearbyName: string;
  canShare: boolean;
  busy: boolean;
  onShare: () => void;
  onSave: () => void;
  children?: ReactNode;
}) {
  return (
    <div className="pairing-file-links">
      {canShare ? (
        <button type="button" className="button pairing-nearby-btn" disabled={busy} onClick={onShare}>
          <NearbyShareIcon />
          <span>Send the {what} again by {nearbyName}</span>
        </button>
      ) : null}
      {isIOS() ? null : (
        <button type="button" className="pairing-other-ways" disabled={busy} onClick={onSave}>
          Save the {what} to a file instead
        </button>
      )}
      {children}
    </div>
  );
}

/** Sender: a request arrived; the reply is made and sent by itself. */
export function FileSendView({
  state,
  nearbyName,
  canShare,
  busy,
  onSendReply,
  onShare,
  onSave,
  onBack,
  onDone,
}: {
  state: FileSendState;
  nearbyName: string;
  canShare: boolean;
  busy: boolean;
  /** Makes and sends the reply again, after it failed. */
  onSendReply: () => void;
  onShare: () => void;
  onSave: () => void;
  /** Back to the link code (the request stays open). */
  onBack: () => void;
  onDone: () => void;
}) {
  const steps = [
    "Request received",
    <>Sending {accounts(state.accountCount)} by {nearbyName}</>,
    "Accept on the other device",
  ];
  if (state.replyMade) {
    return (
      <div className="pairing-panel-status pairing-file-view">
        <TransferSteps steps={steps} current={2} />
        <p>
          Choose the other device in {nearbyName}. Once it accepts, the accounts are added there by themselves.
        </p>
        <SendAgainLinks what="reply" nearbyName={nearbyName} canShare={canShare} busy={busy} onShare={onShare} onSave={onSave} />
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
      <TransferSteps steps={steps} current={1} />
      {busy ? (
        <SearchingRow>Encrypting the accounts for the other device…</SearchingRow>
      ) : (
        <div className="pairing-nav-row">
          <BackButton onClick={onBack} />
          <button type="button" className="button primary" onClick={onSendReply}>
            Try Again
          </button>
        </div>
      )}
    </div>
  );
}

/** Receiver: the request went out; the reply is picked up and its accounts added by themselves. */
export function FileReceiveView({
  preview,
  nearbyName,
  automatic,
  openingReply,
  canShare,
  busy,
  fileAccess,
  onOpenReply,
  onShare,
  onSave,
  onBack,
}: {
  preview: FilePreview | null;
  nearbyName: string;
  /** The request went out by itself because the Wi-Fi search found nothing. */
  automatic: boolean;
  /** The open dialog for the reply is up (other steps leave the link's label alone). */
  openingReply: boolean;
  canShare: boolean;
  busy: boolean;
  /** Android, until the app may read Downloads: the way to allow it. */
  fileAccess?: { needed: boolean; onAllow: () => void };
  onOpenReply: () => void;
  onShare: () => void;
  onSave: () => void;
  /** Back to the code entry. */
  onBack: () => void;
}) {
  const steps = [
    <>Request sent by {nearbyName}</>,
    "Waiting for the other device's reply",
    preview ? `Adding ${accounts(preview.accountCount)}` : "Adding the accounts",
  ];
  if (preview) {
    return (
      <div className="pairing-panel-status pairing-file-view">
        <TransferSteps steps={steps} current={2} />
        {busy ? (
          <SearchingRow>Adding {accounts(preview.accountCount)}…</SearchingRow>
        ) : (
          <div className="pairing-nav-row is-single">
            <BackButton onClick={onBack} />
          </div>
        )}
      </div>
    );
  }
  return (
    <div className="pairing-panel-status pairing-file-view">
      <TransferSteps steps={steps} current={1} />
      <p>
        {automatic ? `The other device isn't on this network, so the request went by ${nearbyName}. ` : ""}
        Choose the other device in {nearbyName}. Its reply comes back the same way: tap <strong>Accept</strong> and
        the accounts are added by themselves.
      </p>
      {fileAccess?.needed ? <FileAccessNote name={nearbyName} onAllow={fileAccess.onAllow} /> : null}
      <SendAgainLinks what="request" nearbyName={nearbyName} canShare={canShare} busy={busy} onShare={onShare} onSave={onSave}>
        <button type="button" className="pairing-other-ways" disabled={busy} onClick={onOpenReply}>
          {openingReply ? "Opening…" : "Received the reply but nothing happened? Open it"}
        </button>
      </SendAgainLinks>
      <div className="pairing-nav-row is-single">
        <BackButton onClick={onBack} disabled={busy} />
      </div>
    </div>
  );
}

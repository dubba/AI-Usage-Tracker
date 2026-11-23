import { ChevronIcon } from "../../../shared/ui/icons";
import type { FilePreview } from "../../../types";
import type { FileSendState } from "../hooks/useFileTransfer";

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

/** Ways to send the file made last again: the share menu (where there is one) and a saved copy. */
function SendAgainLinks({
  what,
  canShare,
  busy,
  onShare,
  onSave,
}: {
  what: "request" | "reply";
  canShare: boolean;
  busy: boolean;
  onShare: () => void;
  onSave: () => void;
}) {
  return (
    <div className="pairing-file-links">
      {canShare ? (
        <button type="button" className="pairing-other-ways" disabled={busy} onClick={onShare}>
          Share the {what} again
        </button>
      ) : null}
      <button type="button" className="pairing-other-ways" disabled={busy} onClick={onSave}>
        Save the {what} to a file
      </button>
    </div>
  );
}

/** Sender: agree to answer the opened request, then the reply goes out. */
export function FileSendView({
  state,
  canShare,
  busy,
  onSendReply,
  onShare,
  onSave,
  onBack,
  onDone,
}: {
  state: FileSendState;
  canShare: boolean;
  busy: boolean;
  onSendReply: () => void;
  onShare: () => void;
  onSave: () => void;
  /** Back to the link code (the request stays open). */
  onBack: () => void;
  onDone: () => void;
}) {
  if (state.replyMade) {
    return (
      <div className="pairing-panel-status pairing-file-view">
        <h3>Reply ready</h3>
        <p>
          Send the reply to the other device the same way the request came, by AirDrop, Quick Share or email. On
          that device, choose <strong>Open Reply</strong>.
        </p>
        <SendAgainLinks what="reply" canShare={canShare} busy={busy} onShare={onShare} onSave={onSave} />
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
      <h3>Send {accounts(state.accountCount)}?</h3>
      <p>
        The other device asked for this device's accounts. The reply opens only on the device that entered the
        link code shown here.
      </p>
      <div className="pairing-nav-row">
        <BackButton onClick={onBack} disabled={busy} />
        <button type="button" className="button primary" onClick={onSendReply} disabled={busy}>
          {busy ? "Preparing…" : "Send Reply"}
        </button>
      </div>
    </div>
  );
}

/** Receiver: the request went out; open the reply when it arrives, then agree to add it. */
export function FileReceiveView({
  preview,
  canShare,
  busy,
  onOpenReply,
  onImport,
  onShare,
  onSave,
  onBack,
}: {
  preview: FilePreview | null;
  canShare: boolean;
  busy: boolean;
  onOpenReply: () => void;
  onImport: () => void;
  onShare: () => void;
  onSave: () => void;
  /** Back to the code entry. */
  onBack: () => void;
}) {
  if (preview) {
    return (
      <div className="pairing-panel-status pairing-file-view">
        <h3>Add {accounts(preview.accountCount)}?</h3>
        <p>The reply opened with your link code. Accounts already on this device are skipped.</p>
        <div className="pairing-nav-row">
          <BackButton onClick={onBack} disabled={busy} />
          <button type="button" className="button primary" onClick={onImport} disabled={busy}>
            {busy ? "Adding…" : "Add Accounts"}
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="pairing-panel-status pairing-file-view">
      <h3>Request ready</h3>
      <p>
        Send the request to the other device by AirDrop, Quick Share or email. On that device, choose{" "}
        <strong>Open a request file</strong> under its link code. When its reply comes back, open it here.
      </p>
      <SendAgainLinks what="request" canShare={canShare} busy={busy} onShare={onShare} onSave={onSave} />
      <div className="pairing-nav-row">
        <BackButton onClick={onBack} disabled={busy} />
        <button type="button" className="button primary" onClick={onOpenReply} disabled={busy}>
          {busy ? "Opening…" : "Open Reply…"}
        </button>
      </div>
    </div>
  );
}

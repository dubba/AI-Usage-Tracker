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

/** Sender: agree to answer the opened request, then the reply is saved. */
export function FileSendView({
  state,
  busy,
  onSaveReply,
  onBack,
  onDone,
}: {
  state: FileSendState;
  busy: boolean;
  onSaveReply: () => void;
  /** Back to the link code (the request stays open). */
  onBack: () => void;
  onDone: () => void;
}) {
  if (state.replySaved) {
    return (
      <div className="pairing-panel-status pairing-file-view">
        <h3>Reply saved</h3>
        <p>
          Send the reply file to the other device the same way the request came, by AirDrop, Quick Share or
          email. On that device, choose <strong>Open Reply</strong>.
        </p>
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
        <button type="button" className="button primary" onClick={onSaveReply} disabled={busy}>
          {busy ? "Saving…" : "Save Reply…"}
        </button>
      </div>
    </div>
  );
}

/** Receiver: the request is saved; open the reply when it arrives, then agree to add it. */
export function FileReceiveView({
  preview,
  busy,
  onOpenReply,
  onImport,
  onBack,
}: {
  preview: FilePreview | null;
  busy: boolean;
  onOpenReply: () => void;
  onImport: () => void;
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
      <h3>Request saved</h3>
      <p>
        Send the request file to the other device by AirDrop, Quick Share or email. On that device, choose{" "}
        <strong>Open a request file</strong> under its link code. When its reply comes back, open it here.
      </p>
      <div className="pairing-nav-row">
        <BackButton onClick={onBack} disabled={busy} />
        <button type="button" className="button primary" onClick={onOpenReply} disabled={busy}>
          {busy ? "Opening…" : "Open Reply…"}
        </button>
      </div>
    </div>
  );
}

import { CheckCircleIcon, RefreshIcon, ShieldIcon } from "../../../shared/ui/icons";
import type { IntendedRole } from "../lib/view-model";
import type { SyncSummary } from "../../../types";
import { RoleCards } from "./RoleCards";

/** Simple "something is happening" panels for states the user can only wait through. */

export function ConnectingPanel() {
  return (
    <div className="pairing-panel-status">
      <span className="spinner" />
      <h3>Connecting…</h3>
      <p>Finding the other device on your Wi-Fi and opening an encrypted link.</p>
    </div>
  );
}

export function PeerConnectedPanel() {
  return (
    <div className="pairing-panel-status">
      <span className="spinner" />
      <h3>Connected</h3>
      <p>Waiting for the other device to finish connecting…</p>
    </div>
  );
}

/** Shown while a role chosen in step 1 is being applied. */
export function ApplyingRolePanel({ role }: { role: IntendedRole }) {
  return (
    <div className="pairing-panel-status">
      <span className="spinner" />
      <h3>{role === "send" ? "Sending from this device…" : "Receiving on this device…"}</h3>
      <p>Finishing the connection with the other device.</p>
    </div>
  );
}

export function TransferringPanel() {
  return (
    <div className="pairing-panel-status transferring">
      <span className="spinner large" />
      <h3>Transferring Data…</h3>
      <p>Securely exchanging encrypted accounts and groups over your local network.</p>
    </div>
  );
}

/** Fallback for a connection that reached role selection with no role chosen in step 1. */
export function RoleFallbackView({ busy, onChoose }: { busy: boolean; onChoose: (role: IntendedRole) => void }) {
  return (
    <div className="pairing-role-selection-view">
      <div className="pairing-section-heading">
        <p className="pairing-role-instruction">
          Devices are connected. Choose what this device should do:
        </p>
      </div>
      <RoleCards disabled={busy} onChoose={onChoose} />
    </div>
  );
}

/**
 * The devices are connected and each proved it knows the link code. The sending device asks once
 * before anything moves; the receiving device has nothing to confirm and waits.
 */
export function ConfirmTransferCard({
  isSender,
  accountCount,
  busy,
  confirmed,
  onConfirm,
  onCancel,
}: {
  isSender: boolean;
  accountCount: number | undefined;
  busy: boolean;
  confirmed: boolean;
  /** Sender only: send the accounts. */
  onConfirm: () => void;
  /** Sender: decline. Receiver: stop waiting and end the pairing. */
  onCancel: () => void;
}) {
  const accounts = accountCount === 1 ? "1 account" : `${accountCount ?? ""} accounts`.trim();
  if (!isSender) {
    return (
      <div className="pairing-sas-card">
        <div className="pairing-sas-icon"><ShieldIcon /></div>
        <h3>Waiting for the other device</h3>
        <div className="pairing-transfer-info receiver">
          Ready to <strong>receive {accounts}</strong> and groups
        </div>
        <div className="pairing-sas-waiting-note">
          <span className="spinner button-spinner" />
          <span>Press Send on the other device to start the transfer.</span>
        </div>
        <div className="pairing-sas-actions">
          <button type="button" className="button ghost" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="pairing-sas-card">
      <div className="pairing-sas-icon"><ShieldIcon /></div>
      <h3>Send to the other device?</h3>
      <div className="pairing-transfer-info sender">
        Ready to <strong>send {accounts}</strong> and groups
      </div>
      <p className="pairing-instruction">
        The other device entered this device&apos;s link code, or showed the one you entered.
      </p>

      <div className="pairing-sas-actions">
        <button type="button" className="button primary" disabled={busy || confirmed} onClick={onConfirm}>
          {confirmed ? (
            <>
              <span className="spinner button-spinner" />
              <span>Sending…</span>
            </>
          ) : (
            "Send"
          )}
        </button>
        <button type="button" className="button ghost" disabled={busy || confirmed} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

export function CompletedCard({ summary, onDone }: { summary: SyncSummary; onDone: () => void }) {
  const warnings = summary.warnings ?? [];
  return (
    <div className="pairing-completed-card">
      <div className="pairing-success-icon"><CheckCircleIcon /></div>
      <h3>Transfer Complete!</h3>
      <div className="pairing-summary-chips">
        <span className="pairing-summary-chip added">
          <strong>+{summary.added}</strong> Added
        </span>
        <span className="pairing-summary-chip updated">
          <strong>↻ {summary.updated}</strong> Updated
        </span>
        <span className="pairing-summary-chip skipped">
          <strong>{summary.skipped}</strong> Skipped
        </span>
      </div>
      <p className="pairing-completed-text">
        Your accounts and credentials have been securely synchronized.
      </p>
      {warnings.length > 0 && (
        <div role="alert">
          <p className="pairing-completed-text">The transfer finished, but not everything could be saved on this device:</p>
          <ul>
            {warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </div>
      )}
      <button type="button" className="button primary pairing-done-btn" onClick={onDone}>
        Done
      </button>
    </div>
  );
}

export function FailedCard({ onRetry }: { onRetry: () => void }) {
  // The failure detail renders below the modal footer (see PairingModal), so the
  // card holds only the heading and the retry action.
  return (
    <div className="pairing-error-card" role="alert">
      <h3>Pairing Failed</h3>
      <div className="pairing-error-actions">
        <button type="button" className="button primary" onClick={onRetry}>
          <RefreshIcon />
          <span>Try Again</span>
        </button>
      </div>
    </div>
  );
}

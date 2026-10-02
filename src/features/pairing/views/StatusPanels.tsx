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
      <p>Finishing the connection so both devices can confirm the code.</p>
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

/** Fallback when the devices connected through a pairing link, so no role was chosen up front. */
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

/** Both devices show the same code; the user confirms they match. */
export function SasCard({
  sasCode,
  isSender,
  accountCount,
  busy,
  confirmed,
  onConfirm,
  onDecline,
}: {
  sasCode: string;
  isSender: boolean;
  accountCount: number | undefined;
  busy: boolean;
  confirmed: boolean;
  onConfirm: () => void;
  onDecline: () => void;
}) {
  return (
    <div className="pairing-sas-card">
      <div className="pairing-sas-icon"><ShieldIcon /></div>
      <h3>Do both devices show this code?</h3>

      <div className="pairing-sas-badge" aria-label={`Verification code ${sasCode}`}>
        {sasCode}
      </div>

      <div className={`pairing-transfer-info ${isSender ? "sender" : "receiver"}`}>
        {isSender ? (
          <>Ready to <strong>send {accountCount ?? ""} account(s)</strong> and groups</>
        ) : (
          <>Ready to <strong>receive {accountCount ?? ""} account(s)</strong> and groups</>
        )}
      </div>

      <div className="pairing-sas-actions">
        <button type="button" className="button primary" disabled={busy || confirmed} onClick={onConfirm}>
          {confirmed ? (
            <>
              <span className="spinner button-spinner" />
              <span>Waiting for Other Device…</span>
            </>
          ) : (
            "Yes, Codes Match"
          )}
        </button>
        <button type="button" className="button ghost" disabled={busy || confirmed} onClick={onDecline}>
          Cancel
        </button>
      </div>

      {confirmed && (
        <div className="pairing-sas-waiting-note">
          <span className="spinner button-spinner" />
          <span>Confirmed on this device. Waiting for the other device to confirm…</span>
        </div>
      )}
    </div>
  );
}

export function CompletedCard({ summary, onDone }: { summary: SyncSummary; onDone: () => void }) {
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
      <button type="button" className="button primary pairing-done-btn" onClick={onDone}>
        Done
      </button>
    </div>
  );
}

export function FailedCard({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <div className="pairing-error-card">
      <h3>Pairing Failed</h3>
      <div className="error-panel modal-error">{error}</div>
      <div className="pairing-error-actions">
        <button type="button" className="button primary" onClick={onRetry}>
          <RefreshIcon />
          <span>Try Again</span>
        </button>
      </div>
    </div>
  );
}

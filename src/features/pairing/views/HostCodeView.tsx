import type { PairingStatus } from "../../../types";
import { formatCountdown, formatJoinCode, hostWaitingFields } from "../lib/view-model";

/** The link code this device shows for the other one to type in. */
export function HostCodeView({
  status,
  remainingSecs,
  onRegenerate,
}: {
  status: PairingStatus;
  remainingSecs: number | null;
  /** The countdown hit zero; start a fresh session and code. */
  onRegenerate: () => void;
}) {
  const host = hostWaitingFields(status);
  const joinCode = host?.joinCode ?? "";
  if (!host?.qrSvg && !joinCode) {
    return (
      <div className="pairing-panel-status">
        <span className="spinner" />
        <h3>Starting pairing session…</h3>
        <p>Preparing a link code for the other device.</p>
      </div>
    );
  }

  if (remainingSecs === 0) {
    return (
      <div className="pairing-panel-status">
        <h3>This link code expired</h3>
        <p>The other device didn't connect in time. Generate a new code to try the connection again.</p>
        <button type="button" className="button primary" onClick={onRegenerate}>
          Generate New Code
        </button>
      </div>
    );
  }

  return (
    <div className="pairing-host-content">
      {joinCode ? (
        <div className="pairing-join-code-card" aria-label={`Link code ${formatJoinCode(joinCode)}`}>
          <span className="pairing-join-code-tag">LINK CODE</span>
          <strong className="pairing-join-code-val">{formatJoinCode(joinCode)}</strong>
        </div>
      ) : null}

      {remainingSecs !== null && (
        <div className="pairing-meta-row">
          <span className="pairing-meta-tag timer">
            Expires in <strong>{formatCountdown(remainingSecs)}</strong>
          </span>
        </div>
      )}

      <div className="pairing-waiting-indicator">
        <span className="spinner" />
        <span>Waiting for the other device to connect…</span>
      </div>
    </div>
  );
}

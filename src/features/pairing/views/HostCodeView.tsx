import type { PairingStatus } from "../../../types";
import { formatCountdown, formatJoinCode, hostWaitingFields } from "../lib/view-model";

/** The link code this device shows for the other one to type in. */
export function HostCodeView({ status, remainingSecs }: { status: PairingStatus; remainingSecs: number | null }) {
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

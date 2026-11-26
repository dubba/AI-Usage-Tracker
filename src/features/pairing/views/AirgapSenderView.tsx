import { DialogError } from "../../../shared/ui/DialogError";
import { ArrowLeftIcon, PauseIcon, PlayIcon } from "../../../shared/ui/icons";
import type { AirgapSpeed } from "../hooks/useAirgapPlayer";
import { QR_QUIET_ZONE, qrPath } from "../lib/qr-path";
import type { AirgapExport, QrMatrix } from "../../../types";

const RECORDING_WARNING =
  "A photo or screen recording of these frames can decrypt the accounts in this transfer.";

/** One QR code, black on white, drawn from its modules (the card sets its size on screen). */
function QrCodeImage({ qr }: { qr: QrMatrix }) {
  const extent = qr.size + 2 * QR_QUIET_ZONE;
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox={`0 0 ${extent} ${extent}`} shapeRendering="crispEdges" aria-hidden="true">
      <rect width={extent} height={extent} fill="#ffffff" />
      <path fill="#000000" d={qrPath(qr)} />
    </svg>
  );
}

/** The animated QR code an air-gap sender shows for the other device to scan. */
export function AirgapSenderView({
  exportData,
  busy,
  error,
  onDismissError,
  frameIndex,
  playing,
  speed,
  onTogglePlaying,
  onToggleSpeed,
  onDone,
  onRetry,
  onBack,
}: {
  exportData: AirgapExport | null;
  busy: boolean;
  /** Preparing the export failed; the raw detail of the error. */
  error: string | null;
  /** The X on the error banner. */
  onDismissError: () => void;
  frameIndex: number;
  playing: boolean;
  speed: AirgapSpeed;
  onTogglePlaying: () => void;
  onToggleSpeed: () => void;
  /** The other device has the accounts; close the dialog. */
  onDone: () => void;
  /** Preparing failed; run the export again. */
  onRetry: () => void;
  onBack: () => void;
}) {
  const failed = !busy && !exportData;
  return (
    <div className="airgap-sender-view">
      {failed ? (
        <div className="pairing-panel-status" role="alert">
          <h3>Couldn't prepare the transfer</h3>
          <div className="pairing-nav-row">
            <button type="button" className="button ghost button-tertiary pairing-back-btn" onClick={onBack}>
              <ArrowLeftIcon />
              <span>Back</span>
            </button>
            <button type="button" className="button primary" onClick={onRetry}>
              Try Again
            </button>
          </div>
          {error ? <DialogError message={error} onDismiss={onDismissError} /> : null}
        </div>
      ) : busy || !exportData ? (
        <div className="pairing-panel-status">
          <span className="spinner" />
          <h3>Preparing animated transfer…</h3>
          <p className="pairing-instruction">{RECORDING_WARNING}</p>
        </div>
      ) : (
        <div className="airgap-sender-content">
          <div className="airgap-qr-stage">
            <div
              className="pairing-qr-card airgap-qr-card"
              aria-label={`Air-gap Frame ${frameIndex + 1} of ${exportData.totalChunks}`}
            >
              {exportData.frames[frameIndex] ? <QrCodeImage qr={exportData.frames[frameIndex].qr} /> : null}
            </div>

            <div className="airgap-playback-bar">
              <span className="airgap-frame-pill">
                Frame {String(frameIndex + 1).padStart(String(exportData.totalChunks).length, "0")}/{exportData.totalChunks}
              </span>
              <button
                type="button"
                className="button primary compact-button airgap-control-btn airgap-play-btn"
                onClick={onTogglePlaying}
                aria-label={playing ? "Pause animation" : "Play animation"}
              >
                {playing ? <PauseIcon /> : <PlayIcon />}
                <span>{playing ? "Pause" : "Play"}</span>
              </button>
              <button
                type="button"
                className="button ghost compact-button airgap-control-btn"
                onClick={onToggleSpeed}
                aria-label="Toggle playback speed"
              >
                Speed: {speed === "normal" ? "Normal" : "Slow"}
              </button>
            </div>
          </div>

          <div className="airgap-verify-block">
            <p className="pairing-instruction">{RECORDING_WARNING}</p>
            <p className="pairing-instruction">
              When the other device has scanned every frame, it asks there to add the accounts.
            </p>
            <div className="pairing-nav-row">
              <button type="button" className="button ghost button-tertiary pairing-back-btn" onClick={onBack}>
                <ArrowLeftIcon />
                <span>Back</span>
              </button>
              <button type="button" className="button primary" onClick={onDone}>
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

import { ChevronIcon, PauseIcon, PlayIcon } from "../../../shared/ui/icons";
import type { AirgapSpeed } from "../hooks/useAirgapPlayer";
import { sanitizeQrSvg } from "../lib/sanitizeSvg";
import type { AirgapExport } from "../../../types";

const RECORDING_WARNING =
  "A photo or screen recording of these frames can decrypt the accounts in this transfer.";

/** The animated QR code an air-gap sender shows for the other device to scan. */
export function AirgapSenderView({
  exportData,
  busy,
  frameIndex,
  playing,
  speed,
  onTogglePlaying,
  onToggleSpeed,
  onContinue,
  onBack,
  onCancel,
}: {
  exportData: AirgapExport | null;
  busy: boolean;
  frameIndex: number;
  playing: boolean;
  speed: AirgapSpeed;
  onTogglePlaying: () => void;
  onToggleSpeed: () => void;
  /** All frames were scanned; move on to comparing codes. */
  onContinue: () => void;
  onBack: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="airgap-sender-view">
      {busy || !exportData ? (
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
              dangerouslySetInnerHTML={{
                __html: sanitizeQrSvg(exportData.frames[frameIndex]?.svg || ""),
              }}
              aria-label={`Air-gap Frame ${frameIndex + 1} of ${exportData.totalChunks}`}
            />

            <div className="airgap-playback-bar">
              <span className="airgap-frame-pill">
                Frame {String(frameIndex + 1).padStart(String(exportData.totalChunks).length, "0")}/{exportData.totalChunks}
              </span>
              <button
                type="button"
                className="button ghost compact-button airgap-control-btn"
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
            <p className="airgap-pin-hint">
              <button type="button" className="pairing-offline-link" onClick={onContinue}>
                After all frames are scanned, click here to continue.
              </button>
            </p>
            <div className="pairing-nav-row">
              <button type="button" className="button pairing-back-btn" onClick={onBack}>
                <ChevronIcon style={{ transform: "rotate(180deg)" }} />
                <span>Back</span>
              </button>
              <button type="button" className="button ghost" onClick={onCancel}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

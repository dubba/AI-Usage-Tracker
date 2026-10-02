import type { RefObject } from "react";
import { ChevronIcon, FlipCameraIcon, ShieldIcon } from "../../../shared/ui/icons";

export interface ScannerViewProps {
  airgapVerifyPrompt: boolean;
  airgapTotalChunks: number;
  airgapCaptureSecs: number | null;
  airgapVerifying: boolean;
  airgapVerifyCode: string | null;
  airgapImporting: boolean;
  airgapCapturedChunks: Map<number, string>;
  cameraError: string | null;
  isFrontCamera: boolean;
  videoReady: boolean;
  showSwitchCamera: boolean;
  videoRef: RefObject<HTMLVideoElement | null>;
  setVideoReady: (ready: boolean) => void;
  onScannerTap: () => void;
  onSwitchCamera: () => void;
  onAirgapBack: () => void;
  onAirgapImport: () => void;
  onBack: () => void;
}

export function ScannerView({
  airgapVerifyPrompt,
  airgapTotalChunks,
  airgapCaptureSecs,
  airgapVerifying,
  airgapVerifyCode,
  airgapImporting,
  airgapCapturedChunks,
  cameraError,
  isFrontCamera,
  videoReady,
  showSwitchCamera,
  videoRef,
  setVideoReady,
  onScannerTap,
  onSwitchCamera,
  onAirgapBack,
  onAirgapImport,
  onBack,
}: ScannerViewProps) {
  return (
    <div className="pairing-scanner-view">
      {airgapVerifyPrompt ? (
        <div className="airgap-pin-prompt-card">
          <div className="pairing-sas-icon"><ShieldIcon /></div>
          <h3>Do both devices show this code?</h3>
          <p className="pairing-instruction">
            Captured all {airgapTotalChunks} frames{airgapCaptureSecs !== null ? ` in ${airgapCaptureSecs} seconds` : ""}! Compare this code with the sending device. If they match, the transfer is intact.
          </p>

          {airgapVerifying || !airgapVerifyCode ? (
            <div className="pairing-panel-status">
              <span className="spinner" />
              <p>Assembling scanned frames…</p>
            </div>
          ) : (
            <div
              className="pairing-sas-badge"
              aria-label={`Verification code ${airgapVerifyCode}`}
            >
              {airgapVerifyCode}
            </div>
          )}

          <div className="airgap-prompt-actions">
            <button
              type="button"
              className="button pairing-back-btn"
              disabled={airgapImporting || airgapVerifying}
              onClick={onAirgapBack}
            >
              <ChevronIcon style={{ transform: "rotate(180deg)" }} />
              <span>Back</span>
            </button>
            <button
              type="button"
              className="button primary"
              disabled={!airgapVerifyCode || airgapImporting || airgapVerifying}
              onClick={onAirgapImport}
            >
              {airgapImporting ? (
                <>
                  <span className="spinner button-spinner" />
                  <span>Decrypting &amp; Importing…</span>
                </>
              ) : (
                <span>Yes, They Match</span>
              )}
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="pairing-scanner-stage">
            <span className="pairing-scanner-gutter" aria-hidden="true" />
            <div
              className="pairing-scanner-box"
              role="button"
              tabIndex={0}
              onClick={onScannerTap}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onScannerTap();
                }
              }}
              aria-label="Tap to focus camera"
            >
              <video
                ref={videoRef}
                autoPlay
                playsInline
                muted
                tabIndex={-1}
                onPlaying={() => setVideoReady(true)}
                onLoadedData={() => setVideoReady(true)}
                className={`pairing-scanner-video ${isFrontCamera ? "mirrored" : ""} ${videoReady ? "ready" : ""}`}
                style={{ pointerEvents: "none" }}
              />
              <div className="pairing-scanner-overlay">
                <div className="pairing-scanner-frame">
                  <span className="corner top-left" />
                  <span className="corner top-right" />
                  <span className="corner bottom-left" />
                  <span className="corner bottom-right" />
                  <div className="pairing-scan-beam" />
                </div>
              </div>
            </div>

            <div className="pairing-scanner-side">
              {showSwitchCamera && (
                <button
                  type="button"
                  className="pairing-switch-camera-fab"
                  onClick={onSwitchCamera}
                  data-tooltip="Switch camera"
                  aria-label="Switch camera"
                >
                  <FlipCameraIcon />
                </button>
              )}
            </div>
          </div>

          {airgapCapturedChunks.size > 0 && (
            <div className="airgap-capture-status">
              <div className="airgap-capture-header">
                <span className="spinner button-spinner" />
                <span>Transferring…</span>
                <strong>
                  {airgapCapturedChunks.size} / {airgapTotalChunks} frames (
                  {Math.round((airgapCapturedChunks.size / Math.max(1, airgapTotalChunks)) * 100)}%)
                </strong>
              </div>
              <div className="airgap-progress-bar">
                <div
                  className="airgap-progress-fill"
                  style={{
                    width: `${(airgapCapturedChunks.size / Math.max(1, airgapTotalChunks)) * 100}%`,
                  }}
                />
              </div>
              <p className="airgap-capture-hint">Hold steady while camera reads all animated frames.</p>
            </div>
          )}

          <div className="pairing-scanner-controls pairing-scan-actions">
            <button
              type="button"
              className="button pairing-back-btn"
              onClick={onBack}
            >
              <ChevronIcon style={{ transform: "rotate(180deg)" }} />
              <span>Back</span>
            </button>
          </div>

          {cameraError && (
            <div className="error-panel modal-error">{cameraError}</div>
          )}
        </>
      )}
    </div>
  );
}

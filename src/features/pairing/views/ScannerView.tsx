import type { RefObject } from "react";
import { ArrowLeftIcon, FlipCameraIcon, ShieldIcon } from "../../../shared/ui/icons";

export interface ScannerViewProps {
  airgapVerifyPrompt: boolean;
  airgapTotalChunks: number;
  airgapCaptureSecs: number | null;
  airgapVerifying: boolean;
  /** Accounts in the complete capture, once the backend has opened it. */
  airgapAccountCount: number | null;
  airgapImporting: boolean;
  airgapCapturedChunks: Map<number, string>;
  cameraError: string | null;
  /** Camera failed; keeps Retry Camera visible until retried. */
  cameraFailed: boolean;
  isFrontCamera: boolean;
  videoReady: boolean;
  showSwitchCamera: boolean;
  videoRef: RefObject<HTMLVideoElement | null>;
  setVideoReady: (ready: boolean) => void;
  onScannerTap: () => void;
  onSwitchCamera: () => void;
  /** The camera could not start; try opening it again. */
  onRetryCamera: () => void;
  onAirgapBack: () => void;
  onAirgapImport: () => void;
  onBack: () => void;
}

export function ScannerView({
  airgapVerifyPrompt,
  airgapTotalChunks,
  airgapCaptureSecs,
  airgapVerifying,
  airgapAccountCount,
  airgapImporting,
  airgapCapturedChunks,
  cameraError,
  cameraFailed,
  isFrontCamera,
  videoReady,
  showSwitchCamera,
  videoRef,
  setVideoReady,
  onScannerTap,
  onSwitchCamera,
  onRetryCamera,
  onAirgapBack,
  onAirgapImport,
  onBack,
}: ScannerViewProps) {
  return (
    <div className="pairing-scanner-view">
      {airgapVerifyPrompt ? (
        <div className="airgap-pin-prompt-card">
          <div className="pairing-sas-icon"><ShieldIcon /></div>
          <p className="pairing-instruction airgap-capture-summary">
            Captured all {airgapTotalChunks} frames{airgapCaptureSecs !== null ? ` in ${airgapCaptureSecs} seconds` : ""}!
          </p>
          {airgapVerifying || airgapAccountCount === null ? (
            <div className="pairing-panel-status">
              <span className="spinner" />
              <p>Assembling scanned frames…</p>
            </div>
          ) : (
            <>
              <h3>Add {accountsText(airgapAccountCount)} from the other device?</h3>
              <p className="pairing-instruction">
                Accounts already on this device are kept as they are.
              </p>
            </>
          )}

          <div className="airgap-prompt-actions">
            <button
              type="button"
              className="button ghost pairing-back-btn"
              disabled={airgapImporting || airgapVerifying}
              onClick={onAirgapBack}
            >
              <ArrowLeftIcon />
              <span>Back</span>
            </button>
            <button
              type="button"
              className="button primary"
              disabled={airgapAccountCount === null || airgapImporting || airgapVerifying}
              onClick={onAirgapImport}
            >
              {airgapImporting ? (
                <>
                  <span className="spinner button-spinner" />
                  <span>Adding…</span>
                </>
              ) : (
                <span>Add Accounts</span>
              )}
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="pairing-scanner-stage">
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
                  {/* The beam means "the camera is reading codes now" — show it only while that is true. */}
                  {videoReady && !cameraError && !cameraFailed ? <div className="pairing-scan-beam" /> : null}
                </div>
              </div>
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
              className="button primary pairing-back-btn"
              onClick={onBack}
            >
              <ArrowLeftIcon />
              <span>Back</span>
            </button>

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

          {(cameraError || cameraFailed) && (
            <div className="error-panel modal-error pairing-camera-error" role="alert">
              {cameraError ? <span>{cameraError}</span> : null}
              <button type="button" className="button ghost compact-button" onClick={onRetryCamera}>
                Retry Camera
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** "1 account", "3 accounts". */
function accountsText(count: number): string {
  return count === 1 ? "1 account" : `${count} accounts`;
}

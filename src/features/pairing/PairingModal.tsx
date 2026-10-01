import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { cancelPairing, pairingApi } from "../../shared/lib/api";
import { ChevronIcon } from "../../shared/ui/icons";
import { useAirgapCapture } from "./hooks/useAirgapCapture";
import { useAirgapPlayer } from "./hooks/useAirgapPlayer";
import { usePairingStatus } from "./hooks/usePairingStatus";
import { useQrScanner } from "./hooks/useQrScanner";
import { useVirtualKeyboard } from "../../shared/hooks/useVirtualKeyboard";
import { logIgnored } from "../../shared/lib/log";
import { isMobileDevice } from "../../shared/lib/platform";
import { flowReducer, INITIAL_FLOW } from "./lib/flow-state";
import {
  hasOwnActionButtons as viewHasOwnActionButtons,
  isWaitingStatus,
  pairingHeader,
  sasFields,
  type ActiveFlow,
  type IntendedRole,
  type ViewMode,
} from "./lib/view-model";
import { collectUiState } from "../dashboard/ui-state";
import { useModalA11y } from "../../shared/hooks/useModalA11y";
import { ModalCloseButton } from "../../shared/ui/ModalCloseButton";
import { AirgapConfirmView } from "./views/AirgapConfirmView";
import { AirgapSenderView } from "./views/AirgapSenderView";
import { CodeEntryView } from "./views/CodeEntryView";
import { HostCodeView } from "./views/HostCodeView";
import { ModeSelectView } from "./views/ModeSelectView";
import { RoleSelectView } from "./views/RoleSelectView";
import { ScannerView } from "./views/ScannerView";
import {
  ApplyingRolePanel,
  CompletedCard,
  ConnectingPanel,
  FailedCard,
  PeerConnectedPanel,
  RoleFallbackView,
  SasCard,
  TransferringPanel,
} from "./views/StatusPanels";
import type { AirgapExport } from "../../types";

export function PairingModal({
  open,
  initialJoinUri,
  onClose,
  onCompleted,
}: {
  open: boolean;
  initialJoinUri?: string | null;
  onClose: () => void;
  onCompleted: () => void;
}) {
  const [{ viewMode, activeFlow, intendedRole }, dispatchFlow] = useReducer(flowReducer, INITIAL_FLOW);
  const showView = useCallback(
    (view: ViewMode, flow?: ActiveFlow) => dispatchFlow({ type: "show", view, flow }),
    [],
  );
  const { status, setStatus, remainingSecs, hasCompletedRef } = usePairingStatus(open);
  const [joinCodeInput, setJoinCodeInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [confirmedSas, setConfirmedSas] = useState(false);
  const [includeSettings, setIncludeSettings] = useState(false);
  const [isFrontCamera, setIsFrontCamera] = useState(false);
  const [videoReady, setVideoReady] = useState(false);
  const [availableCameras, setAvailableCameras] = useState<MediaDeviceInfo[]>([]);
  const [, setSelectedCameraId] = useState<string | null>(null);
  const [isKeyboardOpen, setIsKeyboardOpen] = useVirtualKeyboard(open);
  const [airgapExport, setAirgapExport] = useState<AirgapExport | null>(null);
  const [scannerRestartKey, setScannerRestartKey] = useState(0);

  const dialogRef = useRef<HTMLElement>(null);
  const hostStartIdRef = useRef(0);
  const roleAutoSelectedRef = useRef(false);

  const player = useAirgapPlayer(airgapExport, viewMode === "airgap-sender");
  const capture = useAirgapCapture({
    active: open && viewMode === "scanner",
    onVerifyStart: () => setErrorMessage(null),
    onVerifyError: setErrorMessage,
    onRescan: () => setScannerRestartKey((key) => key + 1),
  });

  const { videoRef, streamRef, handleScannerTap, handleSwitchCamera } = useQrScanner({
    active: viewMode === "scanner" && open,
    restartKey: scannerRestartKey,
    isFrontCamera,
    availableCameras,
    hostStartIdRef,
    airgapSessionIdRef: capture.sessionIdRef,
    airgapVerifyPromptRef: capture.verifyPromptRef,
    airgapCaptureStartRef: capture.captureStartRef,
    setViewMode: showView,
    setBusy,
    setErrorMessage,
    setCameraError,
    setVideoReady,
    setAvailableCameras,
    setSelectedCameraId,
    setIsFrontCamera,
    setAirgapCapturedChunks: capture.setChunks,
    setAirgapTotalChunks: capture.setTotal,
    setAirgapCaptureSecs: capture.setCaptureSecs,
    setAirgapPinPrompt: capture.setVerifyPrompt,
  });

  const stopCamera = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
  };

  const handleClose = () => {
    stopCamera();
    if (status.status === "completed" && !hasCompletedRef.current) {
      hasCompletedRef.current = true;
      onCompleted();
    }
    cancelPairing();
    onClose();
  };

  useModalA11y(dialogRef, open, handleClose);

  useEffect(() => {
    if (
      status.status === "sasVerification" ||
      status.status === "roleSelection" ||
      status.status === "failed" ||
      status.status === "transferring" ||
      status.status === "completed" ||
      status.status === "peerConnected"
    ) {
      setBusy(false);
    }
    if (status.status !== "sasVerification") {
      setConfirmedSas(false);
    }
    if (status.status === "completed") {
      if (!hasCompletedRef.current) {
        hasCompletedRef.current = true;
        onCompleted();
      }
    }
  }, [status.status, onCompleted, hasCompletedRef]);

  // Apply the role chosen in step 1 as soon as the devices have connected.
  useEffect(() => {
    if (!open) return;
    if (status.status !== "roleSelection") {
      roleAutoSelectedRef.current = false;
      return;
    }
    if (!intendedRole || roleAutoSelectedRef.current) return;
    roleAutoSelectedRef.current = true;
    setBusy(true);
    setErrorMessage(null);
    void pairingApi.selectRole(intendedRole).catch((err) => {
      setErrorMessage(String(err));
      roleAutoSelectedRef.current = false;
      setBusy(false);
    });
  }, [open, status.status, intendedRole]);

  // Focus management when the view or status changes so focus doesn't get lost
  useEffect(() => {
    if (!open) return;
    const container = dialogRef.current;
    if (!container) return;

    const timer = setTimeout(() => {
      if (!container.isConnected) return;
      if (!container.contains(document.activeElement)) {
        if (viewMode === "code") {
          const input = container.querySelector<HTMLInputElement>("#pairing-join-code-input");
          if (input) {
            input.focus({ preventScroll: true });
            return;
          }
        }
        const first = Array.from(
          container.querySelectorAll<HTMLElement>(
            "button:not([disabled]):not(.ui-modal-close), input:not([disabled])"
          )
        ).find((el) => el.offsetParent !== null);
        if (first) {
          first.focus({ preventScroll: true });
        } else {
          container.focus({ preventScroll: true });
        }
      }
    }, 50);

    return () => clearTimeout(timer);
  }, [viewMode, status.status, open]);

  // Start showing a link code. A newer start (or leaving the view) makes an older one's result moot.
  const initHostSession = async () => {
    const startId = ++hostStartIdRef.current;
    setBusy(true);
    setErrorMessage(null);
    try {
      const init = await pairingApi.startHost();
      if (startId !== hostStartIdRef.current) return;
      setStatus({
        status: "hostWaiting",
        data: {
          sessionId: init.sessionId,
          qrSvg: init.qrSvg,
          qrUri: init.qrUri,
          fingerprint: init.fingerprint,
          joinCode: init.joinCode,
          expiresAt: init.expiresAt,
        },
      });
    } catch (err) {
      if (startId !== hostStartIdRef.current) return;
      setErrorMessage(String(err));
    } finally {
      if (startId === hostStartIdRef.current) setBusy(false);
    }
  };

  // On open: join straight away if a pairing link is waiting; on close: forget everything.
  useEffect(() => {
    if (!open) {
      hasCompletedRef.current = false;
      setStatus({ status: "idle" });
      setErrorMessage(null);
      setJoinCodeInput("");
      dispatchFlow({ type: "reset" });
      roleAutoSelectedRef.current = false;
      setBusy(false);
      setConfirmedSas(false);
      setIncludeSettings(false);
      setIsFrontCamera(false);
      setSelectedCameraId(null);
      setAvailableCameras([]);
      setAirgapExport(null);
      capture.resetAll();
      hostStartIdRef.current += 1;
      stopCamera();
      return;
    }

    const checkPendingAndStart = async () => {
      let pendingUri: string | null = initialJoinUri || null;
      if (!pendingUri) {
        try {
          pendingUri = await Promise.race([
            pairingApi.getPendingPairingUri().catch((cause) => {
              logIgnored("pending pairing uri", cause);
              return null;
            }),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), 1500)),
          ]);
        } catch (cause) {
          logIgnored("pending pairing uri", cause);
        }
      }

      if (
        pendingUri &&
        (pendingUri.startsWith("aiusage-pair:") || pendingUri.startsWith("aiusage:"))
      ) {
        hostStartIdRef.current += 1;
        dispatchFlow({ type: "set-flow", flow: "wifi" });
        setBusy(true);
        setStatus({ status: "clientConnecting", data: { sessionId: "" } });
        try {
          await pairingApi.startClient(pendingUri);
        } catch (err) {
          setBusy(false);
          const msg = err instanceof Error ? err.message : String(err);
          setErrorMessage(msg);
          setStatus({
            status: "failed",
            data: { error: msg },
          });
        }
        return;
      }

      // Normal modal open: wait on Step 1 for the user to choose a role
    };

    void checkPendingAndStart();
  }, [open, initialJoinUri]);

  if (!open) return null;

  const handleConnectByCode = async (code: string) => {
    const digits = code.replace(/\D/g, "").slice(0, 6);
    if (digits.length !== 6 || busy) return;
    hostStartIdRef.current += 1;
    setBusy(true);
    setErrorMessage(null);
    try {
      await pairingApi.startClientByCode(digits);
    } catch (err) {
      setErrorMessage(String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleSelectRole = async (role: IntendedRole) => {
    setBusy(true);
    setErrorMessage(null);
    try {
      await pairingApi.selectRole(role);
    } catch (err) {
      setErrorMessage(String(err));
      roleAutoSelectedRef.current = false;
      setBusy(false);
    }
  };

  const startAirgapSender = async (includeSettingsOpt?: boolean) => {
    stopCamera();
    setBusy(true);
    setErrorMessage(null);
    showView("airgap-sender");
    try {
      const shouldInclude = includeSettingsOpt ?? includeSettings;
      const ui = shouldInclude ? collectUiState() : undefined;
      const exp = await pairingApi.prepareAirgapExport(shouldInclude, ui);
      setAirgapExport(exp);
      player.restart();
    } catch (err) {
      setErrorMessage(String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleAirgapImport = async () => {
    if (capture.importing || !capture.verifyCode) return;
    capture.setImporting(true);
    setErrorMessage(null);
    try {
      const chunks = Array.from(capture.chunks.values());
      const summary = await pairingApi.importAirgapFrames(chunks);
      hasCompletedRef.current = true;
      capture.closePrompt();
      stopCamera();
      setStatus({
        status: "completed",
        data: { summary },
      });
      onCompleted();
    } catch (err) {
      setErrorMessage(String(err));
    } finally {
      capture.setImporting(false);
    }
  };

  const handleConfirmSas = async (sessionId: string, confirmed: boolean, role?: string) => {
    if (confirmed) {
      setConfirmedSas(true);
    }
    setBusy(true);
    try {
      if (confirmed) {
        const shouldInclude = role === "sender" && includeSettings;
        try {
          await pairingApi.setIncludeSettings(shouldInclude);
          if (shouldInclude) {
            await pairingApi.setPendingUiState(collectUiState());
          } else {
            await pairingApi.clearPendingUiState();
          }
        } catch (cause) {
          // Pairing can still complete; the other device just won't receive settings or layout.
          logIgnored("pairing settings transfer", cause);
        }
      }
      await pairingApi.confirmSas(sessionId, confirmed);
    } catch (err) {
      setErrorMessage(String(err));
      setConfirmedSas(false);
    } finally {
      setBusy(false);
    }
  };

  const handleDone = () => {
    if (!hasCompletedRef.current) {
      hasCompletedRef.current = true;
      onCompleted();
    }
    handleClose();
  };

  /** Abandon the current attempt and return to choosing how to connect. */
  const backToModes = (clearError = false) => {
    cancelPairing();
    if (clearError) setErrorMessage(null);
    setStatus({ status: "idle" });
    showView("select-mode", null);
  };

  const isWaitingState = isWaitingStatus(status.status);
  const hasOwnActionButtons = viewHasOwnActionButtons(status.status, viewMode);
  const showSwitchCamera = availableCameras.length > 1 || isMobileDevice() || Boolean(import.meta.env?.DEV);
  const { title: modalTitle, subtitle: modalSubtitle, step, showStepDots } = pairingHeader({
    status: status.status,
    viewMode,
    activeFlow,
    intendedRole,
    airgapVerifyPrompt: capture.verifyPrompt,
  });
  const sas = sasFields(status);

  return (
    <div
      className={`modal-backdrop ${isKeyboardOpen ? "keyboard-open" : ""}`}
      role="presentation"
      onMouseDown={(e) => e.target === e.currentTarget && handleClose()}
    >
      <section
        ref={dialogRef}
        className={`modal-card pairing-modal ${
          isWaitingState && viewMode === "code" ? "view-code-entry" : ""
        } ${isKeyboardOpen ? "keyboard-open" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="pairing-modal-title"
        tabIndex={-1}
      >
        <ModalCloseButton onClose={handleClose} disabled={status.status === "transferring"} />
        <div className="modal-kicker">Local Device Sync</div>
        <h2 id="pairing-modal-title">{modalTitle}</h2>
        {showStepDots ? (
          <ol className="pairing-step-dots" aria-label={`Step ${step} of 3`}>
            <li className={step === 1 ? "is-active" : step > 1 ? "is-complete" : ""}>Send/receive</li>
            <li className={step === 2 ? "is-active" : step > 2 ? "is-complete" : ""}>Connect</li>
            <li className={step === 3 ? "is-active" : ""}>Confirm</li>
          </ol>
        ) : null}
        <p className="pairing-subtitle">{modalSubtitle}</p>

        <div className="pairing-body">
          {isWaitingState && viewMode === "select-role" && (
            <RoleSelectView
              includeSettings={includeSettings}
              onIncludeSettingsChange={setIncludeSettings}
              onChoose={(role) => dispatchFlow({ type: "choose-role", role })}
            />
          )}

          {isWaitingState && viewMode === "select-mode" && (
            <ModeSelectView
              intendedRole={intendedRole}
              onShowCode={() => {
                showView("host", "wifi");
                void initHostSession();
              }}
              onEnterCode={() => {
                showView("code", "wifi");
                setJoinCodeInput("");
              }}
              onShowQr={() => {
                dispatchFlow({ type: "set-flow", flow: "airgap" });
                void startAirgapSender();
              }}
              onScan={() => {
                dispatchFlow({ type: "set-flow", flow: "wifi" });
                setCameraError(null);
                void pairingApi.ensureCameraPermission()
                  .catch((cause) => logIgnored("pairing.cameraPermission", cause))
                  .finally(() => showView("scanner"));
              }}
            />
          )}

          {isWaitingState && viewMode === "host" && <HostCodeView status={status} remainingSecs={remainingSecs} />}

          {isWaitingState && viewMode === "scanner" && (
            <ScannerView
              airgapVerifyPrompt={capture.verifyPrompt}
              airgapTotalChunks={capture.total}
              airgapCaptureSecs={capture.captureSecs}
              airgapVerifying={capture.verifying}
              airgapVerifyCode={capture.verifyCode}
              airgapImporting={capture.importing}
              airgapCapturedChunks={capture.chunks}
              cameraError={cameraError}
              isFrontCamera={isFrontCamera}
              videoReady={videoReady}
              showSwitchCamera={showSwitchCamera}
              videoRef={videoRef}
              setVideoReady={setVideoReady}
              onScannerTap={() => void handleScannerTap()}
              onSwitchCamera={() => void handleSwitchCamera()}
              onAirgapBack={() => {
                capture.rescan();
                showView("scanner");
                setScannerRestartKey((key) => key + 1);
              }}
              onAirgapImport={() => void handleAirgapImport()}
              onBack={() => {
                if (activeFlow === "airgap") {
                  showView("airgap-sender");
                  return;
                }
                capture.clearCapture();
                backToModes();
              }}
            />
          )}

          {isWaitingState && viewMode === "code" && (
            <CodeEntryView
              value={joinCodeInput}
              busy={busy}
              onChange={setJoinCodeInput}
              onSubmit={() => void handleConnectByCode(joinCodeInput)}
              onBack={() => showView("select-mode")}
              setKeyboardOpen={setIsKeyboardOpen}
            />
          )}

          {isWaitingState && viewMode === "airgap-sender" && (
            <AirgapSenderView
              exportData={airgapExport}
              busy={busy}
              frameIndex={player.frameIndex}
              playing={player.playing}
              speed={player.speed}
              onTogglePlaying={player.togglePlaying}
              onToggleSpeed={player.toggleSpeed}
              onContinue={() => showView("airgap-confirm")}
              onBack={() => {
                setAirgapExport(null);
                capture.clearCapture();
                showView("select-mode", null);
              }}
              onCancel={handleClose}
            />
          )}

          {isWaitingState && viewMode === "airgap-confirm" && airgapExport && (
            <AirgapConfirmView
              verifyCode={airgapExport.verifyCode}
              onBack={() => showView("airgap-sender")}
              onCancel={handleClose}
            />
          )}

          {(status.status === "clientConnecting" || status.status === "senderConnecting") && <ConnectingPanel />}

          {status.status === "peerConnected" && <PeerConnectedPanel />}

          {/* Role selection is applied automatically when chosen in step 1; this is the fallback for devices that joined through a pairing link. */}
          {status.status === "roleSelection" && !intendedRole && (
            <RoleFallbackView busy={busy} onChoose={(role) => void handleSelectRole(role)} />
          )}

          {status.status === "roleSelection" && intendedRole && <ApplyingRolePanel role={intendedRole} />}

          {sas && (
            <SasCard
              sasCode={sas.sasCode}
              isSender={sas.isSender}
              accountCount={sas.accountCount}
              busy={busy}
              confirmed={confirmedSas}
              onConfirm={() => void handleConfirmSas(sas.sessionId, true, sas.role)}
              onDecline={() => void handleConfirmSas(sas.sessionId, false, sas.role)}
            />
          )}

          {status.status === "transferring" && <TransferringPanel />}

          {status.status === "completed" && <CompletedCard summary={status.data.summary} onDone={handleDone} />}

          {status.status === "failed" && (
            <FailedCard
              error={status.data.error}
              onRetry={() => {
                setErrorMessage(null);
                if (activeFlow === "airgap") {
                  void startAirgapSender();
                } else if (viewMode === "host") {
                  void initHostSession();
                } else {
                  dispatchFlow({ type: "set-flow", flow: null });
                  backToModes();
                }
              }}
            />
          )}

          {errorMessage && (
            <div className="error-panel modal-error">{errorMessage}</div>
          )}
        </div>

        {/* Modal footer actions: only shown when the active view doesn't have inline action buttons */}
        {!hasOwnActionButtons && (
          <div
            className={`modal-actions${
              (isWaitingState && (viewMode === "host" || viewMode === "select-mode")) ||
              status.status === "failed"
                ? " pairing-host-actions"
                : ""
            }`}
          >
            {isWaitingState && viewMode === "select-mode" ? (
              <BackButton onClick={() => showView("select-role")} />
            ) : null}
            {isWaitingState && viewMode === "host" ? <BackButton onClick={() => backToModes()} /> : null}
            {status.status === "failed" ? <BackButton onClick={() => backToModes(true)} /> : null}
            <button
              type="button"
              className="button ghost"
              onClick={handleClose}
              disabled={status.status === "transferring"}
            >
              {status.status === "failed" ? "Close" : "Cancel"}
            </button>
          </div>
        )}
      </section>
    </div>
  );
}

function BackButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className="button pairing-back-btn" onClick={onClick}>
      <ChevronIcon style={{ transform: "rotate(180deg)" }} />
      <span>Back</span>
    </button>
  );
}

import { useCallback, useEffect, useEffectEvent, useReducer, useRef, useState } from "react";
import { cancelPairing, pairingApi } from "../../shared/lib/api";
import { ChevronIcon } from "../../shared/ui/icons";
import { useAirgapCapture } from "./hooks/useAirgapCapture";
import { useAirgapFlow } from "./hooks/useAirgapFlow";
import { usePairingStatus } from "./hooks/usePairingStatus";
import { useQrScanner } from "./hooks/useQrScanner";
import { useVirtualKeyboard } from "../../shared/hooks/useVirtualKeyboard";
import { logIgnored } from "../../shared/lib/log";
import { isMobileDevice } from "../../shared/lib/platform";
import { flowReducer, INITIAL_FLOW } from "./lib/flow-state";
import {
  hasOwnActionButtons as viewHasOwnActionButtons,
  isWaitingStatus,
  confirmFields,
  pairingHeader,
  type ActiveFlow,
  type ViewMode,
} from "./lib/view-model";
import { isAirgapFrameCode } from "./lib/airgap-frame";
import { useLatestRequest } from "../../shared/hooks/useLatestRequest";
import { usePairingSession } from "./hooks/usePairingSession";
import { useWifiGate } from "./hooks/useWifiGate";
import { useAutoDismissedError } from "../../shared/hooks/useAutoDismissedError";
import { useModalA11y } from "../../shared/hooks/useModalA11y";
import { useModalClosePolicy } from "../../shared/hooks/useModalClosePolicy";
import { describeError } from "../../shared/lib/errors";
import { ConfirmDialog } from "../../shared/ui/ConfirmDialog";
import { DialogError } from "../../shared/ui/DialogError";
import { ModalDialog } from "../../shared/ui/ModalDialog";
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
  ConfirmTransferCard,
  RoleFallbackView,
  TransferringPanel,
} from "./views/StatusPanels";

/** Wait after a view change before moving keyboard focus into it, so the new view has rendered. */
const FOCUS_DELAY_MS = 50;
export function PairingModal({
  open,
  onClose,
  onCompleted,
}: {
  open: boolean;
  onClose: () => void;
  onCompleted: () => void;
}) {
  const [{ viewMode, activeFlow, intendedRole }, dispatchFlow] = useReducer(flowReducer, INITIAL_FLOW);
  const { status, setStatus, remainingSecs, hasCompletedRef } = usePairingStatus(open);
  const [joinCodeInput, setJoinCodeInput] = useState("");
  const [busy, setBusy] = useState(false);
  const { error: errorMessage, setError: setErrorMessage } = useAutoDismissedError(viewMode);
  const { error: airgapPrepareError, setError: setAirgapPrepareError } = useAutoDismissedError(viewMode);
  const [confirmedTransfer, setConfirmedTransfer] = useState(false);
  const [includeSettings, setIncludeSettings] = useState(true);
  const [isKeyboardOpen, setIsKeyboardOpen] = useVirtualKeyboard(open);
  const [scannerRestartKey, setScannerRestartKey] = useState(0);

  // Every start of a session, join or export is a request; a newer one (or leaving the view) makes
  // an older one's answer moot.
  const request = useLatestRequest();

  /** Hides the dialog's own error messages (the camera's message is the scanner hook's). */
  const clearAllErrors = useCallback(() => {
    setErrorMessage(null);
    setAirgapPrepareError(null);
  }, [setErrorMessage, setAirgapPrepareError]);

  const showView = useCallback(
    (view: ViewMode, flow?: ActiveFlow) => {
      request.cancel();
      clearAllErrors();
      dispatchFlow({ type: "show", view, flow });
    },
    [request, clearAllErrors],
  );

  const dialogRef = useRef<HTMLElement>(null);
  const roleAutoSelectedRef = useRef(false);

  // Every pairing failure goes through the friendly-message utility: what was being done,
  // a plain explanation, and the raw detail kept for Copy Diagnostics.
  const showError = (context: string, cause: unknown) => {
    setErrorMessage(describeError("pairing", context, cause));
  };

  /** What the session and air-gap actions share with this dialog. */
  const actionContext = { request, busy, setBusy, setStatus, setErrorMessage, showError };

  // `showError` and `startLinkCode` are new on every render. The effects below call them through
  // these effect events, so they always run the current ones without listing them as
  // dependencies and re-running on every render.
  const showErrorFromEffect = useEffectEvent((context: string, cause: unknown) => showError(context, cause));

  const capture = useAirgapCapture({
    active: open && viewMode === "scanner",
    onVerifyStart: () => setErrorMessage(null),
    onVerifyError: (cause) => showError("Couldn't verify the scanned frames", cause),
    onRescan: () => setScannerRestartKey((key) => key + 1),
  });

  const {
    videoRef,
    videoReady,
    setVideoReady,
    availableCameras,
    isFrontCamera,
    cameraError,
    cameraFailed,
    clearCameraError,
    stopCamera,
    handleScannerTap,
    handleSwitchCamera,
  } = useQrScanner({
    active: viewMode === "scanner" && open,
    restartKey: scannerRestartKey,
    onDecoded: (code, controls) => {
      if (isAirgapFrameCode(code)) capture.addFrame(code, controls.stopCamera);
    },
    // A scanned code that could not be acted on is dropped.
    onError: (cause) => logIgnored("pairing.scan", cause),
  });

  const { airgapExport, clearExport, player, startAirgapSender, handleAirgapImport } = useAirgapFlow({
    context: actionContext,
    senderViewActive: viewMode === "airgap-sender",
    includeSettings,
    capture,
    stopCamera,
    showView,
    setAirgapPrepareError,
    setStatus,
    hasCompletedRef,
    onCompleted,
  });

  // Drops the camera and the state of any pairing in progress. `stopCamera` and `capture` are new
  // every render, so the open/close effect below calls this effect event instead of listing them
  // and re-running on every render.
  const discardSession = useEffectEvent(() => {
    hasCompletedRef.current = false;
    setStatus({ status: "idle" });
    capture.resetAll();
    stopCamera();
  });

  const handleClose = () => {
    stopCamera();
    if (status.status === "completed" && !hasCompletedRef.current) {
      hasCompletedRef.current = true;
      onCompleted();
    }
    cancelPairing();
    onClose();
  };

  // Shared close policy: while a transfer runs, no dismissal path (X, Escape,
  // backdrop, Cancel) may close the modal.
  const requestClose = useModalClosePolicy(status.status !== "transferring", handleClose);

  /**
   * Abandon the current attempt and go to `view`: the role choice, the other ways to connect, or
   * (Try Again) the code entry.
   */
  const leaveAttempt = useCallback((view: ViewMode, flow: ActiveFlow = null) => {
    cancelPairing();
    request.cancel();
    clearAllErrors();
    setBusy(false);
    setStatus({ status: "idle" });
    showView(view, flow);
  }, [request, showView, setStatus, clearAllErrors]);

  const isWaitingState = isWaitingStatus(status.status);

  /**
   * One step back from the view that is showing: the rule behind every Back button and the
   * Escape key. Returns false when there is no earlier step (the first view, or a pairing that
   * has moved past choosing how to connect). The code screens follow the role choice directly;
   * the QR screens are reached from the other ways to connect.
   */
  const goBack = useCallback((): boolean => {
    if (!isWaitingState) return false;
    switch (viewMode) {
      case "select-mode":
      case "host":
      case "code":
        leaveAttempt("select-role");
        return true;
      case "scanner":
        stopCamera();
        capture.clearCapture();
        leaveAttempt("select-mode");
        return true;
      case "airgap-sender":
        clearExport();
        capture.clearCapture();
        leaveAttempt("select-mode");
        return true;
      case "select-role":
        return false;
    }
  }, [isWaitingState, viewMode, leaveAttempt, stopCamera, capture, clearExport]);

  const handleEscape = useCallback(() => {
    if (errorMessage || airgapPrepareError || cameraError) {
      clearAllErrors();
      clearCameraError();
      return;
    }
    if (!goBack()) requestClose();
  }, [errorMessage, airgapPrepareError, cameraError, goBack, requestClose, clearAllErrors, clearCameraError]);

  useModalA11y(dialogRef, open, handleEscape);

  useEffect(() => {
    if (
      status.status === "confirmTransfer" ||
      status.status === "roleSelection" ||
      status.status === "failed" ||
      status.status === "transferring" ||
      status.status === "completed" ||
      status.status === "peerConnected"
    ) {
      setBusy(false);
    }
    if (status.status !== "confirmTransfer") {
      setConfirmedTransfer(false);
    }
    if (status.status === "completed") {
      if (!hasCompletedRef.current) {
        hasCompletedRef.current = true;
        onCompleted();
      }
    }
  }, [status.status, onCompleted, hasCompletedRef]);

  // The backend sends a sentence for every pairing failure (`pairing::failure`); protocol detail
  // goes to its log, which Copy Diagnostics includes.
  const backendFailedError = status.status === "failed" ? status.data.error.message : null;

  // The failed status is polled every 800ms; copy it into the banner once so the
  // timer is not restarted, and so Back to another step can hide it.
  useEffect(() => {
    if (backendFailedError == null) return;
    setErrorMessage(backendFailedError);
  }, [backendFailedError, setErrorMessage]);

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
      showErrorFromEffect("Couldn't apply the send or receive role", err);
      roleAutoSelectedRef.current = false;
      setBusy(false);
    });
  }, [open, status.status, intendedRole, setErrorMessage]);

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
    }, FOCUS_DELAY_MS);

    return () => clearTimeout(timer);
  }, [viewMode, status.status, open]);

  const { initHostSession, handleConnectByCode, handleSelectRole, handleConfirmTransfer } = usePairingSession({
    context: actionContext,
    roleAutoSelectedRef,
    includeSettings,
    setConfirmed: setConfirmedTransfer,
  });

  // Start showing a link code. A newer start (or leaving the view) makes an older one's result moot.
  const startLinkCode = (action: "host" | "code") => {
    if (action === "host") {
      showView("host", "wifi");
      void initHostSession();
      return;
    }
    showView("code", "wifi");
    setJoinCodeInput("");
  };

  const { prompt: wifiPrompt, setPrompt: setWifiPrompt, requireWifiThen } = useWifiGate({
    open,
    onReady: startLinkCode,
  });

  // On close: forget everything, so the next open starts at step 1.
  useEffect(() => {
    if (open) return;
    discardSession();
    clearAllErrors();
    setJoinCodeInput("");
    dispatchFlow({ type: "reset" });
    roleAutoSelectedRef.current = false;
    setBusy(false);
    setConfirmedTransfer(false);
    setIncludeSettings(true);
    clearExport();
    setWifiPrompt(null);
    request.cancel();
  }, [open, clearAllErrors, request, setWifiPrompt, clearExport]);

  if (!open) return null;

  const handleDone = () => {
    if (!hasCompletedRef.current) {
      hasCompletedRef.current = true;
      onCompleted();
    }
    handleClose();
  };

  const hasOwnActionButtons = viewHasOwnActionButtons(status.status, viewMode);
  const showSwitchCamera = availableCameras.length > 1 || isMobileDevice() || Boolean(import.meta.env?.DEV);
  const { title: modalTitle, subtitle: modalSubtitle, step, showStepDots } = pairingHeader({
    status: status.status,
    viewMode,
    activeFlow,
    intendedRole,
    airgapVerifyPrompt: capture.verifyPrompt,
    isSender: confirmFields(status)?.isSender,
  });
  const confirm = confirmFields(status);

  return (
    <>
    <ModalDialog
      dialogRef={dialogRef}
      labelledBy="pairing-modal-title"
      className={`pairing-modal ${isWaitingState && viewMode === "code" ? "view-code-entry" : ""} ${isKeyboardOpen ? "keyboard-open" : ""}`}
      backdropClassName={isKeyboardOpen ? "keyboard-open" : ""}
      onClose={requestClose}
      closeDisabled={status.status === "transferring"}
    >
      {/* Status changes are visual; announce them for screen reader users. */}
      <div className="sr-only" role="status" aria-live="polite">
        {modalTitle}. {modalSubtitle}
      </div>
      <div className="modal-kicker">Sync devices over local network</div>
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
            onChoose={(role) => {
              // The sender shows the link code and the receiver types it.
              dispatchFlow({ type: "choose-role", role });
              void requireWifiThen(role === "send" ? "host" : "code");
            }}
          />
        )}

        {isWaitingState && viewMode === "select-mode" && (
          <ModeSelectView
            intendedRole={intendedRole}
            onShowCode={() => void requireWifiThen("host")}
            onEnterCode={() => void requireWifiThen("code")}
            onShowQr={() => {
              dispatchFlow({ type: "set-flow", flow: "airgap" });
              void startAirgapSender();
            }}
            onScan={() => {
              dispatchFlow({ type: "set-flow", flow: "wifi" });
              void pairingApi.ensureCameraPermission()
                .catch((cause) => logIgnored("pairing.cameraPermission", cause))
                .finally(() => showView("scanner"));
            }}
          />
        )}

        {isWaitingState && viewMode === "host" && (
          <HostCodeView
            status={status}
            remainingSecs={remainingSecs}
            onRegenerate={() => void initHostSession()}
            onOtherWays={() => leaveAttempt("select-mode")}
          />
        )}

        {isWaitingState && viewMode === "scanner" && (
          <ScannerView
            airgapVerifyPrompt={capture.verifyPrompt}
            airgapTotalChunks={capture.total}
            airgapCaptureSecs={capture.captureSecs}
            airgapVerifying={capture.verifying}
            airgapAccountCount={capture.accountCount}
            airgapImporting={capture.importing}
            airgapCapturedChunks={capture.chunks}
            cameraError={cameraError}
            cameraFailed={cameraFailed}
            isFrontCamera={isFrontCamera}
            videoReady={videoReady}
            showSwitchCamera={showSwitchCamera}
            videoRef={videoRef}
            setVideoReady={setVideoReady}
            onScannerTap={() => void handleScannerTap()}
            onSwitchCamera={() => void handleSwitchCamera()}
            onRetryCamera={() => {
              clearCameraError();
              setScannerRestartKey((key) => key + 1);
            }}
            onAirgapBack={() => {
              capture.rescan();
              showView("scanner");
              setScannerRestartKey((key) => key + 1);
            }}
            onAirgapImport={() => void handleAirgapImport()}
            onBack={goBack}
          />
        )}

        {isWaitingState && viewMode === "code" && (
          <CodeEntryView
            value={joinCodeInput}
            busy={busy}
            onChange={setJoinCodeInput}
            onSubmit={() => void handleConnectByCode(joinCodeInput)}
            onBack={goBack}
            onOtherWays={() => leaveAttempt("select-mode")}
            setKeyboardOpen={setIsKeyboardOpen}
          />
        )}

        {isWaitingState && viewMode === "airgap-sender" && (
          <AirgapSenderView
            exportData={airgapExport}
            busy={busy}
            error={airgapPrepareError}
            onDismissError={() => setAirgapPrepareError(null)}
            frameIndex={player.frameIndex}
            playing={player.playing}
            speed={player.speed}
            onTogglePlaying={player.togglePlaying}
            onToggleSpeed={player.toggleSpeed}
            onDone={handleClose}
            onRetry={() => void startAirgapSender()}
            onBack={goBack}
          />
        )}

        {status.status === "clientConnecting" && <ConnectingPanel />}

        {status.status === "peerConnected" && <PeerConnectedPanel />}

        {/* Role selection is applied automatically from the choice in step 1; this is the fallback if none was made. */}
        {status.status === "roleSelection" && !intendedRole && (
          <RoleFallbackView busy={busy} onChoose={(role) => void handleSelectRole(role)} />
        )}

        {status.status === "roleSelection" && intendedRole && <ApplyingRolePanel role={intendedRole} />}

        {confirm && (
          <ConfirmTransferCard
            isSender={confirm.isSender}
            accountCount={confirm.accountCount}
            busy={busy}
            confirmed={confirmedTransfer}
            onConfirm={() => void handleConfirmTransfer(confirm.sessionId, true)}
            onCancel={
              confirm.isSender
                ? () => void handleConfirmTransfer(confirm.sessionId, false)
                : requestClose
            }
          />
        )}

        {status.status === "transferring" && <TransferringPanel />}

        {status.status === "completed" && <CompletedCard summary={status.data.summary} onDone={handleDone} />}

        {status.status === "failed" && (
          <FailedCard
            onRetry={() => {
              setErrorMessage(null);
              if (activeFlow === "airgap") {
                void startAirgapSender();
              } else if (viewMode === "host") {
                void initHostSession();
              } else if (viewMode === "code") {
                // The other device may still show the same code: keep what was typed.
                leaveAttempt("code", "wifi");
              } else {
                leaveAttempt("select-mode");
              }
            }}
          />
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
          {isWaitingState && (viewMode === "select-mode" || viewMode === "host") ? (
            <BackButton onClick={goBack} />
          ) : null}
          {status.status === "failed" ? <BackButton onClick={() => leaveAttempt("select-role")} /> : null}
          <button
            type="button"
            className="button ghost"
            onClick={requestClose}
            disabled={status.status === "transferring"}
          >
            {status.status === "failed" ? "Close" : "Cancel"}
          </button>
        </div>
      )}

      {errorMessage && !airgapPrepareError && (
        <DialogError message={errorMessage} onDismiss={() => setErrorMessage(null)} />
      )}
    </ModalDialog>
    <ConfirmDialog
      open={wifiPrompt != null}
      kicker="Link code"
      title="Turn on Wi-Fi"
      body="Link codes work over the same Wi-Fi network, or a hotspot one device shares. Turn Wi-Fi or your hotspot on, then come back to continue, or use another way to connect."
      confirmLabel="Turn On Wi-Fi"
      cancelLabel="Other Ways"
      confirmDanger={false}
      onConfirm={() => {
        void pairingApi.openWifiSettings().catch((cause) => logIgnored("pairing.openWifiSettings", cause));
      }}
      onCancel={() => {
        // Without Wi-Fi, the QR code is still a way to connect.
        setWifiPrompt(null);
        showView("select-mode");
      }}
    />
    </>
  );
}

function BackButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className="button primary pairing-back-btn" onClick={onClick}>
      <ChevronIcon style={{ transform: "rotate(180deg)" }} />
      <span>Back</span>
    </button>
  );
}

import { useCallback, useEffect, useEffectEvent, useReducer, useRef, useState } from "react";
import { cancelPairing, pairingApi } from "../../shared/lib/api";
import { ChevronIcon } from "../../shared/ui/icons";
import { useAirgapCapture } from "./hooks/useAirgapCapture";
import { useAirgapFlow } from "./hooks/useAirgapFlow";
import { useFileTransfer } from "./hooks/useFileTransfer";
import { useIncomingFile } from "./hooks/useIncomingFile";
import { useTappedTransferFile } from "./hooks/useTappedTransferFile";
import { usePairingStatus } from "./hooks/usePairingStatus";
import { useQrScanner } from "./hooks/useQrScanner";
import { useVirtualKeyboard } from "../../shared/hooks/useVirtualKeyboard";
import { useSyncOtherWays } from "../../shared/hooks/usePreferences";
import { logIgnored } from "../../shared/lib/log";
import { isMobileDevice } from "../../shared/lib/platform";
import { flowReducer, INITIAL_FLOW } from "./lib/flow-state";
import {
  hasOwnActionButtons as viewHasOwnActionButtons,
  isWaitingStatus,
  confirmFields,
  hasNearbyShare,
  hostWaitingFields,
  isLinkCode,
  nearbyShareName,
  pairingHeader,
  type ActiveFlow,
  type ViewMode,
} from "./lib/view-model";
import { isAirgapFrameCode } from "./lib/airgap-frame";
import { useLatestRequest } from "../../shared/hooks/useLatestRequest";
import { usePairingSession } from "./hooks/usePairingSession";
import { useAutoDismissedError } from "../../shared/hooks/useAutoDismissedError";
import { useModalA11y } from "../../shared/hooks/useModalA11y";
import { useModalClosePolicy } from "../../shared/hooks/useModalClosePolicy";
import { describeError } from "../../shared/lib/errors";
import type { SyncSummary } from "../../types";
import { DialogError } from "../../shared/ui/DialogError";
import { ModalDialog } from "../../shared/ui/ModalDialog";
import { AirgapSenderView } from "./views/AirgapSenderView";
import { CodeEntryView } from "./views/CodeEntryView";
import { FileReceiveView, FileSendView } from "./views/FileTransferViews";
import { HostCodeView } from "./views/HostCodeView";
import { ModeSelectView } from "./views/ModeSelectView";
import { RoleSelectView } from "./views/RoleSelectView";
import { ScannerView } from "./views/ScannerView";
import {
  ApplyingRolePanel,
  CompletedCard,
  ConnectingPanel,
  PeerConnectedPanel,
  ConfirmTransferCard,
  RoleFallbackView,
  TransferringPanel,
} from "./views/StatusPanels";

/** Wait after a view change before moving keyboard focus into it, so the new view has rendered. */
const FOCUS_DELAY_MS = 50;
/**
 * How long the sender's search for the receiver on the network lasts (`discovery::DISCOVERY_TIMEOUT`),
 * counted down on the code screen. When it ends with no one found, the screen says so and offers
 * Quick Share or AirDrop; the file goes only when the user taps it (making the file stops the search).
 */
const WIFI_SEARCH_SECS = 15;
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
  /** The Wi-Fi search for the typed link code ended without finding the other device. */
  const [wifiNotFound, setWifiNotFound] = useState(false);
  const [busy, setBusy] = useState(false);
  // After a failure the reason is the screen's content ("The reason is below"), so it stays.
  const { error: errorMessage, setError: setErrorMessage } = useAutoDismissedError(
    viewMode,
    status.status === "failed",
  );
  const { error: airgapPrepareError, setError: setAirgapPrepareError } = useAutoDismissedError(viewMode);
  const [confirmedTransfer, setConfirmedTransfer] = useState(false);
  const [includeSettings, setIncludeSettings] = useState(true);
  const [isKeyboardOpen, setIsKeyboardOpen] = useVirtualKeyboard(open);
  const [scannerRestartKey, setScannerRestartKey] = useState(0);
  // "Other ways to connect" (an older version's six digits, the QR codes) is hidden unless
  // Settings > Device Sync shows it.
  const [otherWaysShown] = useSyncOtherWays();
  /** The code shown is six digits, for a device with an older version (Other ways to connect). */
  const [legacyHost, setLegacyHost] = useState(false);

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

  /** The receiver added the accounts of a file. */
  const completeWithFile = (summary: SyncSummary) => {
    hasCompletedRef.current = true;
    setStatus({ status: "completed", data: { summary } });
    onCompleted();
  };
  const fileTransfer = useFileTransfer({
    context: actionContext,
    includeSettings,
    showView,
    onImported: completeWithFile,
  });
  // A file opened from Quick Share, AirDrop or Files: open it with the code shown.
  useTappedTransferFile(open, () => void fileTransfer.openTapped());
  // Where AirDrop or Quick Share can carry the file, a sender whose code finds no receiver on the
  // network sends the accounts that way by itself, and the receiver picks up the file that comes.
  const fileFallback = hasNearbyShare();
  const nearbyName = fileFallback ? nearbyShareName() : undefined;
  // The receiver waits for the file while it shows a ten-letter code (six digits are Wi-Fi only).
  const watchingForFile =
    open &&
    fileFallback &&
    viewMode === "host" &&
    status.status === "hostWaiting" &&
    isLinkCode(hostWaitingFields(status)?.joinCode ?? "");
  const incoming = useIncomingFile({
    active: watchingForFile,
    onOpened: fileTransfer.handleOpened,
    onError: (cause) => showError("Couldn't open the file that arrived", cause),
  });
  const fileAccess = incoming.needsAccess ? { needed: true, onAllow: incoming.requestAccess } : undefined;
  // Busy on the code screen with nothing connected yet: the network search for the typed code.
  const searchingForCode =
    fileFallback && open && viewMode === "code" && busy && status.status === "idle" && isLinkCode(joinCodeInput);
  // Seconds left in the search, counted down on the code screen. Its own end (not found) offers the
  // file; see `onSubmit` below.
  const [searchSecsLeft, setSearchSecsLeft] = useState(WIFI_SEARCH_SECS);
  useEffect(() => {
    if (!searchingForCode) return;
    let left = WIFI_SEARCH_SECS;
    const timer = setInterval(() => {
      left -= 1;
      setSearchSecsLeft(left);
      if (left <= 0) clearInterval(timer);
    }, 1000);
    return () => {
      clearInterval(timer);
      setSearchSecsLeft(WIFI_SEARCH_SECS);
    };
  }, [searchingForCode]);

  // Drops the camera and the state of any pairing in progress. `stopCamera` and `capture` are new
  // every render, so the open/close effect below calls this effect event instead of listing them
  // and re-running on every render.
  const discardSession = useEffectEvent(() => {
    hasCompletedRef.current = false;
    setStatus({ status: "idle" });
    capture.resetAll();
    stopCamera();
    fileTransfer.reset();
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
      case "file-send":
        // Back to the code entry, with the code still typed.
        showView("code", "wifi");
        return true;
      case "file-receive":
        // The file used the code up: start over.
        leaveAttempt("select-role");
        return true;
      case "select-role":
        return false;
    }
  }, [isWaitingState, viewMode, leaveAttempt, stopCamera, capture, clearExport, showView]);

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
        const retry = container.querySelector<HTMLButtonElement>(".pairing-retry-btn");
        if (retry) {
          retry.focus({ preventScroll: true });
          return;
        }
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

  // The sender sends as soon as the devices are connected: showing the code was the other side's
  // consent, and choosing Send and typing it this side's.
  const autoConfirmedRef = useRef<string | null>(null);
  const confirmSessionId = status.status === "confirmTransfer" ? confirmFields(status)?.sessionId : undefined;
  const confirmAsSender = status.status === "confirmTransfer" && confirmFields(status)?.isSender === true;
  const confirmAutomatically = useEffectEvent((sessionId: string) => void handleConfirmTransfer(sessionId, true));
  useEffect(() => {
    if (!open || !confirmAsSender || confirmSessionId == null) return;
    if (autoConfirmedRef.current === confirmSessionId) return;
    autoConfirmedRef.current = confirmSessionId;
    confirmAutomatically(confirmSessionId);
  }, [open, confirmAsSender, confirmSessionId]);

  // Start showing a link code (six digits for an older version when `legacy`), or entering one. A
  // newer start (or leaving the view) makes an older one's result moot.
  const startLinkCode = (action: "host" | "code", legacy = false) => {
    // For the diagnostics log only: whether the phone was on Wi-Fi when the code screen opened.
    if (isMobileDevice()) void pairingApi.wifiEnabled().catch((cause) => logIgnored("pairing.wifiEnabled", cause));
    if (action === "host") {
      setLegacyHost(legacy);
      showView("host", "wifi");
      void initHostSession(legacy);
      return;
    }
    showView("code", "wifi");
    setJoinCodeInput("");
    setWifiNotFound(false);
  };

  // On close: forget everything, so the next open starts at step 1.
  useEffect(() => {
    if (open) return;
    discardSession();
    clearAllErrors();
    setJoinCodeInput("");
    setWifiNotFound(false);
    dispatchFlow({ type: "reset" });
    roleAutoSelectedRef.current = false;
    setBusy(false);
    setConfirmedTransfer(false);
    setIncludeSettings(true);
    setLegacyHost(false);
    clearExport();
    autoConfirmedRef.current = null;
    request.cancel();
  }, [open, clearAllErrors, request, clearExport]);

  if (!open) return null;

  const handleDone = () => {
    if (!hasCompletedRef.current) {
      hasCompletedRef.current = true;
      onCompleted();
    }
    handleClose();
  };

  const hasOwnActionButtons = viewHasOwnActionButtons(status.status, viewMode);

  /** Try Again after a failure: start the same attempt over. */
  const retryAfterFailure = () => {
    setErrorMessage(null);
    if (activeFlow === "airgap") {
      void startAirgapSender();
    } else if (viewMode === "host") {
      void initHostSession(legacyHost);
    } else if (viewMode === "code") {
      // The other device may still show the same code: keep what was typed.
      leaveAttempt("code", "wifi");
    } else {
      leaveAttempt("select-mode");
    }
  };
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
      <div className="modal-kicker">Sync devices</div>
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
              // The receiver shows the link code and the sender types it, so the device that
              // types it is the one that sends the file if the other isn't on the network.
              dispatchFlow({ type: "choose-role", role });
              startLinkCode(role === "send" ? "code" : "host");
            }}
          />
        )}

        {isWaitingState && viewMode === "select-mode" && (
          <ModeSelectView
            intendedRole={intendedRole}
            onShowCode={() => startLinkCode("host", true)}
            onEnterCode={() => startLinkCode("code")}
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
            onRegenerate={() => void initHostSession(legacyHost)}
            onOtherWays={otherWaysShown ? () => leaveAttempt("select-mode") : undefined}
            nearbyName={nearbyName}
            onOpenFile={() => void fileTransfer.openFile()}
            fileAccess={fileAccess}
          />
        )}

        {isWaitingState && viewMode === "file-send" && fileTransfer.sendState && (
          <FileSendView
            state={fileTransfer.sendState}
            nearbyName={nearbyShareName()}
            canShare={fileTransfer.canShare}
            busy={busy}
            onSendAgain={fileTransfer.sendAgain}
            onShare={fileTransfer.share}
            onSave={fileTransfer.save}
            onBack={goBack}
            onDone={handleClose}
          />
        )}

        {isWaitingState && viewMode === "file-receive" && (
          <FileReceiveView
            preview={fileTransfer.preview}
            nearbyName={nearbyShareName()}
            busy={busy}
            onBack={goBack}
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
            onChange={(code) => {
              setJoinCodeInput(code);
              setWifiNotFound(false);
            }}
            onSubmit={(code) => {
              setWifiNotFound(false);
              void handleConnectByCode(code, () => {
                // Not found on the network (or no network): say so and offer the file, which the
                // user sends with Use AirDrop / Use Quick Share.
                if (!fileFallback || !isLinkCode(code)) return false;
                setWifiNotFound(true);
                return true;
              });
            }}
            onBack={goBack}
            onOtherWays={otherWaysShown ? () => leaveAttempt("select-mode") : undefined}
            nearbyName={nearbyName}
            notFound={wifiNotFound}
            onUseNearby={() => fileTransfer.send(joinCodeInput, wifiNotFound)}
            fallback={searchingForCode ? { secsLeft: searchSecsLeft, totalSecs: WIFI_SEARCH_SECS } : undefined}
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
          {status.status === "failed" ? (
            <>
              <BackButton onClick={() => leaveAttempt("select-role")} />
              {/* Styled as Connect to Device; the X in the header closes the dialog. */}
              <button type="button" className="button primary pairing-retry-btn" onClick={retryAfterFailure}>
                Try Again
              </button>
            </>
          ) : (
            <button
              type="button"
              className="button ghost"
              onClick={requestClose}
              disabled={status.status === "transferring"}
            >
              Cancel
            </button>
          )}
        </div>
      )}

      {errorMessage && !airgapPrepareError && (
        <DialogError message={errorMessage} onDismiss={() => setErrorMessage(null)} />
      )}
    </ModalDialog>
    </>
  );
}

function BackButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className="button ghost pairing-back-btn" onClick={onClick}>
      <ChevronIcon style={{ transform: "rotate(180deg)" }} />
      <span>Back</span>
    </button>
  );
}

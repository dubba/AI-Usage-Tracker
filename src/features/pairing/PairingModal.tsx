import { useCallback, useEffect, useEffectEvent, useReducer, useRef, useState } from "react";
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
import { pairingFailedMessage } from "./lib/pairing-errors";
import {
  hasOwnActionButtons as viewHasOwnActionButtons,
  isWaitingStatus,
  PAIRING_CODE_LENGTH,
  pairingHeader,
  sasFields,
  type ActiveFlow,
  type IntendedRole,
  type ViewMode,
} from "./lib/view-model";
import { isAirgapFrameCode } from "./lib/airgap-frame";
import { isPairingUri } from "./lib/uri";
import { collectUiState } from "../dashboard/ui-state";
import { useAutoDismissedError } from "../../shared/hooks/useAutoDismissedError";
import { useModalA11y } from "../../shared/hooks/useModalA11y";
import { useModalClosePolicy } from "../../shared/hooks/useModalClosePolicy";
import {
  describeError,
  errorMessage as rawErrorMessage,
  friendlyMessage,
  recordErrorDetail,
} from "../../shared/lib/errors";
import { ConfirmDialog } from "../../shared/ui/ConfirmDialog";
import { ModalDialog } from "../../shared/ui/ModalDialog";
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

/** Wait after a view change before moving keyboard focus into it, so the new view has rendered. */
const FOCUS_DELAY_MS = 50;
/** How long opening the modal waits for a pairing link that arrived with the app launch. */
const PENDING_URI_WAIT_MS = 1500;
/** How often the "turn on Wi-Fi" prompt checks whether Wi-Fi came on. */
const WIFI_POLL_MS = 800;

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
  const { status, setStatus, remainingSecs, hasCompletedRef } = usePairingStatus(open);
  const [joinCodeInput, setJoinCodeInput] = useState("");
  const [busy, setBusy] = useState(false);
  const { error: errorMessage, setError: setErrorMessage } = useAutoDismissedError(viewMode);
  const { error: airgapPrepareError, setError: setAirgapPrepareError } = useAutoDismissedError(viewMode);
  const [cameraFailed, setCameraFailed] = useState(false);
  const [confirmedSas, setConfirmedSas] = useState(false);
  const [includeSettings, setIncludeSettings] = useState(true);
  const [isKeyboardOpen, setIsKeyboardOpen] = useVirtualKeyboard(open);
  const [airgapExport, setAirgapExport] = useState<AirgapExport | null>(null);
  const [scannerRestartKey, setScannerRestartKey] = useState(0);
  const [wifiPrompt, setWifiPrompt] = useState<"host" | "code" | null>(null);

  const hostStartIdRef = useRef(0);
  const showView = useCallback(
    (view: ViewMode, flow?: ActiveFlow) => {
      hostStartIdRef.current += 1;
      setErrorMessage(null);
      setAirgapPrepareError(null);
      setCameraFailed(false);
      dispatchFlow({ type: "show", view, flow });
    },
    [setErrorMessage, setAirgapPrepareError],
  );

  const dialogRef = useRef<HTMLElement>(null);
  const roleAutoSelectedRef = useRef(false);
  // The pairing link (deep link or link opened in-app) this session joined through, so
  // "Try Again" after a failed link join can repeat the join instead of jumping to the mode picker.
  const joinUriRef = useRef<string | null>(null);

  // Every pairing failure goes through the friendly-message utility: what was being done,
  // a plain explanation, and the raw detail kept for Copy Diagnostics.
  const showError = (context: string, cause: unknown) => {
    setErrorMessage(describeError("pairing", context, cause));
  };

  // `showError` and `startLinkCode` are new on every render. The effects below call them through
  // these effect events, so they always run the current ones without listing them as
  // dependencies and re-running on every render.
  const showErrorFromEffect = useEffectEvent((context: string, cause: unknown) => showError(context, cause));

  const player = useAirgapPlayer(airgapExport, viewMode === "airgap-sender");
  const capture = useAirgapCapture({
    active: open && viewMode === "scanner",
    onVerifyStart: () => setErrorMessage(null),
    onVerifyError: (raw) => {
      recordErrorDetail("pairing", "Couldn't verify the scanned frames", raw);
      setErrorMessage(friendlyMessage("Couldn't verify the scanned frames", raw));
    },
    onRescan: () => setScannerRestartKey((key) => key + 1),
  });

  const {
    videoRef,
    videoReady,
    setVideoReady,
    availableCameras,
    isFrontCamera,
    cameraError,
    clearCameraError,
    stopCamera,
    handleScannerTap,
    handleSwitchCamera,
  } = useQrScanner({
    active: viewMode === "scanner" && open,
    restartKey: scannerRestartKey,
    onDecoded: async (code, controls) => {
      if (isPairingUri(code)) {
        // A pairing link on the other device's screen: join it.
        controls.stopCamera();
        showView("host");
        hostStartIdRef.current += 1;
        setBusy(true);
        setErrorMessage(null);
        await pairingApi.startClient(code);
        return true;
      }
      if (isAirgapFrameCode(code)) capture.addFrame(code, controls.stopCamera);
    },
    // A scanned code that could not be acted on is dropped; the backend reports a failed join itself.
    onError: (cause) => logIgnored("pairing.scan", cause),
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

  /** Abandon the current attempt and return to choosing how to connect. */
  const backToModes = useCallback((clearError = true) => {
    cancelPairing();
    hostStartIdRef.current += 1;
    if (clearError) {
      setErrorMessage(null);
      setAirgapPrepareError(null);
      setCameraFailed(false);
    }
    setBusy(false);
    setStatus({ status: "idle" });
    showView("select-mode", null);
  }, [showView, setStatus, setErrorMessage, setAirgapPrepareError]);

  const isWaitingState = isWaitingStatus(status.status);

  const handleEscape = useCallback(() => {
    if (errorMessage || airgapPrepareError || cameraError) {
      setErrorMessage(null);
      setAirgapPrepareError(null);
      clearCameraError();
      return;
    }
    if (isWaitingState && viewMode === "code") {
      backToModes();
      return;
    }
    if (isWaitingState && viewMode === "scanner") {
      stopCamera();
      capture.clearCapture();
      backToModes();
      return;
    }
    if (isWaitingState && viewMode === "host") {
      backToModes();
      return;
    }
    if (isWaitingState && viewMode === "airgap-sender") {
      setAirgapExport(null);
      setAirgapPrepareError(null);
      capture.clearCapture();
      backToModes();
      return;
    }
    if (isWaitingState && viewMode === "airgap-confirm") {
      showView("airgap-sender");
      return;
    }
    if (isWaitingState && viewMode === "select-mode") {
      showView("select-role");
      return;
    }
    requestClose();
  }, [
    errorMessage,
    airgapPrepareError,
    cameraError,
    isWaitingState,
    viewMode,
    backToModes,
    stopCamera,
    showView,
    requestClose,
    capture,
    setErrorMessage,
    setAirgapPrepareError,
    clearCameraError,
  ]);

  useModalA11y(dialogRef, open, handleEscape);

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

  // Backend-driven pairing failures arrive as raw protocol errors; keep the raw
  // detail for Copy Diagnostics while the box below the footer shows the translation.
  const backendFailedError = status.status === "failed" ? status.data.error : null;
  useEffect(() => {
    if (backendFailedError) recordErrorDetail("pairing", "Pairing failed", backendFailedError);
  }, [backendFailedError]);

  // The failed status is polled every 800ms; copy it into the banner once so the
  // timer is not restarted, and so Back to another step can hide it.
  useEffect(() => {
    if (backendFailedError == null) return;
    setErrorMessage(pairingFailedMessage(backendFailedError));
  }, [backendFailedError, setErrorMessage]);

  useEffect(() => {
    if (cameraError) setCameraFailed(true);
  }, [cameraError]);

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

  const requireWifiThen = async (action: "host" | "code") => {
    if (!isMobileDevice()) {
      startLinkCode(action);
      return;
    }
    let enabled = true;
    try {
      enabled = await pairingApi.wifiEnabled();
    } catch (cause) {
      logIgnored("pairing.wifiEnabled", cause);
    }
    if (enabled) {
      startLinkCode(action);
      return;
    }
    setWifiPrompt(action);
  };

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
      showError("Couldn't start the pairing session", err);
    } finally {
      if (startId === hostStartIdRef.current) setBusy(false);
    }
  };

  /** Join a session from a pairing link: a deep link, or one handed to the modal on open. */
  const startFromUri = useCallback(
    async (pendingUri: string) => {
      joinUriRef.current = pendingUri;
      const startId = ++hostStartIdRef.current;
      dispatchFlow({ type: "set-flow", flow: "wifi" });
      setBusy(true);
      setStatus({ status: "clientConnecting", data: { sessionId: "" } });
      try {
        await pairingApi.startClient(pendingUri);
      } catch (err) {
        if (startId !== hostStartIdRef.current) return;
        setBusy(false);
        const raw = rawErrorMessage(err);
        recordErrorDetail("pairing", "Couldn't connect with the link", raw);
        const msg = friendlyMessage("Couldn't connect with the link", raw);
        setErrorMessage(msg);
        setStatus({
          status: "failed",
          data: { error: msg },
        });
      }
    },
    [setStatus, setErrorMessage],
  );

  // On open: join straight away if a pairing link is waiting; on close: forget everything.
  useEffect(() => {
    if (!open) {
      discardSession();
      setErrorMessage(null);
      setAirgapPrepareError(null);
      setCameraFailed(false);
      setJoinCodeInput("");
      dispatchFlow({ type: "reset" });
      roleAutoSelectedRef.current = false;
      setBusy(false);
      setConfirmedSas(false);
      setIncludeSettings(true);
      setAirgapExport(null);
      setWifiPrompt(null);
      hostStartIdRef.current += 1;
      joinUriRef.current = null;
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
            new Promise<null>((resolve) => setTimeout(() => resolve(null), PENDING_URI_WAIT_MS)),
          ]);
        } catch (cause) {
          logIgnored("pending pairing uri", cause);
        }
      }

      if (pendingUri && isPairingUri(pendingUri)) {
        void startFromUri(pendingUri);
        return;
      }

      // Normal modal open: wait on Step 1 for the user to choose a role
    };

    void checkPendingAndStart();
  }, [open, initialJoinUri, setStatus, startFromUri, setErrorMessage, setAirgapPrepareError]);

  const startLinkCodeFromEffect = useEffectEvent((action: "host" | "code") => startLinkCode(action));

  // While the Wi-Fi prompt is up, poll so returning from the system panel (or
  // flipping Wi-Fi in the Android overlay) continues the link-code step.
  useEffect(() => {
    if (!open || !wifiPrompt) return;
    let cancelled = false;
    let continued = false;
    const action = wifiPrompt;
    const tick = async () => {
      try {
        const enabled = await pairingApi.wifiEnabled();
        if (cancelled || continued || !enabled) return;
        continued = true;
        setWifiPrompt(null);
        startLinkCodeFromEffect(action);
      } catch (cause) {
        logIgnored("pairing.wifiEnabled", cause);
      }
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") void tick();
    };
    const id = window.setInterval(() => void tick(), WIFI_POLL_MS);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      cancelled = true;
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [open, wifiPrompt]);

  if (!open) return null;

  const handleConnectByCode = async (code: string) => {
    const digits = code.replace(/\D/g, "").slice(0, PAIRING_CODE_LENGTH);
    if (digits.length !== PAIRING_CODE_LENGTH || busy) return;
    const startId = ++hostStartIdRef.current;
    setBusy(true);
    setErrorMessage(null);
    try {
      await pairingApi.startClientByCode(digits);
    } catch (err) {
      if (startId !== hostStartIdRef.current) return;
      showError("Couldn't connect with that code", err);
    } finally {
      if (startId === hostStartIdRef.current) {
        setBusy(false);
      }
    }
  };

  const handleSelectRole = async (role: IntendedRole) => {
    const startId = ++hostStartIdRef.current;
    setBusy(true);
    setErrorMessage(null);
    try {
      await pairingApi.selectRole(role);
    } catch (err) {
      if (startId !== hostStartIdRef.current) return;
      showError("Couldn't apply the send or receive role", err);
      roleAutoSelectedRef.current = false;
      setBusy(false);
    }
  };

  const startAirgapSender = async (includeSettingsOpt?: boolean) => {
    stopCamera();
    showView("airgap-sender");
    const startId = ++hostStartIdRef.current;
    setBusy(true);
    setErrorMessage(null);
    setAirgapPrepareError(null);
    try {
      const shouldInclude = includeSettingsOpt ?? includeSettings;
      const ui = shouldInclude ? collectUiState() : undefined;
      const exp = await pairingApi.prepareAirgapExport(shouldInclude, ui);
      if (startId !== hostStartIdRef.current) return;
      setAirgapExport(exp);
      player.restart();
    } catch (err) {
      if (startId !== hostStartIdRef.current) return;
      const raw = rawErrorMessage(err);
      recordErrorDetail("pairing", "Couldn't prepare the transfer", raw);
      setAirgapPrepareError(friendlyMessage("Couldn't prepare the transfer", raw));
    } finally {
      if (startId === hostStartIdRef.current) {
        setBusy(false);
      }
    }
  };

  const handleAirgapImport = async () => {
    if (capture.importing || !capture.verifyCode) return;
    const startId = ++hostStartIdRef.current;
    capture.setImporting(true);
    setErrorMessage(null);
    try {
      const chunks = Array.from(capture.chunks.values());
      const summary = await pairingApi.importAirgapFrames(chunks);
      if (startId !== hostStartIdRef.current) return;
      hasCompletedRef.current = true;
      capture.closePrompt();
      stopCamera();
      setStatus({
        status: "completed",
        data: { summary },
      });
      onCompleted();
    } catch (err) {
      if (startId !== hostStartIdRef.current) return;
      showError("Couldn't import the accounts", err);
    } finally {
      if (startId === hostStartIdRef.current) {
        capture.setImporting(false);
      }
    }
  };

  const handleConfirmSas = async (sessionId: string, confirmed: boolean, role?: string) => {
    if (confirmed) {
      setConfirmedSas(true);
    }
    const startId = ++hostStartIdRef.current;
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
      if (startId !== hostStartIdRef.current) return;
      showError("Couldn't confirm the codes", err);
      setConfirmedSas(false);
    } finally {
      if (startId === hostStartIdRef.current) {
        setBusy(false);
      }
    }
  };

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
  });
  const sas = sasFields(status);

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
            onShowCode={() => void requireWifiThen("host")}
            onEnterCode={() => void requireWifiThen("code")}
            onShowQr={() => {
              dispatchFlow({ type: "set-flow", flow: "airgap" });
              void startAirgapSender();
            }}
            onScan={() => {
              dispatchFlow({ type: "set-flow", flow: "wifi" });
              setCameraFailed(false);
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
          />
        )}

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
              setCameraFailed(false);
              setScannerRestartKey((key) => key + 1);
            }}
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
            onBack={() => backToModes()}
            setKeyboardOpen={setIsKeyboardOpen}
          />
        )}

        {isWaitingState && viewMode === "airgap-sender" && (
          <AirgapSenderView
            exportData={airgapExport}
            busy={busy}
            error={airgapPrepareError}
            frameIndex={player.frameIndex}
            playing={player.playing}
            speed={player.speed}
            onTogglePlaying={player.togglePlaying}
            onToggleSpeed={player.toggleSpeed}
            onContinue={() => showView("airgap-confirm")}
            onRetry={() => void startAirgapSender()}
            onBack={() => {
              setAirgapExport(null);
              setAirgapPrepareError(null);
              setErrorMessage(null);
              capture.clearCapture();
              showView("select-mode", null);
            }}
            onCancel={requestClose}
          />
        )}

        {isWaitingState && viewMode === "airgap-confirm" && airgapExport && (
          <AirgapConfirmView
            verifyCode={airgapExport.verifyCode}
            onBack={() => showView("airgap-sender")}
            onCancel={requestClose}
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
            onRetry={() => {
              setErrorMessage(null);
              if (activeFlow === "airgap") {
                void startAirgapSender();
              } else if (viewMode === "host") {
                void initHostSession();
              } else if (joinUriRef.current) {
                // The join through a link failed; retry that join.
                void startFromUri(joinUriRef.current);
              } else {
                dispatchFlow({ type: "set-flow", flow: null });
                backToModes();
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
          {isWaitingState && viewMode === "select-mode" ? (
            <BackButton onClick={() => showView("select-role")} />
          ) : null}
          {isWaitingState && viewMode === "host" ? <BackButton onClick={() => backToModes()} /> : null}
          {status.status === "failed" ? <BackButton onClick={() => backToModes(true)} /> : null}
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
        <div className="error-panel modal-error" role="alert">{errorMessage}</div>
      )}
    </ModalDialog>
    <ConfirmDialog
      open={wifiPrompt != null}
      kicker="Link code"
      title="Turn on Wi-Fi"
      body="Link codes work over the same Wi-Fi network. Turn Wi-Fi on, then come back to continue."
      confirmLabel="Turn On Wi-Fi"
      confirmDanger={false}
      onConfirm={() => {
        void pairingApi.openWifiSettings().catch((cause) => logIgnored("pairing.openWifiSettings", cause));
      }}
      onCancel={() => setWifiPrompt(null)}
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

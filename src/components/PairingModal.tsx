import { useEffect, useRef, useState, type ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import { cancelPairing, pairingApi } from "../api";
import {
  CameraIcon,
  CheckCircleIcon,
  ChevronIcon,
  DownloadIcon,
  KeypadIcon,
  PauseIcon,
  PlayIcon,
  QrIcon,
  RefreshIcon,
  ShieldIcon,
  UploadIcon,
} from "../icons";
import type { AirgapExport, PairingStatus } from "../types";
import { logIgnored } from "../log";
import { isMobileDevice } from "../platform";
import { collectUiState } from "../ui-state";
import { useModalA11y } from "./useModalA11y";
import { ModalCloseButton } from "./ModalCloseButton";
import { useQrScanner } from "../hooks/useQrScanner";
import { useVirtualKeyboard } from "../hooks/useVirtualKeyboard";
import { sanitizeQrSvg } from "../pairing/sanitizeSvg";
import { ScannerView } from "./pairing/views";

type ViewMode = "select-role" | "select-mode" | "host" | "scanner" | "code" | "airgap-sender" | "airgap-confirm";
type IntendedRole = "send" | "receive";

function pairingStep(status: PairingStatus["status"], viewMode: ViewMode): 1 | 2 | 3 {
  if (status === "sasVerification" || status === "transferring" || status === "completed") {
    return 3;
  }
  if (
    viewMode === "select-role" &&
    (status === "idle" || status === "hostWaiting" || status === "receiverWaiting")
  ) {
    return 1;
  }
  return 2;
}

function hostWaitingFields(status: PairingStatus): {
  qrSvg: string;
  qrUri: string;
  fingerprint: string;
  joinCode: string;
} | null {
  if (status.status !== "hostWaiting" && status.status !== "receiverWaiting") return null;
  const data = status.data as unknown as Record<string, unknown>;
  const read = (camel: string, snake: string) => {
    const value = data[camel] ?? data[snake];
    return typeof value === "string" ? value : "";
  };
  return {
    qrSvg: read("qrSvg", "qr_svg"),
    qrUri: read("qrUri", "qr_uri"),
    fingerprint: read("fingerprint", "fingerprint"),
    joinCode: read("joinCode", "join_code"),
  };
}

function formatJoinCode(code: string): string {
  const digits = code.replace(/\D/g, "").slice(0, 6);
  if (digits.length <= 3) return digits;
  return `${digits.slice(0, 3)} ${digits.slice(3)}`;
}

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
  const [viewMode, setViewMode] = useState<ViewMode>("select-role");
  const [intendedRole, setIntendedRole] = useState<IntendedRole | null>(null);
  const [activeFlow, setActiveFlow] = useState<"wifi" | "airgap" | null>(null);
  const [status, setStatus] = useState<PairingStatus>({ status: "idle" });
  const [joinCodeInput, setJoinCodeInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [remainingSecs, setRemainingSecs] = useState<number | null>(null);
  const [confirmedSas, setConfirmedSas] = useState(false);
  const [includeSettings, setIncludeSettings] = useState(false);
  const [isFrontCamera, setIsFrontCamera] = useState(false);
  const [videoReady, setVideoReady] = useState(false);
  const [availableCameras, setAvailableCameras] = useState<MediaDeviceInfo[]>([]);
  const [, setSelectedCameraId] = useState<string | null>(null);
  const [isKeyboardOpen, setIsKeyboardOpen] = useVirtualKeyboard(open);

  // Air-gap visual transfer states
  const [airgapExport, setAirgapExport] = useState<AirgapExport | null>(null);
  const [airgapFrameIndex, setAirgapFrameIndex] = useState(0);
  const [airgapPlaying, setAirgapPlaying] = useState(true);
  const [airgapSpeed, setAirgapSpeed] = useState<"normal" | "slow">("normal");
  const [airgapCapturedChunks, setAirgapCapturedChunks] = useState<Map<number, string>>(new Map());
  const [airgapTotalChunks, setAirgapTotalChunks] = useState<number>(0);
  const [airgapVerifyPrompt, setAirgapPinPrompt] = useState(false);
  const [airgapVerifyCode, setAirgapVerifyCode] = useState<string | null>(null);
  const [airgapVerifying, setAirgapVerifying] = useState(false);
  const [airgapImporting, setAirgapImporting] = useState(false);
  const [scannerRestartKey, setScannerRestartKey] = useState(0);
  const [airgapCaptureSecs, setAirgapCaptureSecs] = useState<number | null>(null);

  const dialogRef = useRef<HTMLElement>(null);
  const hostStartIdRef = useRef(0);
  const hasCompletedRef = useRef(false);
  const airgapSessionIdRef = useRef<string | null>(null);
  const airgapVerifyPromptRef = useRef(false);
  const airgapCaptureStartRef = useRef<number | null>(null);
  const airgapVerifyStartedRef = useRef(false);
  const roleAutoSelectedRef = useRef(false);

  const { videoRef, streamRef, handleScannerTap, handleSwitchCamera } = useQrScanner({
    active: viewMode === "scanner" && open,
    restartKey: scannerRestartKey,
    isFrontCamera,
    availableCameras,
    hostStartIdRef,
    airgapSessionIdRef,
    airgapVerifyPromptRef,
    airgapCaptureStartRef,
    setViewMode,
    setBusy,
    setErrorMessage,
    setCameraError,
    setVideoReady,
    setAvailableCameras,
    setSelectedCameraId,
    setIsFrontCamera,
    setAirgapCapturedChunks,
    setAirgapTotalChunks,
    setAirgapCaptureSecs,
    setAirgapPinPrompt,
  });

  const handleClose = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    if (status.status === "completed" && !hasCompletedRef.current) {
      hasCompletedRef.current = true;
      onCompleted();
    }
    cancelPairing();
    onClose();
  };

  useModalA11y(dialogRef, open, handleClose);

  // Listen for Tauri backend pairing events and poll fallback
  useEffect(() => {
    if (!open) return;

    let unlisten: (() => void) | undefined;
    let pollInterval: ReturnType<typeof setInterval> | undefined;

    const setupListener = async () => {
      try {
        const unsubscribe = await listen<PairingStatus>("pairing-status", (event) => {
          setStatus((prev) => {
            if (hasCompletedRef.current && prev.status === "completed") return prev;
            return event.payload;
          });
        });
        unlisten = unsubscribe;
      } catch (cause) {
        // Event listener unavailable, polling will handle it
        logIgnored("pairing-status listener", cause);
      }
    };

    void setupListener();

    // Poll status every 800ms
    pollInterval = setInterval(() => {
      void pairingApi.status().then((current) => {
        setStatus((prev) => {
          if (hasCompletedRef.current && prev.status === "completed") return prev;
          return current;
        });
      }).catch(() => {
        // Polled every 800ms; a transient failure just retries on the next tick.
      });
    }, 800);

    return () => {
      if (unlisten) unlisten();
      if (pollInterval) clearInterval(pollInterval);
    };
  }, [open]);

  // Handle countdown timer for host
  useEffect(() => {
    if (status.status !== "hostWaiting" && status.status !== "receiverWaiting") {
      setRemainingSecs(null);
      return;
    }

    const raw = status.data as unknown as Record<string, unknown>;
    const expiresAt = typeof status.data.expiresAt === "number"
      ? status.data.expiresAt
      : (typeof raw?.expires_at === "number" ? raw.expires_at : null);

    if (!expiresAt) {
      setRemainingSecs(null);
      return;
    }

    const updateCountdown = () => {
      const nowSecs = Math.floor(Date.now() / 1000);
      const diff = Math.max(0, expiresAt - nowSecs);
      setRemainingSecs(diff);
    };

    updateCountdown();
    const interval = setInterval(updateCountdown, 1000);
    return () => clearInterval(interval);
  }, [status]);

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
  }, [status.status, onCompleted]);

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

  // Playback timer for animated QR code frames in air-gap sender mode
  useEffect(() => {
    if (viewMode !== "airgap-sender" || !airgapExport || !airgapPlaying) return;
    const total = airgapExport.frames.length;
    if (total <= 1) return;
    const intervalMs = airgapSpeed === "slow" ? 280 : 150;
    const timer = setInterval(() => {
      setAirgapFrameIndex((prev) => (prev + 1) % total);
    }, intervalMs);
    return () => clearInterval(timer);
  }, [viewMode, airgapExport, airgapPlaying, airgapSpeed]);

  // Focus management when viewMode or status changes so focus doesn't get lost
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

  // Initialize on modal open: check pending URI or start host
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

  useEffect(() => {
    if (!open) {
      hasCompletedRef.current = false;
      setStatus({ status: "idle" });
      setErrorMessage(null);
      setJoinCodeInput("");
      setViewMode("select-role");
      setIntendedRole(null);
      setActiveFlow(null);
      roleAutoSelectedRef.current = false;
      setBusy(false);
      setConfirmedSas(false);
      setIncludeSettings(false);
      setIsFrontCamera(false);
      setSelectedCameraId(null);
      setAvailableCameras([]);
      setAirgapExport(null);
      setAirgapCapturedChunks(new Map());
      setAirgapTotalChunks(0);
      setAirgapPinPrompt(false);
      airgapVerifyPromptRef.current = false;
      setAirgapVerifyCode(null);
      setAirgapVerifying(false);
      setAirgapImporting(false);
      airgapVerifyStartedRef.current = false;
      airgapSessionIdRef.current = null;
      airgapCaptureStartRef.current = null;
      setAirgapCaptureSecs(null);
      hostStartIdRef.current += 1;
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }
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
        setActiveFlow("wifi");
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

      // Normal modal open: wait on Step 1 for user Wi-Fi network selection
    };

    void checkPendingAndStart();
  }, [open, initialJoinUri]);

  // When all air-gap frames are captured, ask the backend for the
  // verification code to display for human comparison with the sender.
  // Do not put airgapVerifying in the deps: flipping it to true used to
  // cancel this effect and skip a new run, leaving "Checking captured
  // frames…" on screen forever.
  useEffect(() => {
    if (!open || viewMode !== "scanner" || !airgapVerifyPrompt) return;
    if (airgapVerifyCode || airgapVerifyStartedRef.current) return;
    if (airgapTotalChunks === 0 || airgapCapturedChunks.size < airgapTotalChunks) return;
    airgapVerifyStartedRef.current = true;
    setAirgapVerifying(true);
    setErrorMessage(null);
    const chunks = Array.from(airgapCapturedChunks.values());
    void pairingApi
      .verifyAirgapFrames(chunks)
      .then((res) => {
        setAirgapVerifyCode(res.verifyCode);
      })
      .catch((err) => {
        setErrorMessage(err instanceof Error ? err.message : String(err));
        airgapVerifyStartedRef.current = false;
        setAirgapPinPrompt(false);
        airgapVerifyPromptRef.current = false;
        airgapCaptureStartRef.current = null;
        setAirgapCaptureSecs(null);
        setAirgapCapturedChunks(new Map());
        airgapSessionIdRef.current = null;
        setScannerRestartKey((k) => k + 1);
      })
      .finally(() => {
        setAirgapVerifying(false);
      });
  }, [open, viewMode, airgapVerifyPrompt, airgapCapturedChunks, airgapTotalChunks, airgapVerifyCode]);

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

  const handleSelectRole = async (role: "send" | "receive") => {
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
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    setBusy(true);
    setErrorMessage(null);
    setViewMode("airgap-sender");
    try {
      const shouldInclude = includeSettingsOpt ?? includeSettings;
      const ui = shouldInclude ? collectUiState() : undefined;
      const exp = await pairingApi.prepareAirgapExport(shouldInclude, ui);
      setAirgapExport(exp);
      setAirgapFrameIndex(0);
      setAirgapPlaying(true);
    } catch (err) {
      setErrorMessage(String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleAirgapImport = async () => {
    if (airgapImporting || !airgapVerifyCode) return;
    setAirgapImporting(true);
    setErrorMessage(null);
    try {
      const chunks = Array.from(airgapCapturedChunks.values());
      const summary = await pairingApi.importAirgapFrames(chunks);
      hasCompletedRef.current = true;
      airgapVerifyPromptRef.current = false;
      setAirgapPinPrompt(false);
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
      }
      setStatus({
        status: "completed",
        data: { summary },
      });
      onCompleted();
    } catch (err) {
      setErrorMessage(String(err));
    } finally {
      setAirgapImporting(false);
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

  const formatCountdown = (secs: number) => {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
  };

  const isWaitingState =
    status.status === "idle" ||
    status.status === "hostWaiting" ||
    status.status === "receiverWaiting";

  const hasOwnActionButtons =
    status.status === "completed" ||
    status.status === "sasVerification" ||
    (isWaitingState &&
      viewMode !== "host" &&
      viewMode !== "select-mode" &&
      viewMode !== "select-role");

  const onMobileDevice = isMobileDevice();

  const showSwitchCamera =
    availableCameras.length > 1 || onMobileDevice || Boolean(import.meta.env?.DEV);

  const step = airgapVerifyPrompt || viewMode === "airgap-confirm" ? 3 : pairingStep(status.status, viewMode);
  const stepDotsVisible = status.status !== "failed";

  let modalTitle = "Link Devices";
  let modalSubtitle: ReactNode = "Transfer accounts & credentials between devices.";
  if (activeFlow === "airgap" || viewMode === "airgap-sender") {
    modalSubtitle = "On the other device, open Link Devices, select Scan QR code, then scan this QR code below.";
  }
  if (status.status === "clientConnecting" || status.status === "senderConnecting") {
    modalTitle = "Connecting";
    modalSubtitle = "Finding the other device on your Wi-Fi.";
  } else if (isWaitingState && viewMode === "airgap-sender") {
    modalTitle = "Show QR code";
  } else if (isWaitingState && viewMode === "host") {
    modalTitle = "Show Link code";
    modalSubtitle = "On the other device, open Link Devices, select Enter Link code, then enter the code below.";
  } else if (isWaitingState && viewMode === "scanner") {
    modalTitle = "Scan QR code";
    modalSubtitle =
      activeFlow === "airgap"
        ? "Point the camera at the animated QR code on the other device."
        : "Point the camera at the QR code on the other device.";
  } else if (isWaitingState && viewMode === "code") {
    modalTitle = "Enter Link code";
    modalSubtitle = "Type the 6-digit link code shown on the other device.";
  } else if (status.status === "roleSelection") {
    modalTitle = intendedRole ? "Connecting" : "Send or receive accounts";
    modalSubtitle = intendedRole
      ? "Applying send or receive on this device."
      : "Choose what this device should do.";
  } else if (status.status === "peerConnected") {
    modalTitle = "Connected";
    modalSubtitle = "Waiting for the other device to finish connecting.";
  } else if (status.status === "sasVerification") {
    modalTitle = "Confirm the connection";
    modalSubtitle = "Step 3: Make sure both screens show the same code to begin the transfer.";
  } else if (status.status === "transferring") {
    modalTitle = "Transferring";
    modalSubtitle = "Encrypted accounts and groups are moving between devices.";
  } else if (status.status === "completed") {
    modalTitle = "Devices linked";
    modalSubtitle = "Accounts and credentials are synchronized.";
  } else if (isWaitingState && viewMode === "select-mode") {
    modalTitle = "How to connect devices";
    modalSubtitle = "Step 2: Show a pairing code here, or scan or enter the code from your other device.";
  } else if (isWaitingState && viewMode === "select-role") {
    modalTitle = "Send or receive accounts";
    modalSubtitle = "Step 1: Choose a role for this device.";
  }

  // Air-gap receiver finished scanning, or sender opened the confirm
  // view: mirror the Wi-Fi confirm header (title, step 3, subtitle) while
  // codes are compared.
  if (
    isWaitingState &&
    ((viewMode === "scanner" && airgapVerifyPrompt) ||
      viewMode === "airgap-confirm")
  ) {
    modalTitle = "Confirm the connection";
    modalSubtitle = "Step 3: Make sure both screens show the same code to begin the transfer.";
  }

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
        {stepDotsVisible ? (
          <ol className="pairing-step-dots" aria-label={`Step ${step} of 3`}>
            <li className={step === 1 ? "is-active" : step > 1 ? "is-complete" : ""}>Send/receive</li>
            <li className={step === 2 ? "is-active" : step > 2 ? "is-complete" : ""}>Connect</li>
            <li className={step === 3 ? "is-active" : ""}>Confirm</li>
          </ol>
        ) : null}
        <p className="pairing-subtitle">{modalSubtitle}</p>

        <div className="pairing-body">
          {/* STEP 1: SEND OR RECEIVE */}
          {isWaitingState && viewMode === "select-role" && (
            <div className="pairing-role-selection-view">
              <div className="pairing-role-cards">
                <button
                  type="button"
                  className="pairing-role-card"
                  onClick={() => {
                    setIntendedRole("send");
                    setViewMode("select-mode");
                  }}
                >
                  <div className="pairing-role-card-icon send">
                    <UploadIcon />
                  </div>
                  <div className="pairing-role-card-content">
                    <h4>Send accounts from this device</h4>
                    <p>Export accounts, tokens, and groups to another device.</p>
                  </div>
                </button>

                <button
                  type="button"
                  className="pairing-role-card"
                  onClick={() => {
                    setIntendedRole("receive");
                    setViewMode("select-mode");
                  }}
                >
                  <div className="pairing-role-card-icon receive">
                    <DownloadIcon />
                  </div>
                  <div className="pairing-role-card-content">
                    <h4 className="pairing-role-title-receive">Receive accounts on this device</h4>
                    <p>Import accounts, tokens, and groups from another device.</p>
                  </div>
                </button>
              </div>

              <label className="pairing-settings-toggle">
                <input
                  type="checkbox"
                  checked={includeSettings}
                  onChange={(e) => setIncludeSettings(e.target.checked)}
                />
                <span>
                  Transfer the settings &amp; layout config:
                  <small>
                    Including launch-at-login, auto app updates, accounts refresh intervals, alerts & card order.
                  </small>
                </span>
              </label>

              <div className="pairing-security-note">
                <ShieldIcon />
                <span>End-to-end encrypted · Direct device-to-device transfer</span>
              </div>
            </div>
          )}

          {/* STEP 2: SHOW A CODE OR SCAN / ENTER */}
          {isWaitingState && viewMode === "select-mode" && (
            <div className="pairing-mode-select-view">
              <div className="pairing-mode-cards">
                <button
                  type="button"
                  className="pairing-mode-card"
                  onClick={() => {
                    setActiveFlow("wifi");
                    setViewMode("host");
                    void initHostSession();
                  }}
                >
                  <div className="pairing-mode-card-icon wifi">
                    <KeypadIcon />
                  </div>
                  <div className="pairing-mode-card-body">
                    <div className="pairing-mode-card-header">
                      <span className="pairing-mode-card-title">Show Link code</span>
                      <span className="pairing-mode-badge wifi">On same Wi-Fi</span>
                    </div>
                    <p className="pairing-mode-card-desc">
                      Display code to enter on other device. Use if devices are on the same Wi-Fi.
                    </p>
                  </div>
                </button>

                <button
                  type="button"
                  className="pairing-mode-card"
                  onClick={() => {
                    setActiveFlow("wifi");
                    setJoinCodeInput("");
                    setViewMode("code");
                  }}
                >
                  <div className="pairing-mode-card-icon enter">
                    <KeypadIcon />
                  </div>
                  <div className="pairing-mode-card-body">
                    <div className="pairing-mode-card-header">
                      <span className="pairing-mode-card-title">Enter Link code</span>
                      <span className="pairing-mode-badge enter">On same Wi-Fi</span>
                    </div>
                    <p className="pairing-mode-card-desc">
                      Type Link code shown on other device.
                    </p>
                  </div>
                </button>

                {intendedRole !== "receive" ? (
                <button
                  type="button"
                  className="pairing-mode-card"
                  onClick={() => {
                    setActiveFlow("airgap");
                    void startAirgapSender();
                  }}
                >
                  <div className="pairing-mode-card-icon qr">
                    <QrIcon />
                  </div>
                  <div className="pairing-mode-card-body">
                    <div className="pairing-mode-card-header">
                      <span className="pairing-mode-card-title">Show QR code</span>
                      <span className="pairing-mode-badge qr">No Wi-Fi needed</span>
                    </div>
                    <p className="pairing-mode-card-desc">
                      Displays animated QR code to scan. Use if devices are on different networks.
                    </p>
                  </div>
                </button>
                ) : null}

                <button
                  type="button"
                  className="pairing-mode-card"
                  onClick={() => {
                    setActiveFlow("wifi");
                    setCameraError(null);
                    void pairingApi.ensureCameraPermission()
                      .catch((cause) => logIgnored("pairing.cameraPermission", cause))
                      .finally(() => setViewMode("scanner"));
                  }}
                >
                  <div className="pairing-mode-card-icon scan">
                    <CameraIcon />
                  </div>
                  <div className="pairing-mode-card-body">
                    <div className="pairing-mode-card-header">
                      <span className="pairing-mode-card-title">Scan QR code</span>
                      <span className="pairing-mode-badge scan">Uses camera</span>
                    </div>
                    <p className="pairing-mode-card-desc">
                      Scan QR code shown on other device.
                    </p>
                  </div>
                </button>
              </div>
            </div>
          )}

          {/* VIEW 1: HOST QR CODE DISPLAY */}
          {isWaitingState && viewMode === "host" && (() => {
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
                  <div
                    className="pairing-join-code-card"
                    aria-label={`Link code ${formatJoinCode(joinCode)}`}
                  >
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
          })()}

          {/* VIEW 2: IN-APP CAMERA SCANNER */}
          {isWaitingState && viewMode === "scanner" && (
            <ScannerView
              airgapVerifyPrompt={airgapVerifyPrompt}
              airgapTotalChunks={airgapTotalChunks}
              airgapCaptureSecs={airgapCaptureSecs}
              airgapVerifying={airgapVerifying}
              airgapVerifyCode={airgapVerifyCode}
              airgapImporting={airgapImporting}
              airgapCapturedChunks={airgapCapturedChunks}
              cameraError={cameraError}
              isFrontCamera={isFrontCamera}
              videoReady={videoReady}
              showSwitchCamera={showSwitchCamera}
              videoRef={videoRef}
              setVideoReady={setVideoReady}
              onScannerTap={() => void handleScannerTap()}
              onSwitchCamera={() => void handleSwitchCamera()}
              onAirgapBack={() => {
                setAirgapPinPrompt(false);
                airgapVerifyPromptRef.current = false;
                airgapVerifyStartedRef.current = false;
                airgapCaptureStartRef.current = null;
                setAirgapCaptureSecs(null);
                setAirgapCapturedChunks(new Map());
                setAirgapVerifyCode(null);
                setViewMode("scanner");
                setScannerRestartKey((k) => k + 1);
              }}
              onAirgapImport={() => void handleAirgapImport()}
              onBack={() => {
                if (activeFlow === "airgap") {
                  setViewMode("airgap-sender");
                  return;
                }
                cancelPairing();
                setStatus({ status: "idle" });
                setAirgapCapturedChunks(new Map());
                setAirgapTotalChunks(0);
                setAirgapVerifyCode(null);
                airgapVerifyStartedRef.current = false;
                airgapSessionIdRef.current = null;
                airgapCaptureStartRef.current = null;
                setAirgapCaptureSecs(null);
                setViewMode("select-mode");
              }}
            />
          )}

          {isWaitingState && viewMode === "code" && (
            <div className="pairing-code-entry-view">
              <input
                id="pairing-join-code-input"
                className="pairing-code-input"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]*"
                maxLength={6}
                placeholder="000 000"
                value={joinCodeInput}
                autoFocus
                disabled={busy}
                onFocus={() => {
                  const isMobile =
                    isMobileDevice();
                  if (isMobile) setIsKeyboardOpen(true);
                }}
                onBlur={() => {
                  setTimeout(() => {
                    const activeEl = document.activeElement;
                    if (activeEl?.id !== "pairing-join-code-input") {
                      const vv = window.visualViewport;
                      if (!vv || window.innerHeight - vv.height <= 100) {
                        setIsKeyboardOpen(false);
                      }
                    }
                  }, 120);
                }}
                onChange={(event) => {
                  const digits = event.target.value.replace(/\D/g, "").slice(0, 6);
                  setJoinCodeInput(digits);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && joinCodeInput.length === 6) {
                    void handleConnectByCode(joinCodeInput);
                  }
                }}
                aria-describedby="pairing-code-help"
              />
              <p id="pairing-code-help" className="pairing-code-help">
                Both devices must be connected to the same Wi-Fi network.
              </p>

              <div className="pairing-security-note">
                <ShieldIcon />
                <span>End-to-end encrypted · Direct peer-to-peer transfer</span>
              </div>

              <div className="pairing-scanner-controls pairing-code-actions">
                <button
                  type="button"
                  className="button pairing-back-btn"
                  onClick={() => setViewMode("select-mode")}
                >
                  <ChevronIcon style={{ transform: "rotate(180deg)" }} />
                  <span>Back</span>
                </button>
                <button
                  type="button"
                  className="button primary"
                  disabled={busy || joinCodeInput.length !== 6}
                  onClick={() => void handleConnectByCode(joinCodeInput)}
                >
                  {busy ? "Connecting…" : "Connect to Device"}
                </button>
              </div>
            </div>
          )}

          {/* VIEW 4: AIR-GAP ANIMATED QR SENDER */}
          {isWaitingState && viewMode === "airgap-sender" && (
            <div className="airgap-sender-view">
              {busy || !airgapExport ? (
                <div className="pairing-panel-status">
                  <span className="spinner" />
                  <h3>Preparing animated transfer…</h3>
                  <p>Compressing and encrypting accounts with air-gap PIN.</p>
                </div>
              ) : (
                <div className="airgap-sender-content">
                  <div className="airgap-qr-stage">
                    <div
                      className="pairing-qr-card airgap-qr-card"
                      dangerouslySetInnerHTML={{
                        __html: sanitizeQrSvg(airgapExport.frames[airgapFrameIndex]?.svg || ""),
                      }}
                      aria-label={`Air-gap Frame ${airgapFrameIndex + 1} of ${airgapExport.totalChunks}`}
                    />

                    <div className="airgap-playback-bar">
                      <span className="airgap-frame-pill">
                        Frame {String(airgapFrameIndex + 1).padStart(String(airgapExport.totalChunks).length, "0")}/{airgapExport.totalChunks}
                      </span>
                      <button
                        type="button"
                        className="button ghost compact-button airgap-control-btn"
                        onClick={() => setAirgapPlaying((p) => !p)}
                        aria-label={airgapPlaying ? "Pause animation" : "Play animation"}
                      >
                        {airgapPlaying ? <PauseIcon /> : <PlayIcon />}
                        <span>{airgapPlaying ? "Pause" : "Play"}</span>
                      </button>
                      <button
                        type="button"
                        className="button ghost compact-button airgap-control-btn"
                        onClick={() => setAirgapSpeed((s) => (s === "normal" ? "slow" : "normal"))}
                        aria-label="Toggle playback speed"
                      >
                        Speed: {airgapSpeed === "normal" ? "Normal" : "Slow"}
                      </button>
                    </div>
                  </div>

                  <div className="airgap-verify-block">
                    <p className="airgap-pin-hint">
                      <button
                        type="button"
                        className="pairing-offline-link"
                        onClick={() => setViewMode("airgap-confirm")}
                      >
                        After all frames are scanned, click here to continue.
                      </button>
                    </p>
                    <div className="pairing-nav-row">
                      <button
                        type="button"
                        className="button pairing-back-btn"
                      onClick={() => {
                        setAirgapExport(null);
                        setActiveFlow(null);
                        setAirgapCapturedChunks(new Map());
                        setAirgapTotalChunks(0);
                        setAirgapVerifyCode(null);
                        airgapVerifyStartedRef.current = false;
                        airgapSessionIdRef.current = null;
                        airgapCaptureStartRef.current = null;
                        setAirgapCaptureSecs(null);
                        setViewMode("select-mode");
                      }}
                      >
                        <ChevronIcon style={{ transform: "rotate(180deg)" }} />
                        <span>Back</span>
                      </button>
                      <button
                        type="button"
                        className="button ghost"
                        onClick={handleClose}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* AIR-GAP SENDER CONFIRM: verification code reveal */}
          {isWaitingState && viewMode === "airgap-confirm" && airgapExport && (
            <div className="airgap-pin-prompt-card">
              <div className="pairing-sas-icon"><ShieldIcon /></div>
              <h3>Do both devices show this code?</h3>
              <p className="pairing-instruction">
                Compare this code with the receiving device. Import only if both screens match.
              </p>

              <div
                className="pairing-sas-badge"
                aria-label={`Verification code ${airgapExport.verifyCode}`}
              >
                {airgapExport.verifyCode}
              </div>

              <div className="airgap-prompt-actions">
                <button
                  type="button"
                  className="button pairing-back-btn"
                  onClick={() => setViewMode("airgap-sender")}
                >
                  <ChevronIcon style={{ transform: "rotate(180deg)" }} />
                  <span>Back</span>
                </button>
                <button
                  type="button"
                  className="button ghost"
                  onClick={handleClose}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* CLIENT CONNECTING */}
          {(status.status === "clientConnecting" || status.status === "senderConnecting") && (
            <div className="pairing-panel-status">
              <span className="spinner" />
              <h3>Connecting…</h3>
              <p>Finding the other device on your Wi-Fi and opening an encrypted link.</p>
            </div>
          )}

          {/* PEER CONNECTED (HOST WAITING FOR ROLE SELECTION) */}
          {status.status === "peerConnected" && (
            <div className="pairing-panel-status">
              <span className="spinner" />
              <h3>Connected</h3>
              <p>Waiting for the other device to finish connecting…</p>
            </div>
          )}

          {/* ROLE SELECTION: auto-applied when chosen in step 1; fallback if this device joined via a pairing link */}
          {status.status === "roleSelection" && !intendedRole && (
            <div className="pairing-role-selection-view">
              <div className="pairing-section-heading">
                <p className="pairing-role-instruction">
                  Devices are connected. Choose what this device should do:
                </p>
              </div>

              <div className="pairing-role-cards">
                <button
                  type="button"
                  className="pairing-role-card"
                  disabled={busy}
                  onClick={() => void handleSelectRole("send")}
                >
                  <div className="pairing-role-card-icon send">
                    <UploadIcon />
                  </div>
                  <div className="pairing-role-card-content">
                    <h4>Send accounts from this device</h4>
                    <p>Export accounts, tokens, and groups to another device.</p>
                  </div>
                </button>

                <button
                  type="button"
                  className="pairing-role-card"
                  disabled={busy}
                  onClick={() => void handleSelectRole("receive")}
                >
                  <div className="pairing-role-card-icon receive">
                    <DownloadIcon />
                  </div>
                  <div className="pairing-role-card-content">
                    <h4 className="pairing-role-title-receive">Receive accounts on this device</h4>
                    <p>Import accounts, tokens, and groups from another device.</p>
                  </div>
                </button>
              </div>
            </div>
          )}

          {status.status === "roleSelection" && intendedRole && (
            <div className="pairing-panel-status">
              <span className="spinner" />
              <h3>{intendedRole === "send" ? "Sending from this device…" : "Receiving on this device…"}</h3>
              <p>Finishing the connection so both devices can confirm the code.</p>
            </div>
          )}

          {/* SAS VERIFICATION ON BOTH SIDES */}
          {status.status === "sasVerification" && (() => {
            const rawSas = status.data as unknown as Record<string, unknown>;
            const sasCode = status.data.sasCode || (rawSas.sas_code as string) || "";
            const sessionId = status.data.sessionId || (rawSas.session_id as string) || "";
            const role = status.data.role || (rawSas.role as string) || "";
            const accountCount = status.data.accountCount ?? (rawSas.account_count as number | undefined);
            const isSender = role === "sender";

            return (
              <div className="pairing-sas-card">
                <div className="pairing-sas-icon"><ShieldIcon /></div>
                <h3>Do both devices show this code?</h3>

                <div className="pairing-sas-badge" aria-label={`Verification code ${sasCode}`}>
                  {sasCode}
                </div>

                <div className={`pairing-transfer-info ${isSender ? "sender" : "receiver"}`}>
                  {isSender ? (
                    <>Ready to <strong>send {accountCount ?? ""} account(s)</strong> and groups</>
                  ) : (
                    <>Ready to <strong>receive {accountCount ?? ""} account(s)</strong> and groups</>
                  )}
                </div>

                <div className="pairing-sas-actions">
                  <button
                    type="button"
                    className="button primary"
                    disabled={busy || confirmedSas}
                    onClick={() => void handleConfirmSas(sessionId, true, role)}
                  >
                    {confirmedSas ? (
                      <>
                        <span className="spinner button-spinner" />
                        <span>Waiting for other device…</span>
                      </>
                    ) : (
                      "Yes, codes match"
                    )}
                  </button>
                  <button
                    type="button"
                    className="button ghost"
                    disabled={busy || confirmedSas}
                    onClick={() => void handleConfirmSas(sessionId, false, role)}
                  >
                    Cancel
                  </button>
                </div>

                {confirmedSas && (
                  <div className="pairing-sas-waiting-note">
                    <span className="spinner button-spinner" />
                    <span>Confirmed on this device. Waiting for the other device to confirm…</span>
                  </div>
                )}
              </div>
            );
          })()}

          {/* TRANSFERRING IN PROGRESS */}
          {status.status === "transferring" && (
            <div className="pairing-panel-status transferring">
              <span className="spinner large" />
              <h3>Transferring Data…</h3>
              <p>Securely exchanging encrypted accounts and groups over your local network.</p>
            </div>
          )}

          {/* COMPLETED SUCCESS */}
          {status.status === "completed" && (
            <div className="pairing-completed-card">
              <div className="pairing-success-icon"><CheckCircleIcon /></div>
              <h3>Transfer Complete!</h3>
              <div className="pairing-summary-chips">
                <span className="pairing-summary-chip added">
                  <strong>+{status.data.summary.added}</strong> Added
                </span>
                <span className="pairing-summary-chip updated">
                  <strong>↻ {status.data.summary.updated}</strong> Updated
                </span>
                <span className="pairing-summary-chip skipped">
                  <strong>{status.data.summary.skipped}</strong> Skipped
                </span>
              </div>
              <p className="pairing-completed-text">
                Your accounts and credentials have been securely synchronized.
              </p>
              <button
                type="button"
                className="button primary pairing-done-btn"
                onClick={handleDone}
              >
                Done
              </button>
            </div>
          )}

          {/* FAILED ERROR */}
          {status.status === "failed" && (
            <div className="pairing-error-card">
              <h3>Pairing Failed</h3>
              <div className="error-panel modal-error">{status.data.error}</div>
              <div className="pairing-error-actions">
                <button
                  type="button"
                  className="button primary"
                  onClick={() => {
                    setErrorMessage(null);
                    if (activeFlow === "airgap") {
                      void startAirgapSender();
                    } else if (viewMode === "host") {
                      void initHostSession();
                    } else {
                      cancelPairing();
                      setStatus({ status: "idle" });
                      setActiveFlow(null);
                      setViewMode("select-mode");
                    }
                  }}
                >
                  <RefreshIcon />
                  <span>Try Again</span>
                </button>
              </div>
            </div>
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
              <button
                type="button"
                className="button pairing-back-btn"
                onClick={() => setViewMode("select-role")}
              >
                <ChevronIcon style={{ transform: "rotate(180deg)" }} />
                <span>Back</span>
              </button>
            ) : null}
            {isWaitingState && viewMode === "host" ? (
              <button
                type="button"
                className="button pairing-back-btn"
                onClick={() => {
                  cancelPairing();
                  setStatus({ status: "idle" });
                  setActiveFlow(null);
                  setViewMode("select-mode");
                }}
              >
                <ChevronIcon style={{ transform: "rotate(180deg)" }} />
                <span>Back</span>
              </button>
            ) : null}
            {status.status === "failed" ? (
              <button
                type="button"
                className="button pairing-back-btn"
                onClick={() => {
                  cancelPairing();
                  setErrorMessage(null);
                  setStatus({ status: "idle" });
                  setActiveFlow(null);
                  setViewMode("select-mode");
                }}
              >
                <ChevronIcon style={{ transform: "rotate(180deg)" }} />
                <span>Back</span>
              </button>
            ) : null}
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

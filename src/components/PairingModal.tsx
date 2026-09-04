import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { pairingApi } from "../api";
import {
  CameraIcon,
  CheckCircleIcon,
  ChevronIcon,
  DownloadIcon,
  KeypadIcon,
  RefreshIcon,
  ShieldIcon,
  UploadIcon,
} from "../icons";
import type { PairingStatus } from "../types";
import { useModalA11y } from "./useModalA11y";
import jsQR from "jsqr";

type ViewMode = "host" | "scanner" | "code";

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
  const [viewMode, setViewMode] = useState<ViewMode>("host");
  const [status, setStatus] = useState<PairingStatus>({ status: "idle" });
  const [joinCodeInput, setJoinCodeInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [remainingSecs, setRemainingSecs] = useState<number | null>(null);
  const [confirmedSas, setConfirmedSas] = useState(false);
  const [isFrontCamera, setIsFrontCamera] = useState(false);

  const dialogRef = useRef<HTMLElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const hostStartIdRef = useRef(0);

  const handleClose = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    if (status.status === "completed") {
      onCompleted();
    }
    void pairingApi.cancel().catch(() => {});
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
          setStatus(event.payload);
        });
        unlisten = unsubscribe;
      } catch {
        // Event listener unavailable, polling will handle it
      }
    };

    void setupListener();

    // Poll status every 800ms
    pollInterval = setInterval(() => {
      void pairingApi.status().then((current) => {
        setStatus(current);
      }).catch(() => {});
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
      onCompleted();
    }
  }, [status.status, onCompleted]);

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
      setStatus({ status: "idle" });
      setErrorMessage(null);
      setJoinCodeInput("");
      setViewMode("host");
      setBusy(false);
      setConfirmedSas(false);
      setIsFrontCamera(false);
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
            pairingApi.getPendingPairingUri().catch(() => null),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), 1500)),
          ]);
        } catch {}
      }

      if (
        pendingUri &&
        (pendingUri.startsWith("aiusage-pair:") || pendingUri.startsWith("aiusage:"))
      ) {
        hostStartIdRef.current += 1;
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

      await initHostSession();
    };

    void checkPendingAndStart();
  }, [open, initialJoinUri]);

  // In-app camera scanning loop
  useEffect(() => {
    if (viewMode !== "scanner" || !open) {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
      }
      return;
    }

    let active = true;
    let animFrameId: number;

    const startCamera = async () => {
      try {
        setCameraError(null);

        const mediaDevices = navigator.mediaDevices;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const nav = navigator as any;
        const getUserMediaFn = mediaDevices?.getUserMedia
          ? (c: MediaStreamConstraints) => mediaDevices.getUserMedia(c)
          : nav.webkitGetUserMedia
          ? (c: MediaStreamConstraints) =>
              new Promise<MediaStream>((res, rej) => nav.webkitGetUserMedia(c, res, rej))
          : nav.mozGetUserMedia
          ? (c: MediaStreamConstraints) =>
              new Promise<MediaStream>((res, rej) => nav.mozGetUserMedia(c, res, rej))
          : null;

        if (!getUserMediaFn) {
          if (!window.isSecureContext) {
            setCameraError(
              "Camera access requires a secure context (HTTPS or localhost). Please check app configuration."
            );
          } else {
            setCameraError(
              "Camera access is not supported on this device or webview. You can enter the 6-digit Link Code instead."
            );
          }
          return;
        }

        const isMobile =
          typeof navigator !== "undefined" &&
          /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

        let stream: MediaStream | null = null;
        try {
          // Attempt 1: On mobile phones/tablets, prefer rear camera ("environment") to point at other screens.
          // On laptops/desktops (Windows laptops, MacBooks, PC webcams), prefer front-facing camera ("user").
          stream = await getUserMediaFn({
            video: {
              facingMode: { ideal: isMobile ? "environment" : "user" },
              width: { ideal: 1280 },
              height: { ideal: 720 },
            },
          });
        } catch (initialErr) {
          // Attempt 2: Fall back to basic video constraint (USB webcams on Mac mini/PC, integrated laptop cameras)
          try {
            stream = await getUserMediaFn({ video: true });
          } catch (fallbackErr) {
            const err = fallbackErr || initialErr;
            const errName = (err as { name?: string })?.name;
            if (errName === "NotAllowedError" || errName === "PermissionDeniedError") {
              setCameraError(
                "Camera permission was denied. Please allow camera access in System Settings > Privacy & Security > Camera."
              );
            } else if (errName === "NotFoundError" || errName === "DevicesNotFoundError") {
              setCameraError(
                "No camera detected. Please verify your webcam is connected."
              );
            } else if (errName === "NotReadableError" || errName === "TrackStartError") {
              setCameraError("Camera is currently in use by another application.");
            } else {
              setCameraError(`Camera error: ${String(err)}`);
            }
            return;
          }
        }

        if (!active || !stream) {
          if (stream) {
            stream.getTracks().forEach((t) => t.stop());
          }
          return;
        }

        const videoTrack = stream.getVideoTracks()[0];
        const settings = videoTrack?.getSettings?.();
        const facing = settings?.facingMode;
        setIsFrontCamera(facing === "user" || (!facing && !isMobile));

        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          try {
            await videoRef.current.play();
          } catch {
            // WebViews may trigger playback on loadedmetadata
          }
        }

        // Native BarcodeDetector (Android/Chrome) + cross-platform jsQR fallback (Windows/macOS/Safari)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const nativeDetector = "BarcodeDetector" in window
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ? new (window as any).BarcodeDetector({ formats: ["qr_code"] })
          : null;

        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d", { willReadFrequently: true });

        let scanning = false;
        const scan = async () => {
          if (!active || !videoRef.current) return;
          if (scanning) {
            animFrameId = requestAnimationFrame(scan);
            return;
          }
          scanning = true;

          try {
            const video = videoRef.current;
            if (video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) {
              let detectedCode: string | null = null;

              // 1. Try native BarcodeDetector if supported
              if (nativeDetector) {
                try {
                  const codes = await nativeDetector.detect(video);
                  if (codes.length > 0 && codes[0].rawValue) {
                    detectedCode = codes[0].rawValue.trim();
                  }
                } catch {
                  // Fall back to jsQR
                }
              }

              // 2. Cross-platform fallback: decode with jsQR via offscreen canvas
              // attemptBoth checks standard (dark-on-light) and inverted (light-on-dark), resilient to screen reflections
              if (!detectedCode && ctx) {
                if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
                  canvas.width = video.videoWidth;
                  canvas.height = video.videoHeight;
                }
                ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
                const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
                const result = jsQR(imageData.data, imageData.width, imageData.height, {
                  inversionAttempts: "attemptBoth",
                });
                if (result?.data) {
                  detectedCode = result.data.trim();
                }
              }

              if (
                detectedCode &&
                (detectedCode.startsWith("aiusage-pair:") || detectedCode.startsWith("aiusage:"))
              ) {
                if (streamRef.current) {
                  streamRef.current.getTracks().forEach((t) => t.stop());
                  streamRef.current = null;
                }
                setViewMode("host");
                hostStartIdRef.current += 1;
                setBusy(true);
                setErrorMessage(null);
                await pairingApi.startClient(detectedCode);
                return;
              }
            }
          } catch {
            // Ignore per-frame processing errors
          } finally {
            scanning = false;
          }
          animFrameId = requestAnimationFrame(scan);
        };
        animFrameId = requestAnimationFrame(scan);
      } catch (err) {
        setCameraError(`Camera error: ${String(err)}`);
      }
    };

    void startCamera();

    return () => {
      active = false;
      if (animFrameId) cancelAnimationFrame(animFrameId);
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }
    };
  }, [viewMode, open]);

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
      setBusy(false);
    }
  };

  const handleConfirmSas = async (sessionId: string, confirmed: boolean) => {
    if (confirmed) {
      setConfirmedSas(true);
    }
    setBusy(true);
    try {
      await pairingApi.confirmSas(sessionId, confirmed);
    } catch (err) {
      setErrorMessage(String(err));
      setConfirmedSas(false);
    } finally {
      setBusy(false);
    }
  };

  const handleDone = () => {
    onCompleted();
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
    (isWaitingState && viewMode !== "host");

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(e) => e.target === e.currentTarget && handleClose()}
    >
      <section
        ref={dialogRef}
        className={`modal-card pairing-modal ${isWaitingState && viewMode === "code" ? "view-code-entry" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="pairing-modal-title"
        tabIndex={-1}
      >
        <button
          type="button"
          className="ui-modal-close"
          data-react-close="true"
          onClick={handleClose}
          disabled={status.status === "transferring"}
          aria-label="Close dialog"
          title="Close"
        >
          ×
        </button>
        <div className="modal-kicker">Local Device Sync</div>
        <h2 id="pairing-modal-title">Link Devices</h2>
        <p className="pairing-subtitle">
          Transfer accounts & credentials securely over Wi-Fi.
        </p>

        <div className="pairing-body">
          {/* VIEW 1: HOST QR CODE DISPLAY */}
          {isWaitingState && viewMode === "host" && (() => {
            const host = hostWaitingFields(status);
            const joinCode = host?.joinCode ?? "";
            if (!host?.qrSvg && !joinCode) {
              return (
                <div className="pairing-panel-status">
                  <span className="spinner" />
                  <h3>Starting pairing session…</h3>
                  <p>Preparing a link code and QR code for the other device.</p>
                </div>
              );
            }
            return (
              <div className="pairing-host-content">
                <p className="pairing-instruction">
                  To link your devices, enter the below code or scan the QR code from your other device.
                </p>

                {joinCode ? (
                  <div
                    className="pairing-join-code-card"
                    aria-label={`Link code ${formatJoinCode(joinCode)}`}
                  >
                    <span className="pairing-join-code-tag">LINK CODE</span>
                    <strong className="pairing-join-code-val">{formatJoinCode(joinCode)}</strong>
                  </div>
                ) : null}

                {host?.qrSvg ? (
                  <div
                    className="pairing-qr-card"
                    dangerouslySetInnerHTML={{
                      __html: host.qrSvg.replace(/^<\?xml[^>]*\?>/i, "").trim(),
                    }}
                    aria-label="Pairing QR Code"
                  />
                ) : null}

                <div className="pairing-meta-row">
                  {host?.fingerprint ? (
                    <span className="pairing-meta-tag session" aria-label={`Session: ${host.fingerprint}`}>
                      Session: <strong>{host.fingerprint}</strong>
                    </span>
                  ) : null}
                  {remainingSecs !== null && (
                    <span className="pairing-meta-tag timer">
                      Expires in <strong>{formatCountdown(remainingSecs)}</strong>
                    </span>
                  )}
                </div>

                <div className="pairing-switch-actions">
                  <button
                    type="button"
                    className="button secondary pairing-switch-btn"
                    onClick={() => setViewMode("scanner")}
                  >
                    <CameraIcon />
                    <span>Scan QR</span>
                  </button>
                  <button
                    type="button"
                    className="button secondary pairing-switch-btn"
                    onClick={() => setViewMode("code")}
                  >
                    <KeypadIcon />
                    <span>Enter Code</span>
                  </button>
                </div>

                <div className="pairing-waiting-indicator">
                  <span className="spinner" />
                  <span>Waiting for connection from other device…</span>
                </div>
              </div>
            );
          })()}

          {/* VIEW 2: IN-APP CAMERA SCANNER */}
          {isWaitingState && viewMode === "scanner" && (
            <div className="pairing-scanner-view">
              <p className="pairing-instruction">
                Scan the QR code on your other device, or click Enter Code to enter its Link Code:
              </p>

              <div className="pairing-scanner-box">
                <video
                  ref={videoRef}
                  autoPlay
                  playsInline
                  muted
                  tabIndex={-1}
                  className={`pairing-scanner-video ${isFrontCamera ? "mirrored" : ""}`}
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

              {cameraError && (
                <div className="error-panel modal-error">{cameraError}</div>
              )}

              <div className="pairing-scanner-controls">
                <button
                  type="button"
                  className="button pairing-back-btn"
                  onClick={() => setViewMode("host")}
                >
                  Back to My QR
                </button>
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => setViewMode("code")}
                >
                  <KeypadIcon />
                  <span>Enter Code</span>
                </button>
              </div>
            </div>
          )}

          {isWaitingState && viewMode === "code" && (
            <div className="pairing-code-entry-view">
              <p className="pairing-instruction">
                Enter the 6-digit link code shown on the other device:
              </p>

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

              <div className="pairing-scanner-controls">
                <button
                  type="button"
                  className="button pairing-back-btn"
                  onClick={() => setViewMode("host")}
                >
                  Back to My QR
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

          {/* CLIENT CONNECTING */}
          {(status.status === "clientConnecting" || status.status === "senderConnecting") && (
            <div className="pairing-panel-status">
              <span className="spinner" />
              <h3>Connecting to Device…</h3>
              <p>Establishing direct encrypted peer-to-peer channel over local network.</p>
            </div>
          )}

          {/* PEER CONNECTED (HOST WAITING FOR ROLE SELECTION) */}
          {status.status === "peerConnected" && (
            <div className="pairing-panel-status">
              <span className="spinner" />
              <h3>Device Connected!</h3>
              <p>Waiting for the other device to choose the transfer direction…</p>
              {status.data.fingerprint && (
                <div className="pairing-fingerprint-badge">
                  Session: <strong>{status.data.fingerprint}</strong>
                </div>
              )}
            </div>
          )}

          {/* ROLE SELECTION (CLIENT CHOOSES ROLE) */}
          {status.status === "roleSelection" && (
            <div className="pairing-role-selection-view">
              <div className="pairing-section-heading">
                <h3>Choose Transfer Direction</h3>
                <p className="pairing-role-instruction">
                  Select what you want to do on this device:
                </p>
              </div>

              {status.data.fingerprint && (
                <div className="pairing-fingerprint-badge">
                  Session: <strong>{status.data.fingerprint}</strong>
                </div>
              )}

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
                    <p>Export accounts, tokens, and groups to the other device.</p>
                  </div>
                  <div className="pairing-role-card-arrow">
                    <ChevronIcon />
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
                    <h4>Receive accounts on this device</h4>
                    <p>Import accounts and groups from the other device.</p>
                  </div>
                  <div className="pairing-role-card-arrow">
                    <ChevronIcon />
                  </div>
                </button>
              </div>
            </div>
          )}

          {/* SAS VERIFICATION ON BOTH SIDES */}
          {status.status === "sasVerification" && (() => {
            const rawSas = status.data as unknown as Record<string, unknown>;
            const sasCode = status.data.sasCode || (rawSas.sas_code as string) || "";
            const sessionId = status.data.sessionId || (rawSas.session_id as string) || "";
            const fingerprint = status.data.fingerprint || (rawSas.fingerprint as string) || "";
            const role = status.data.role || (rawSas.role as string) || "";
            const accountCount = status.data.accountCount ?? (rawSas.account_count as number | undefined);
            const isSender = role === "sender";

            return (
              <div className="pairing-sas-card">
                <div className="pairing-sas-icon"><ShieldIcon /></div>
                <h3>Confirm Verification Code</h3>
                <p className="pairing-sas-instruction">
                  Both devices must display the exact same code:
                </p>

                {fingerprint && (
                  <div className="pairing-fingerprint-badge">
                    Session: <strong>{fingerprint}</strong>
                  </div>
                )}

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
                    onClick={() => void handleConfirmSas(sessionId, true)}
                  >
                    {confirmedSas ? (
                      <>
                        <span className="spinner button-spinner" />
                        <span>Waiting for other device…</span>
                      </>
                    ) : (
                      "Confirm Transfer"
                    )}
                  </button>
                  <button
                    type="button"
                    className="button ghost"
                    disabled={busy || confirmedSas}
                    onClick={() => void handleConfirmSas(sessionId, false)}
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
              <button
                type="button"
                className="button primary"
                onClick={() => {
                  setErrorMessage(null);
                  void initHostSession();
                }}
              >
                <RefreshIcon />
                <span>Try Again</span>
              </button>
            </div>
          )}

          {errorMessage && (
            <div className="error-panel modal-error">{errorMessage}</div>
          )}
        </div>

        {/* Modal footer actions: only shown when the active view doesn't have inline action buttons */}
        {!hasOwnActionButtons && (
          <div className="modal-actions">
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

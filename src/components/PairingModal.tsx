import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { pairingApi } from "../api";
import {
  CameraIcon,
  CheckCircleIcon,
  ChevronIcon,
  DownloadIcon,
  FlipCameraIcon,
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

function scoreCamera(device: MediaDeviceInfo): number {
  const label = (device.label || "").toLowerCase();

  // Strongly penalize front / selfie / user cameras
  if (
    label.includes("front") ||
    label.includes("user") ||
    label.includes("selfie") ||
    label.includes("forward")
  ) {
    return -1000;
  }

  let score = 0;

  // Confirm it is a back / rear / environment camera
  const isBack =
    label.includes("back") ||
    label.includes("rear") ||
    label.includes("environment");
  if (isBack) {
    score += 100;
  }

  // De-prioritize auxiliary lenses that cannot focus closely on QR codes
  if (
    label.includes("ultra") ||
    label.includes("wide-angle") ||
    label.includes("ultrawide") ||
    label.includes("0.5x")
  ) {
    score -= 80;
  }
  if (
    label.includes("tele") ||
    label.includes("zoom") ||
    label.includes("periscope") ||
    /\b(2x|3x|5x|10x)\b/.test(label)
  ) {
    score -= 70;
  }
  if (
    label.includes("macro") ||
    label.includes("depth") ||
    label.includes("virtual") ||
    label.includes("ir") ||
    label.includes("infrared") ||
    label.includes("logical")
  ) {
    score -= 60;
  }

  // Favor primary / main / standard wide camera
  if (
    label.includes("main") ||
    label.includes("primary") ||
    label.includes("standard") ||
    label.includes("1x")
  ) {
    score += 80;
  }
  if (label.includes("wide") && !label.includes("ultra")) {
    score += 50;
  }

  // Android Camera HAL 0 (or camera2 0) is the primary back camera across virtually all Android devices
  if (
    /camera2?\s*0\b/.test(label) ||
    /\bcamera\s*0\b/.test(label) ||
    /\(0\)/.test(label) ||
    label.endsWith(" 0") ||
    label.includes("camera 0,")
  ) {
    score += 90;
  } else if (/camera2?\s*[2-9]\b/.test(label)) {
    // Camera 2, 3, etc. are auxiliary lenses
    score -= 40;
  }

  return score;
}

function extractCameraIndex(label: string): number | null {
  const normalized = label.toLowerCase();
  const match =
    normalized.match(/camera2?\s*(\d+)/) ||
    normalized.match(/\bcamera\s*(\d+)/) ||
    normalized.match(/\((\d+)\)/);
  if (match && match[1] !== undefined) {
    return parseInt(match[1], 10);
  }
  return null;
}

function isFrontFacingCamera(device: MediaDeviceInfo): boolean {
  const label = (device.label || "").toLowerCase();
  if (
    label.includes("front") ||
    label.includes("user") ||
    label.includes("selfie")
  ) {
    return true;
  }
  // Android Camera2 HAL: camera 1 is standard front facing
  const idx = extractCameraIndex(label);
  if (idx === 1 && !label.includes("back") && !label.includes("rear")) {
    return true;
  }
  return false;
}

function classifyAndDeduplicateCameras(devices: MediaDeviceInfo[]): MediaDeviceInfo[] {
  const videoInputs = devices.filter((d) => d.kind === "videoinput");
  if (videoInputs.length <= 1) return videoInputs;

  // Deduplicate by deviceId or label or fallback index
  const uniqueDevices: MediaDeviceInfo[] = [];
  const seenKeys = new Set<string>();
  for (let i = 0; i < videoInputs.length; i++) {
    const d = videoInputs[i];
    const key = (d.deviceId && d.deviceId.length > 0) ? d.deviceId : (d.label || `camera_${i}`);
    if (!seenKeys.has(key)) {
      seenKeys.add(key);
      uniqueDevices.push(d);
    }
  }

  const devicesToProcess = uniqueDevices.length > 0 ? uniqueDevices : videoInputs;

  const frontCameras: MediaDeviceInfo[] = [];
  const rearCameras: MediaDeviceInfo[] = [];

  for (const d of devicesToProcess) {
    if (isFrontFacingCamera(d)) {
      frontCameras.push(d);
    } else {
      rearCameras.push(d);
    }
  }

  // Deduplicate front cameras:
  // Android Camera2 HAL on multi-camera devices (e.g. Samsung Galaxy S26 Ultra) often exposes
  // duplicate or auxiliary front camera entries (e.g. standard selfie and wide selfie).
  // Keep only ONE front camera in the cycle so the front camera never appears twice.
  let singleFront: MediaDeviceInfo[] = [];
  if (frontCameras.length > 0) {
    const primaryFront =
      frontCameras.find((d) => extractCameraIndex(d.label) === 1) ||
      frontCameras[0];
    singleFront = [primaryFront];
  }

  // Sort rear cameras:
  // 1. Primary main (1x) camera first (determined by scoreCamera)
  // 2. Remaining rear cameras sorted by HAL camera index (e.g. Camera 2 ultra-wide, Camera 4 telephoto 3x, Camera 5 periscope)
  let sortedRear: MediaDeviceInfo[] = [];
  if (rearCameras.length > 0) {
    const scored = rearCameras.map((device) => ({ device, score: scoreCamera(device) }));
    scored.sort((a, b) => b.score - a.score);
    const primaryDevice = scored[0]?.device;

    const remaining = rearCameras.filter(
      (d) => d.deviceId !== primaryDevice?.deviceId
    );

    remaining.sort((a, b) => {
      const idxA = extractCameraIndex(a.label);
      const idxB = extractCameraIndex(b.label);
      if (idxA !== null && idxB !== null && idxA !== idxB) {
        return idxA - idxB;
      }
      const isUltraA = /ultra|0\.5x|0\.6x/i.test(a.label);
      const isUltraB = /ultra|0\.5x|0\.6x/i.test(b.label);
      if (isUltraA && !isUltraB) return -1;
      if (!isUltraA && isUltraB) return 1;
      return a.label.localeCompare(b.label);
    });

    sortedRear = primaryDevice ? [primaryDevice, ...remaining] : remaining;
  }

  // Desired cycle: [Main Rear (1x), Ultra-wide (0.5x), Telephoto 1, Telephoto 2, Front Camera]
  const combined = [...sortedRear, ...singleFront];
  return combined.length > 0 ? combined : videoInputs;
}

function pickPrimaryRearCamera(devices: MediaDeviceInfo[]): MediaDeviceInfo | null {
  const classified = classifyAndDeduplicateCameras(devices);
  if (classified.length > 0) {
    return classified[0];
  }
  return null;
}

async function getCameraStream(
  getUserMediaFn: (c: MediaStreamConstraints) => Promise<MediaStream>,
  deviceId: string | null,
  isMobile: boolean
): Promise<MediaStream> {
  if (deviceId) {
    // Attempt 1: exact deviceId with ideal 720p resolution
    try {
      return await getUserMediaFn({
        video: {
          deviceId: { exact: deviceId },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      });
    } catch {
      // Attempt 2: exact deviceId without resolution constraints.
      // Auxiliary lenses (telephoto, periscope, ultra-wide) on Android often reject
      // standard resolution constraints; relaxing them allows the HAL to use native lens resolution.
      try {
        return await getUserMediaFn({
          video: {
            deviceId: { exact: deviceId },
          },
        });
      } catch {
        // Attempt 3: ideal deviceId constraint
        try {
          return await getUserMediaFn({
            video: {
              deviceId: { ideal: deviceId },
            },
          });
        } catch {
          // Fall through to general constraints below
        }
      }
    }
  }

  // Fallbacks: prefer rear camera on mobile, user camera on desktop
  try {
    return await getUserMediaFn({
      video: {
        facingMode: { ideal: isMobile ? "environment" : "user" },
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
    });
  } catch {
    return await getUserMediaFn({ video: true });
  }
}

async function applyAutofocusAndZoom(track: MediaStreamTrack | undefined) {
  if (!track) return;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const trackAny = track as any;
    const capabilities = trackAny.getCapabilities?.() || {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const advanced: any = {};

    if (capabilities.focusMode && Array.isArray(capabilities.focusMode)) {
      if (capabilities.focusMode.includes("continuous")) {
        advanced.focusMode = "continuous";
      } else if (capabilities.focusMode.includes("auto")) {
        advanced.focusMode = "auto";
      }
    }

    if (capabilities.zoom && typeof capabilities.zoom.min === "number") {
      const idealZoom = Math.max(capabilities.zoom.min, 1);
      if (capabilities.zoom.max >= idealZoom) {
        advanced.zoom = idealZoom;
      }
    }

    if (Object.keys(advanced).length > 0 && typeof trackAny.applyConstraints === "function") {
      await trackAny.applyConstraints({ advanced: [advanced] });
    }
  } catch {
    // Constraints are optional enhancements
  }
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
  const [availableCameras, setAvailableCameras] = useState<MediaDeviceInfo[]>([]);
  const [selectedCameraId, setSelectedCameraId] = useState<string | null>(null);
  const [isKeyboardOpen, setIsKeyboardOpen] = useState(false);

  const dialogRef = useRef<HTMLElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const hostStartIdRef = useRef(0);
  const hasCompletedRef = useRef(false);
  const selectedCameraIdRef = useRef<string | null>(null);
  const switchingCameraRef = useRef(false);

  const handleClose = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    if (status.status === "completed" && !hasCompletedRef.current) {
      hasCompletedRef.current = true;
      onCompleted();
    }
    void pairingApi.cancel().catch(() => {});
    onClose();
  };

  useModalA11y(dialogRef, open, handleClose);

  // Monitor virtual keyboard appearance on mobile to keep action buttons visible
  useEffect(() => {
    if (!open) {
      setIsKeyboardOpen(false);
      return;
    }

    const checkKeyboard = () => {
      const isMobile =
        typeof navigator !== "undefined" &&
        (/Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
          (typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches));

      if (!isMobile) {
        setIsKeyboardOpen(false);
        return;
      }

      // 1. Check visualViewport height reduction (standard across modern mobile browsers/WebViews)
      const vv = window.visualViewport;
      if (vv && window.innerHeight > 0) {
        const heightDiff = window.innerHeight - vv.height;
        if (heightDiff > 100) {
          setIsKeyboardOpen(true);
          return;
        }
      }

      // 2. Check native Android IME class set by MainActivity
      if (document.documentElement.classList.contains("keyboard-active")) {
        setIsKeyboardOpen(true);
        return;
      }

      // 3. Check if join code input is actively focused
      const activeEl = document.activeElement;
      if (activeEl && activeEl.id === "pairing-join-code-input") {
        setIsKeyboardOpen(true);
        return;
      }

      setIsKeyboardOpen(false);
    };

    const vv = window.visualViewport;
    if (vv) {
      vv.addEventListener("resize", checkKeyboard);
      vv.addEventListener("scroll", checkKeyboard);
    }
    window.addEventListener("resize", checkKeyboard);

    const observer = new MutationObserver(() => {
      checkKeyboard();
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style"],
    });

    // Run initial check
    checkKeyboard();

    return () => {
      if (vv) {
        vv.removeEventListener("resize", checkKeyboard);
        vv.removeEventListener("scroll", checkKeyboard);
      }
      window.removeEventListener("resize", checkKeyboard);
      observer.disconnect();
    };
  }, [open]);

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
      if (!hasCompletedRef.current) {
        hasCompletedRef.current = true;
        onCompleted();
      }
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
      hasCompletedRef.current = false;
      setStatus({ status: "idle" });
      setErrorMessage(null);
      setJoinCodeInput("");
      setViewMode("host");
      setBusy(false);
      setConfirmedSas(false);
      setIsFrontCamera(false);
      setIsKeyboardOpen(false);
      setSelectedCameraId(null);
      selectedCameraIdRef.current = null;
      setAvailableCameras([]);
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
      setSelectedCameraId(null);
      selectedCameraIdRef.current = null;
      setAvailableCameras([]);
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
        let chosenDeviceId = selectedCameraIdRef.current;

        // Step 1: If devices already have labels (e.g. permission was previously granted),
        // pre-identify the primary rear camera to avoid initializing auxiliary/ultra-wide lenses.
        if (!chosenDeviceId && mediaDevices?.enumerateDevices && isMobile) {
          try {
            const initialDevices = await mediaDevices.enumerateDevices();
            const classified = classifyAndDeduplicateCameras(initialDevices);
            if (classified.length > 0 && classified[0].label && classified[0].deviceId) {
              chosenDeviceId = classified[0].deviceId;
            }
          } catch {
            // Permission might not be granted yet
          }
        }

        try {
          stream = await getCameraStream(getUserMediaFn, chosenDeviceId, isMobile);
        } catch (err) {
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

        if (!active || !stream) {
          if (stream) {
            stream.getTracks().forEach((t) => t.stop());
          }
          return;
        }

        // Step 2: Now that camera permission is active, query device list and classify
        if (mediaDevices?.enumerateDevices) {
          try {
            const allDevices = await mediaDevices.enumerateDevices();
            const classified = classifyAndDeduplicateCameras(allDevices);
            setAvailableCameras(classified);

            // On mobile, if no camera was explicitly selected yet:
            // Ensure we are using the primary rear camera (classified[0])
            if (isMobile && !selectedCameraIdRef.current && classified.length > 0) {
              const primary = classified[0];
              const currentTrack = stream.getVideoTracks()[0];
              const currentDeviceId = currentTrack?.getSettings?.()?.deviceId;

              if (primary && primary.deviceId && currentDeviceId && primary.deviceId !== currentDeviceId) {
                currentTrack.stop();
                stream = await getCameraStream(getUserMediaFn, primary.deviceId, isMobile);
                selectedCameraIdRef.current = primary.deviceId;
                setSelectedCameraId(primary.deviceId);
              } else if (primary?.deviceId) {
                selectedCameraIdRef.current = primary.deviceId;
                setSelectedCameraId(primary.deviceId);
              }
            }
          } catch (enumErr) {
            console.warn("Camera enumeration error:", enumErr);
          }
        }

        const videoTrack = stream.getVideoTracks()[0];
        const settings = videoTrack?.getSettings?.();
        const facing = settings?.facingMode;
        setIsFrontCamera(facing === "user" || (!facing && !isMobile));

        // Step 3: Apply continuous autofocus and standard 1x zoom
        await applyAutofocusAndZoom(videoTrack);

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

  const handleScannerTap = async () => {
    const track = streamRef.current?.getVideoTracks()[0];
    if (track) {
      await applyAutofocusAndZoom(track);
    }
  };

  const handleSwitchCamera = async () => {
    if (switchingCameraRef.current) return;
    switchingCameraRef.current = true;

    try {
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

      if (!getUserMediaFn) return;

      const isMobile =
        typeof navigator !== "undefined" &&
        /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

      let newStream: MediaStream | null = null;
      let nextIsFront = !isFrontCamera;

      if (availableCameras.length > 1) {
        const currentIndex = availableCameras.findIndex(
          (c) => c.deviceId && c.deviceId === selectedCameraIdRef.current
        );
        const nextIndex = (currentIndex + 1) % availableCameras.length;
        const nextDevice = availableCameras[nextIndex];

        if (nextDevice?.deviceId) {
          if (streamRef.current) {
            streamRef.current.getTracks().forEach((track) => track.stop());
            streamRef.current = null;
          }

          newStream = await getCameraStream(getUserMediaFn, nextDevice.deviceId, isMobile);
          selectedCameraIdRef.current = nextDevice.deviceId;
          setSelectedCameraId(nextDevice.deviceId);

          const videoTrack = newStream.getVideoTracks()[0];
          const settings = videoTrack?.getSettings?.();
          const facing = settings?.facingMode;
          nextIsFront = isFrontFacingCamera(nextDevice) || facing === "user" || (!facing && !isMobile);
        }
      }

      // Fallback toggle for single-camera devices / dev mode
      if (!newStream) {
        if (streamRef.current) {
          streamRef.current.getTracks().forEach((track) => track.stop());
          streamRef.current = null;
        }
        const targetFacing = isFrontCamera ? "environment" : "user";
        try {
          newStream = await getUserMediaFn({
            video: {
              facingMode: { ideal: targetFacing },
              width: { ideal: 1280 },
              height: { ideal: 720 },
            },
          });
        } catch {
          newStream = await getUserMediaFn({ video: true });
        }
        nextIsFront = !isFrontCamera;
      }

      streamRef.current = newStream;
      setIsFrontCamera(nextIsFront);

      const videoTrack = newStream.getVideoTracks()[0];
      if (videoRef.current) {
        videoRef.current.srcObject = newStream;
        try {
          await videoRef.current.play();
        } catch {
          // Playback starts on loadedmetadata
        }
      }

      await applyAutofocusAndZoom(videoTrack);
    } catch (err) {
      console.warn("Failed to switch camera:", err);
    } finally {
      switchingCameraRef.current = false;
    }
  };

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
    (isWaitingState && viewMode !== "host");

  const isMobileDevice =
    typeof navigator !== "undefined" &&
    (/Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
      (typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches));

  const showSwitchCamera =
    availableCameras.length > 1 || isMobileDevice || Boolean(import.meta.env?.DEV);

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
        <button
          type="button"
          className="ui-modal-close"
          data-react-close="true"
          onClick={handleClose}
          disabled={status.status === "transferring"}
          aria-label="Close dialog"
          data-tooltip="Close"
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

              <div className="pairing-scanner-stage">
                <div
                  className="pairing-scanner-box"
                  onClick={handleScannerTap}
                  aria-label="Tap to focus camera"
                >
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

                {showSwitchCamera && (
                  <button
                    type="button"
                    className="pairing-switch-camera-fab"
                    onClick={() => void handleSwitchCamera()}
                    data-tooltip="Switch camera"
                    aria-label="Switch camera"
                  >
                    <FlipCameraIcon />
                  </button>
                )}
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
                onFocus={() => {
                  const isMobile =
                    typeof navigator !== "undefined" &&
                    (/Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
                      (typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches));
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

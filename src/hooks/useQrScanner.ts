import { useEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { pairingApi } from "../api";
import jsQR from "jsqr";

export type ScannerViewMode = "scanner" | (string & {});

// ---------------------------------------------------------------------------
// Sandboxed QR decoding.
//
// `jsqr` is unmaintained, so untrusted camera pixels reach it only through
// this strict boundary: frame dimensions and pixel counts are capped (large
// frames are downscaled first), the call is exception-isolated so a crafted
// frame cannot break the scan loop, and decoded text is length-capped and
// scheme-allowlisted before anything else touches it. The platform-native
// `BarcodeDetector` remains the primary decoder where available; jsQR is only
// the cross-platform fallback.
// ---------------------------------------------------------------------------
const QR_MAX_DIMENSION = 960;
const QR_MAX_PIXELS = QR_MAX_DIMENSION * QR_MAX_DIMENSION;
const QR_MAX_PAYLOAD_CHARS = 2048;
const QR_ALLOWED_PREFIXES = ["aiusage-pair:", "aiusage:", "aiut-airgap:", "aiut-airgap://"];

function sanitizeDecodedQrText(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (text.length === 0 || text.length > QR_MAX_PAYLOAD_CHARS) return null;
  // Reject control characters (except whitespace already trimmed at the ends).
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F]/.test(text)) return null;
  if (!QR_ALLOWED_PREFIXES.some((prefix) => text.startsWith(prefix))) return null;
  return text;
}

function decodeQrSandboxed(imageData: ImageData): string | null {
  // Dimension guard: jsQR is O(pixels), so refuse absurd frames outright.
  if (
    imageData.width <= 0 ||
    imageData.height <= 0 ||
    imageData.width > 4096 ||
    imageData.height > 4096 ||
    imageData.width * imageData.height > 16 * QR_MAX_PIXELS
  ) {
    return null;
  }
  let data = imageData.data;
  let width = imageData.width;
  let height = imageData.height;
  // Downscale large frames before handing pixels to the fallback decoder.
  if (width * height > QR_MAX_PIXELS) {
    const scale = Math.sqrt((width * height) / QR_MAX_PIXELS);
    const targetWidth = Math.max(1, Math.floor(width / scale));
    const targetHeight = Math.max(1, Math.floor(height / scale));
    const source = document.createElement("canvas");
    source.width = width;
    source.height = height;
    const sourceCtx = source.getContext("2d");
    if (!sourceCtx) return null;
    sourceCtx.putImageData(imageData, 0, 0);
    const target = document.createElement("canvas");
    target.width = targetWidth;
    target.height = targetHeight;
    const targetCtx = target.getContext("2d", { willReadFrequently: true });
    if (!targetCtx) return null;
    targetCtx.drawImage(source, 0, 0, targetWidth, targetHeight);
    const scaled = targetCtx.getImageData(0, 0, targetWidth, targetHeight);
    data = scaled.data;
    width = scaled.width;
    height = scaled.height;
  }
  let result: { data: string } | null = null;
  try {
    result = jsQR(data, width, height, { inversionAttempts: "attemptBoth" });
  } catch {
    return null;
  }
  return sanitizeDecodedQrText(result?.data);
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

function isVirtualOrPhoneCamera(device: MediaDeviceInfo): boolean {
  const label = (device.label || "").toLowerCase();
  return (
    label.includes("continuity") ||
    label.includes("desk view") ||
    label.includes("iphone") ||
    label.includes("ipad") ||
    label.includes("virtual") ||
    label.includes("obs virtual") ||
    /\bir\b/.test(label) ||
    label.includes("infrared")
  );
}

function listDesktopCameras(devices: MediaDeviceInfo[]): MediaDeviceInfo[] {
  const videoInputs = devices.filter((d) => d.kind === "videoinput" && d.deviceId);
  const physical = videoInputs.filter((d) => !isVirtualOrPhoneCamera(d));
  const pool = physical.length > 0 ? physical : videoInputs;
  const rank = (d: MediaDeviceInfo) => {
    const label = (d.label || "").toLowerCase();
    if (label.includes("usb") || label.includes("webcam")) return 3;
    if (label.includes("facetime") || label.includes("built-in")) return 2;
    if (d.label) return 1;
    return 0;
  };
  return [...pool].sort((a, b) => rank(b) - rank(a));
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

  // Desktop / USB webcams: never ask for facingMode "user". WebKit treats that as a
  // laptop FaceTime camera and fails on Mac mini / external webcams even when `ideal`.
  if (!isMobile) {
    try {
      return await getUserMediaFn({ video: true });
    } catch {
      return await getUserMediaFn({
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      });
    }
  }

  try {
    return await getUserMediaFn({
      video: {
        facingMode: { ideal: "environment" },
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

export interface UseQrScannerOptions<T extends string = string> {
  active: boolean;
  restartKey: number;
  isFrontCamera: boolean;
  availableCameras: MediaDeviceInfo[];
  hostStartIdRef: MutableRefObject<number>;
  airgapSessionIdRef: MutableRefObject<string | null>;
  airgapVerifyPromptRef: MutableRefObject<boolean>;
  airgapCaptureStartRef: MutableRefObject<number | null>;
  setViewMode: Dispatch<SetStateAction<T>>;
  setBusy: Dispatch<SetStateAction<boolean>>;
  setErrorMessage: Dispatch<SetStateAction<string | null>>;
  setCameraError: Dispatch<SetStateAction<string | null>>;
  setVideoReady: Dispatch<SetStateAction<boolean>>;
  setAvailableCameras: Dispatch<SetStateAction<MediaDeviceInfo[]>>;
  setSelectedCameraId: Dispatch<SetStateAction<string | null>>;
  setIsFrontCamera: Dispatch<SetStateAction<boolean>>;
  setAirgapCapturedChunks: Dispatch<SetStateAction<Map<number, string>>>;
  setAirgapTotalChunks: Dispatch<SetStateAction<number>>;
  setAirgapCaptureSecs: Dispatch<SetStateAction<number | null>>;
  setAirgapPinPrompt: Dispatch<SetStateAction<boolean>>;
}

/**
 * In-app camera QR scanner: opens the best available camera, keeps the stream
 * and current device in `streamRef` / `selectedCameraIdRef`, and runs a
 * throttled scan loop (native BarcodeDetector first, sandboxed jsQR fallback)
 * until the scanner deactivates or unmounts — stopping every track on cleanup.
 */
export function useQrScanner<T extends string = string>(options: UseQrScannerOptions<T>) {
  const {
    active,
    restartKey,
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
  } = options;

  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const selectedCameraIdRef = useRef<string | null>(null);
  const switchingCameraRef = useRef(false);

  // In-app camera scanning loop
  useEffect(() => {
    if (!active) {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
      }
      setSelectedCameraId(null);
      selectedCameraIdRef.current = null;
      setAvailableCameras([]);
      return;
    }

    let activeScan = true;
    let animFrameId: number;

    const startCamera = async () => {
      setVideoReady(false);
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

        let nativePermissionError: string | null = null;
        try {
          await pairingApi.ensureCameraPermission();
        } catch (permErr) {
          // Native TCC preflight is best-effort. WKWebView getUserMedia is what
          // actually opens USB webcams (Mac mini) especially in `tauri dev`.
          nativePermissionError = String(permErr).replace(/^Error:\s*/, "");
        }

        const isMobile =
          typeof navigator !== "undefined" &&
          /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

        let stream: MediaStream | null = null;
        let chosenDeviceId = selectedCameraIdRef.current;

        // Step 1: If devices already have labels (e.g. permission was previously granted),
        // pre-identify the camera so we skip auxiliary mobile lenses / Continuity Camera.
        if (!chosenDeviceId && mediaDevices?.enumerateDevices) {
          try {
            const initialDevices = await mediaDevices.enumerateDevices();
            if (isMobile) {
              const classified = classifyAndDeduplicateCameras(initialDevices);
              if (classified.length > 0 && classified[0].label && classified[0].deviceId) {
                chosenDeviceId = classified[0].deviceId;
              }
            } else {
              const desktopCam = listDesktopCameras(initialDevices)[0];
              if (desktopCam?.deviceId && desktopCam.label) {
                chosenDeviceId = desktopCam.deviceId;
              }
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
              nativePermissionError ||
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

        if (!activeScan || !stream) {
          if (stream) {
            stream.getTracks().forEach((t) => t.stop());
          }
          return;
        }

        // Step 2: Now that camera permission is active, query device list and classify
        if (mediaDevices?.enumerateDevices) {
          try {
            const allDevices = await mediaDevices.enumerateDevices();
            const preferredList = isMobile
              ? classifyAndDeduplicateCameras(allDevices)
              : listDesktopCameras(allDevices);
            setAvailableCameras(preferredList);

            // If no camera was explicitly selected yet, prefer the primary rear
            // (mobile) or a physical USB/built-in webcam (desktop) over Continuity Camera.
            if (!selectedCameraIdRef.current && preferredList.length > 0) {
              const primary = preferredList[0];
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
        let lastScanAt = 0;
        const SCAN_THROTTLE_MS = 150;
        const scan = async () => {
          if (!activeScan || !videoRef.current) return;
          if (scanning) {
            animFrameId = requestAnimationFrame(scan);
            return;
          }
          // Throttle decode attempts so a malicious/high-fps stream cannot
          // pin the renderer CPU via the fallback decoder.
          const now = performance.now();
          if (now - lastScanAt < SCAN_THROTTLE_MS) {
            animFrameId = requestAnimationFrame(scan);
            return;
          }
          lastScanAt = now;
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
                    detectedCode = sanitizeDecodedQrText(codes[0].rawValue);
                  }
                } catch {
                  // Fall back to jsQR
                }
              }

              // 2. Cross-platform fallback: decode via the sandboxed jsQR
              // boundary (dimension caps, exception isolation, allowlisted
              // output). Resilient to screen reflections via attemptBoth.
              if (!detectedCode && ctx) {
                if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
                  canvas.width = video.videoWidth;
                  canvas.height = video.videoHeight;
                }
                ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
                const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
                detectedCode = decodeQrSandboxed(imageData);
              }

              if (
                detectedCode &&
                (detectedCode.startsWith("aiusage-pair:") || detectedCode.startsWith("aiusage:"))
              ) {
                if (streamRef.current) {
                  streamRef.current.getTracks().forEach((t) => t.stop());
                  streamRef.current = null;
                }
                setViewMode("host" as T);
                hostStartIdRef.current += 1;
                setBusy(true);
                setErrorMessage(null);
                await pairingApi.startClient(detectedCode);
                return;
              }

              if (
                detectedCode &&
                (detectedCode.startsWith("aiut-airgap:") || detectedCode.startsWith("aiut-airgap://"))
              ) {
                const match = detectedCode.match(
                  /aiut-airgap:\/\/(?:1\/)?([^/]+)\/(\d+)\/(\d+)\/([0-9a-fA-F]+)\?d=(.+)/
                );
                if (match) {
                  const [, sessionId, chunkStr, totalStr] = match;
                  const chunkIndex = parseInt(chunkStr, 10);
                  const totalChunks = parseInt(totalStr, 10);
                  if (chunkIndex > 0 && totalChunks > 0) {
                    setAirgapCapturedChunks((prev) => {
                      if (airgapSessionIdRef.current !== sessionId) {
                        airgapSessionIdRef.current = sessionId;
                        airgapCaptureStartRef.current = Date.now();
                        setAirgapCaptureSecs(null);
                        const next = new Map<number, string>();
                        next.set(chunkIndex, detectedCode);
                        setAirgapTotalChunks(totalChunks);
                        return next;
                      }
                      if (prev.has(chunkIndex)) return prev;
                      const next = new Map(prev);
                      next.set(chunkIndex, detectedCode);
                      setAirgapTotalChunks(totalChunks);
                      if (next.size === totalChunks) {
                        const start = airgapCaptureStartRef.current;
                        if (start !== null) {
                          setAirgapCaptureSecs(Math.max(1, Math.round((Date.now() - start) / 1000)));
                        }
                        airgapVerifyPromptRef.current = true;
                        setAirgapPinPrompt(true);
                        if (streamRef.current) {
                          streamRef.current.getTracks().forEach((t) => t.stop());
                          streamRef.current = null;
                        }
                      }
                      return next;
                    });
                  }
                }
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
      activeScan = false;
      if (animFrameId) cancelAnimationFrame(animFrameId);
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }
    };
  }, [active, restartKey]);

  const handleScannerTap = async () => {
    const track = streamRef.current?.getVideoTracks()[0];
    if (track) {
      await applyAutofocusAndZoom(track);
    }
  };

  const handleSwitchCamera = async () => {
    if (switchingCameraRef.current) return;
    switchingCameraRef.current = true;
    setVideoReady(false);

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
        if (isMobile) {
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
        } else {
          newStream = await getCameraStream(getUserMediaFn, null, false);
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

  return { videoRef, streamRef, handleScannerTap, handleSwitchCamera };
}

// Re-exported for the pickPrimaryRearCamera callers outside this hook.
export {
  classifyAndDeduplicateCameras,
  pickPrimaryRearCamera,
  isFrontFacingCamera,
  listDesktopCameras,
  getCameraStream,
  applyAutofocusAndZoom,
};

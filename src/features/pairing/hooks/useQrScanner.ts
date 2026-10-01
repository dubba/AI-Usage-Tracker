import { useEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { pairingApi } from "../../../shared/lib/api";
import { isMobileUserAgent } from "../../../shared/lib/platform";
import { applyAutofocusAndZoom, getCameraStream } from "../lib/camera-stream";
import {
  classifyAndDeduplicateCameras,
  isFrontFacingCamera,
  listDesktopCameras,
} from "../lib/camera-selection";
import { decodeQrSandboxed, sanitizeDecodedQrText } from "../lib/qr-decoder";

export type ScannerViewMode = "scanner" | (string & {});

export interface UseQrScannerOptions<T extends string = string> {
  active: boolean;
  restartKey: number;
  isFrontCamera: boolean;
  availableCameras: MediaDeviceInfo[];
  hostStartIdRef: MutableRefObject<number>;
  airgapSessionIdRef: MutableRefObject<string | null>;
  airgapVerifyPromptRef: MutableRefObject<boolean>;
  airgapCaptureStartRef: MutableRefObject<number | null>;
  setViewMode: (view: T) => void;
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
          isMobileUserAgent();

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
        isMobileUserAgent();

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

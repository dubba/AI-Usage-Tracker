import { useCallback, useEffect, useEffectEvent, useRef, useState } from "react";
import { pairingApi } from "../../../shared/lib/api";
import { describeError } from "../../../shared/lib/errors";
import { useAutoDismissedError } from "../../../shared/hooks/useAutoDismissedError";
import { isMobileUserAgent } from "../../../shared/lib/platform";
import { applyAutofocusAndZoom, getCameraStream } from "../lib/camera-stream";
import {
  classifyAndDeduplicateCameras,
  isFrontFacingCamera,
  listDesktopCameras,
} from "../lib/camera-selection";
import { createNativeQrDetector, resolveGetUserMedia } from "../lib/legacy-media";
import { decodeQrSandboxed, sanitizeDecodedQrText } from "../lib/qr-decoder";

/** What the scan loop hands `onDecoded` to act on. */
export interface QrScannerControls {
  /** Stops the camera. The scan loop keeps running but finds nothing more to read. */
  stopCamera: () => void;
}

export interface UseQrScannerOptions {
  /** The scanner is on screen: the camera runs while this is true. */
  active: boolean;
  /** Bump to restart the camera (Retry Camera, scanning again). */
  restartKey: number;
  /**
   * A QR code was read (sanitized text, allowlisted by the decoder). Return true when it ends
   * scanning: the camera is stopped and the loop ends. The latest callback is always the one
   * called; a new one does not restart the camera.
   */
  onDecoded: (code: string, controls: QrScannerControls) => boolean | void | Promise<boolean | void>;
  /** `onDecoded` threw or rejected. The frame is dropped and scanning goes on. */
  onError?: (cause: unknown) => void;
}

const SCAN_THROTTLE_MS = 150;

function stopTracks(stream: MediaStream | null) {
  stream?.getTracks().forEach((track) => track.stop());
}

/**
 * In-app camera QR scanner: opens the best available camera and runs a throttled scan loop
 * (native BarcodeDetector first, sandboxed jsQR fallback) until the scanner deactivates or
 * unmounts, stopping every track on cleanup. It owns the camera state the scanner view shows
 * (`videoReady`, `availableCameras`, `isFrontCamera`, `cameraError`); what a decoded code means is
 * the caller's (`onDecoded`).
 */
export function useQrScanner({ active, restartKey, onDecoded, onError }: UseQrScannerOptions) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const selectedCameraIdRef = useRef<string | null>(null);
  const switchingCameraRef = useRef(false);
  const [videoReady, setVideoReady] = useState(false);
  const [availableCameras, setAvailableCameras] = useState<MediaDeviceInfo[]>([]);
  const [isFrontCamera, setIsFrontCamera] = useState(false);
  // The message goes away by itself (and when the scanner closes). `cameraFailed` outlives it:
  // the view keeps offering "Retry Camera" and hides the scan beam until the camera is started
  // again.
  const { error: cameraError, setError: setCameraErrorMessage, clearError: clearCameraError } = useAutoDismissedError(active);
  const [cameraFailed, setCameraFailed] = useState(false);
  const setCameraError = useCallback(
    (message: string | null) => {
      setCameraErrorMessage(message);
      if (message !== null) setCameraFailed(true);
    },
    [setCameraErrorMessage],
  );

  const handleDecoded = useEffectEvent(onDecoded);
  const handleError = useEffectEvent((cause: unknown) => onError?.(cause));

  const stopCamera = () => {
    stopTracks(streamRef.current);
    streamRef.current = null;
  };

  // In-app camera scanning loop. It restarts only for `active` / `restartKey`.
  useEffect(() => {
    if (!active) {
      stopCamera();
      selectedCameraIdRef.current = null;
      setAvailableCameras([]);
      setIsFrontCamera(false);
      setVideoReady(false);
      setCameraFailed(false);
      return;
    }

    let activeScan = true;
    let animFrameId: number;

    const startCamera = async () => {
      setVideoReady(false);
      setCameraFailed(false);
      try {
        setCameraError(null);

        const mediaDevices = navigator.mediaDevices;
        const getUserMediaFn = resolveGetUserMedia();

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

        const isMobile = isMobileUserAgent();

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
            setCameraError(describeError("pairing", "Camera error", err));
          }
          return;
        }

        if (!activeScan || !stream) {
          stopTracks(stream);
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
              } else if (primary?.deviceId) {
                selectedCameraIdRef.current = primary.deviceId;
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
        const nativeDetector = createNativeQrDetector();

        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d", { willReadFrequently: true });

        let scanning = false;
        let lastScanAt = 0;
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
                  const raw = codes[0]?.rawValue;
                  if (raw) detectedCode = sanitizeDecodedQrText(raw);
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

              if (detectedCode) {
                try {
                  if (await handleDecoded(detectedCode, { stopCamera })) {
                    stopCamera();
                    return;
                  }
                } catch (cause) {
                  handleError(cause);
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
        setCameraError(describeError("pairing", "Camera error", err));
      }
    };

    void startCamera();

    return () => {
      activeScan = false;
      if (animFrameId) cancelAnimationFrame(animFrameId);
      stopCamera();
    };
    // `stopCamera` only touches a ref, and the callbacks are effect events.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, restartKey, setCameraError]);

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
      const getUserMediaFn = resolveGetUserMedia();
      if (!getUserMediaFn) return;

      const isMobile = isMobileUserAgent();

      let newStream: MediaStream | null = null;
      let nextIsFront = !isFrontCamera;

      if (availableCameras.length > 1) {
        const currentIndex = availableCameras.findIndex(
          (c) => c.deviceId && c.deviceId === selectedCameraIdRef.current
        );
        const nextIndex = (currentIndex + 1) % availableCameras.length;
        const nextDevice = availableCameras[nextIndex];

        if (nextDevice?.deviceId) {
          stopCamera();

          newStream = await getCameraStream(getUserMediaFn, nextDevice.deviceId, isMobile);
          selectedCameraIdRef.current = nextDevice.deviceId;

          const videoTrack = newStream.getVideoTracks()[0];
          const settings = videoTrack?.getSettings?.();
          const facing = settings?.facingMode;
          nextIsFront = isFrontFacingCamera(nextDevice) || facing === "user" || (!facing && !isMobile);
        }
      }

      // Fallback toggle for single-camera devices / dev mode
      if (!newStream) {
        stopCamera();
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

  return {
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
  };
}

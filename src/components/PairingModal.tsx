import { useEffect, useRef, useState, type ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import { pairingApi } from "../api";
import {
  CameraIcon,
  CheckCircleIcon,
  ChevronIcon,
  DownloadIcon,
  FlipCameraIcon,
  KeypadIcon,
  PauseIcon,
  PlayIcon,
  QrIcon,
  RefreshIcon,
  ShieldIcon,
  UploadIcon,
} from "../icons";
import type { AirgapExport, PairingStatus } from "../types";
import { applyPageUiState, collectPageUiState } from "../dashboard-page-state";
import { useModalA11y } from "./useModalA11y";
import jsQR from "jsqr";

type ViewMode = "select-role" | "select-mode" | "host" | "scanner" | "code" | "airgap-sender" | "airgap-confirm";
type IntendedRole = "send" | "receive";

const ALLOWED_SVG_TAGS = new Set(["svg", "path", "rect", "g", "defs", "clippath"]);
const ALLOWED_SVG_ATTRS = new Set([
  "viewbox",
  "width",
  "height",
  "fill",
  "stroke",
  "stroke-width",
  "d",
  "shape-rendering",
  "xmlns",
  "version",
  "x",
  "y",
  "id",
  "class",
]);

export function sanitizeQrSvg(rawSvg: string): string {
  if (!rawSvg || typeof rawSvg !== "string") return "";

  const trimmed = rawSvg.replace(/^<\?xml[^>]*\?>/i, "").trim();
  if (!trimmed) return "";

  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(trimmed, "image/svg+xml");

    if (doc.getElementsByTagName("parsererror").length > 0) {
      return "";
    }

    const root = doc.documentElement;
    if (!root || root.nodeName.toLowerCase() !== "svg") {
      return "";
    }

    const elements = Array.from(doc.getElementsByTagName("*"));
    for (const el of elements) {
      const tag = el.nodeName.toLowerCase();
      if (!ALLOWED_SVG_TAGS.has(tag)) {
        el.remove();
        continue;
      }

      const attrs = Array.from(el.attributes);
      for (const attr of attrs) {
        const attrName = attr.name.toLowerCase();
        const attrValue = attr.value.trim().toLowerCase();

        if (
          attrName.startsWith("on") ||
          attrName.includes("href") ||
          attrValue.includes("javascript:") ||
          attrValue.includes("data:") ||
          !ALLOWED_SVG_ATTRS.has(attrName)
        ) {
          el.removeAttribute(attr.name);
        }
      }
    }

    return new XMLSerializer().serializeToString(root);
  } catch {
    return "";
  }
}

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

function collectUiStateForSync(): Record<string, unknown> {
  const ui: Record<string, unknown> = {};
  try {
    const groupRaw = window.localStorage.getItem("ai-subscription-tracker:sidebar-group-order");
    if (groupRaw) {
      const parsed = JSON.parse(groupRaw);
      if (Array.isArray(parsed) && parsed.length) ui.sidebar_group_order = parsed;
    }
  } catch {}
  try {
    const provRaw = window.localStorage.getItem("ai-subscription-tracker:provider-order");
    if (provRaw) {
      const parsed = JSON.parse(provRaw);
      if (Array.isArray(parsed) && parsed.length) ui.provider_order = parsed;
    }
  } catch {}
  Object.assign(ui, collectPageUiState());
  try {
    const w = window.localStorage.getItem("paseo-usage-bridge:sidebar-width");
    if (w) {
      const n = parseInt(w, 10);
      if (!Number.isNaN(n) && n > 0) ui.sidebar_width = n;
    }
  } catch {}
  return ui;
}

function applyUiStateFromSync(payload: Record<string, unknown>) {
  try {
    if (Array.isArray(payload.sidebar_group_order)) {
      window.localStorage.setItem(
        "ai-subscription-tracker:sidebar-group-order",
        JSON.stringify(payload.sidebar_group_order),
      );
      window.dispatchEvent(
        new CustomEvent("ai-subscription-tracker:group-order-changed", {
          detail: payload.sidebar_group_order,
        }),
      );
    }
    if (Array.isArray(payload.provider_order)) {
      window.localStorage.setItem(
        "ai-subscription-tracker:provider-order",
        JSON.stringify(payload.provider_order),
      );
      window.dispatchEvent(
        new CustomEvent("ai-subscription-tracker:provider-order-changed", {
          detail: payload.provider_order,
        }),
      );
    }
    applyPageUiState(payload);
    if (typeof payload.sidebar_width === "number" && payload.sidebar_width > 0) {
      window.localStorage.setItem("paseo-usage-bridge:sidebar-width", String(payload.sidebar_width));
      document.documentElement.style.setProperty("--sidebar-width", `${payload.sidebar_width}px`);
    }
  } catch {}
  // Force a snapshot refresh so reordering and settings take effect
  window.dispatchEvent(new Event("focus"));
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
  const [selectedCameraId, setSelectedCameraId] = useState<string | null>(null);
  const [isKeyboardOpen, setIsKeyboardOpen] = useState(false);

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
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const hostStartIdRef = useRef(0);
  const hasCompletedRef = useRef(false);
  const selectedCameraIdRef = useRef<string | null>(null);
  const switchingCameraRef = useRef(false);
  const airgapSessionIdRef = useRef<string | null>(null);
  const airgapVerifyPromptRef = useRef(false);
  const airgapCaptureStartRef = useRef<number | null>(null);
  const airgapVerifyStartedRef = useRef(false);
  const roleAutoSelectedRef = useRef(false);

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
        document.documentElement.style.removeProperty("--visual-keyboard-height");
        return;
      }

      // 1. Check visualViewport height reduction (standard across modern mobile browsers/WebViews)
      const vv = window.visualViewport;
      if (vv && window.innerHeight > 0) {
        const heightDiff = window.innerHeight - vv.height;
        if (heightDiff > 100) {
          document.documentElement.style.setProperty("--visual-keyboard-height", `${heightDiff}px`);
          setIsKeyboardOpen(true);
          return;
        } else {
          document.documentElement.style.removeProperty("--visual-keyboard-height");
        }
      }

      // 2. Check native Android IME class set by MainActivity
      if (document.documentElement.classList.contains("keyboard-active")) {
        setIsKeyboardOpen(true);
        return;
      }

      setIsKeyboardOpen(false);
      document.documentElement.style.removeProperty("--visual-keyboard-height");
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
      document.documentElement.style.removeProperty("--visual-keyboard-height");
    };
  }, [open]);

  // Listen for Tauri backend pairing events and poll fallback
  useEffect(() => {
    if (!open) return;

    let unlisten: (() => void) | undefined;
    let unlistenUi: (() => void) | undefined;
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
      } catch {
        // Event listener unavailable, polling will handle it
      }
      try {
        const unsubscribeUi = await listen<Record<string, unknown>>("pairing-ui-state", (event) => {
          applyUiStateFromSync(event.payload);
        });
        unlistenUi = unsubscribeUi;
      } catch {
        // UI state sync not available on this platform
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
      }).catch(() => {});
    }, 800);

    return () => {
      if (unlisten) unlisten();
      if (unlistenUi) unlistenUi();
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
      setIsKeyboardOpen(false);
      setSelectedCameraId(null);
      selectedCameraIdRef.current = null;
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
          if (!active || !videoRef.current) return;
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
                setViewMode("host");
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
      active = false;
      if (animFrameId) cancelAnimationFrame(animFrameId);
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }
    };
  }, [viewMode, open, scannerRestartKey]);

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
      const ui = shouldInclude ? collectUiStateForSync() : undefined;
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
        } catch {}
        if (shouldInclude) {
          try {
            const ui = collectUiStateForSync();
            await pairingApi.setPendingUiState(ui);
          } catch {}
        } else {
          try {
            await pairingApi.clearPendingUiState();
          } catch {}
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

  const isMobileDevice =
    typeof navigator !== "undefined" &&
    (/Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
      (typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches));

  const showSwitchCamera =
    availableCameras.length > 1 || isMobileDevice || Boolean(import.meta.env?.DEV);

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
                      .catch(() => {})
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
            <div className="pairing-scanner-view">
              {airgapVerifyPrompt ? (
                <div className="airgap-pin-prompt-card">
                  <div className="pairing-sas-icon"><ShieldIcon /></div>
                  <h3>Do both devices show this code?</h3>
                  <p className="pairing-instruction">
                    Captured all {airgapTotalChunks} frames{airgapCaptureSecs !== null ? ` in ${airgapCaptureSecs} seconds` : ""}! Compare this code with the sending device. If they match, the transfer is intact.
                  </p>

                  {airgapVerifying || !airgapVerifyCode ? (
                    <div className="pairing-panel-status">
                      <span className="spinner" />
                      <p>Assembling scanned frames…</p>
                    </div>
                  ) : (
                    <div
                      className="pairing-sas-badge"
                      aria-label={`Verification code ${airgapVerifyCode}`}
                    >
                      {airgapVerifyCode}
                    </div>
                  )}

                  <div className="airgap-prompt-actions">
                    <button
                      type="button"
                      className="button pairing-back-btn"
                      disabled={airgapImporting || airgapVerifying}
                      onClick={() => {
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
                    >
                      <ChevronIcon style={{ transform: "rotate(180deg)" }} />
                      <span>Back</span>
                    </button>
                    <button
                      type="button"
                      className="button primary"
                      disabled={!airgapVerifyCode || airgapImporting || airgapVerifying}
                      onClick={() => void handleAirgapImport()}
                    >
                      {airgapImporting ? (
                        <>
                          <span className="spinner button-spinner" />
                          <span>Decrypting &amp; Importing…</span>
                        </>
                      ) : (
                        <span>Yes, they match</span>
                      )}
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="pairing-scanner-stage">
                    <span className="pairing-scanner-gutter" aria-hidden="true" />
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
                        onPlaying={() => setVideoReady(true)}
                        onLoadedData={() => setVideoReady(true)}
                        className={`pairing-scanner-video ${isFrontCamera ? "mirrored" : ""} ${videoReady ? "ready" : ""}`}
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

                    <div className="pairing-scanner-side">
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
                  </div>

                  {airgapCapturedChunks.size > 0 && (
                    <div className="airgap-capture-status">
                      <div className="airgap-capture-header">
                        <span className="spinner button-spinner" />
                        <span>Transferring…</span>
                        <strong>
                          {airgapCapturedChunks.size} / {airgapTotalChunks} frames (
                          {Math.round((airgapCapturedChunks.size / Math.max(1, airgapTotalChunks)) * 100)}%)
                        </strong>
                      </div>
                      <div className="airgap-progress-bar">
                        <div
                          className="airgap-progress-fill"
                          style={{
                            width: `${(airgapCapturedChunks.size / Math.max(1, airgapTotalChunks)) * 100}%`,
                          }}
                        />
                      </div>
                      <p className="airgap-capture-hint">Hold steady while camera reads all animated frames.</p>
                    </div>
                  )}

                  <div className="pairing-scanner-controls pairing-scan-actions">
                    <button
                      type="button"
                      className="button pairing-back-btn"
                      onClick={() => {
                        if (activeFlow === "airgap") {
                          setViewMode("airgap-sender");
                          return;
                        }
                        void pairingApi.cancel().catch(() => {});
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
                    >
                      <ChevronIcon style={{ transform: "rotate(180deg)" }} />
                      <span>Back</span>
                    </button>
                  </div>

                  {cameraError && (
                    <div className="error-panel modal-error">{cameraError}</div>
                  )}
                </>
              )}
            </div>
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
                      void pairingApi.cancel().catch(() => {});
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
                  void pairingApi.cancel().catch(() => {});
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
                  void pairingApi.cancel().catch(() => {});
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

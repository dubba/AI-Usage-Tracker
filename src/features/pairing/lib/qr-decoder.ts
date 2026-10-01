import jsQR from "jsqr";

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

export function sanitizeDecodedQrText(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (text.length === 0 || text.length > QR_MAX_PAYLOAD_CHARS) return null;
  // Reject control characters (except whitespace already trimmed at the ends).
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F]/.test(text)) return null;
  if (!QR_ALLOWED_PREFIXES.some((prefix) => text.startsWith(prefix))) return null;
  return text;
}

export function decodeQrSandboxed(imageData: ImageData): string | null {
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

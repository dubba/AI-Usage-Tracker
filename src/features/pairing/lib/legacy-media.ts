/** Camera and QR-detection APIs that older WebViews expose under other names, with real types. */

export type GetUserMedia = (constraints: MediaStreamConstraints) => Promise<MediaStream>;

type LegacyGetUserMedia = (
  constraints: MediaStreamConstraints,
  onSuccess: (stream: MediaStream) => void,
  onError: (error: unknown) => void,
) => void;

type LegacyNavigator = Navigator & {
  webkitGetUserMedia?: LegacyGetUserMedia;
  mozGetUserMedia?: LegacyGetUserMedia;
};

/**
 * `getUserMedia` as a promise function: the standard one, or the callback-style `webkit`/`moz`
 * prefixed one older WebViews have. Null when the device has no camera API at all.
 */
export function resolveGetUserMedia(): GetUserMedia | null {
  const mediaDevices = navigator.mediaDevices;
  if (mediaDevices?.getUserMedia) {
    return (constraints) => mediaDevices.getUserMedia(constraints);
  }
  const legacy = navigator as LegacyNavigator;
  const prefixed = legacy.webkitGetUserMedia ?? legacy.mozGetUserMedia;
  if (!prefixed) return null;
  return (constraints) =>
    new Promise<MediaStream>((resolve, reject) => prefixed.call(navigator, constraints, resolve, reject));
}

export interface QrDetector {
  detect(source: HTMLVideoElement): Promise<{ rawValue?: string }[]>;
}

type BarcodeDetectorConstructor = new (options: { formats: string[] }) => QrDetector;

/** The browser's native QR detector (Android, Chrome), or null where there is none. */
export function createNativeQrDetector(): QrDetector | null {
  const Detector = (window as unknown as { BarcodeDetector?: BarcodeDetectorConstructor }).BarcodeDetector;
  return Detector ? new Detector({ formats: ["qr_code"] }) : null;
}

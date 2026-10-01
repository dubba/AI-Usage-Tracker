/**
 * Choosing which camera to scan with from the browser's device list. Labels are the only signal
 * available, so these are heuristics tuned for Android multi-lens phones and desktop webcams.
 */

export function scoreCamera(device: MediaDeviceInfo): number {
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

export function extractCameraIndex(label: string): number | null {
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

export function isFrontFacingCamera(device: MediaDeviceInfo): boolean {
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

export function classifyAndDeduplicateCameras(devices: MediaDeviceInfo[]): MediaDeviceInfo[] {
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

    // Compare the devices themselves: ids can be empty (and so all equal) before camera permission.
    const remaining = rearCameras.filter((d) => d !== primaryDevice);

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

export function isVirtualOrPhoneCamera(device: MediaDeviceInfo): boolean {
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

export function listDesktopCameras(devices: MediaDeviceInfo[]): MediaDeviceInfo[] {
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

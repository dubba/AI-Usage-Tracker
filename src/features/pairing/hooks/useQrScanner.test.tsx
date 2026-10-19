// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ ensureCameraPermission: vi.fn() }));
vi.mock("../../../shared/lib/api", () => ({ pairingApi: api }));

const camera = vi.hoisted(() => ({
  getCameraStream: vi.fn(),
  applyAutofocusAndZoom: vi.fn(async () => {}),
}));
vi.mock("../lib/camera-stream", () => camera);

vi.mock("../lib/qr-decoder", () => ({
  decodeQrSandboxed: () => null,
  sanitizeDecodedQrText: (text: string) => text,
}));

import { mount, type Mounted } from "../../../test-utils/react";
import { ERROR_AUTO_DISMISS_MS } from "../../../shared/hooks/useAutoDismissedError";
import { useQrScanner, type UseQrScannerOptions } from "./useQrScanner";

type Track = { stop: ReturnType<typeof vi.fn>; getSettings: () => MediaTrackSettings };

function makeStream(deviceId = "cam-1"): { stream: MediaStream; track: Track } {
  const track: Track = { stop: vi.fn(), getSettings: () => ({ deviceId, facingMode: "environment" }) };
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] } as unknown as MediaStream;
  return { stream, track };
}

let latest: ReturnType<typeof useQrScanner>;
let detected: string[];

function capture(value: ReturnType<typeof useQrScanner>) {
  latest = value;
}

function Harness(options: UseQrScannerOptions) {
  const scanner = useQrScanner(options);
  capture(scanner);
  return <video ref={scanner.videoRef} />;
}

let mounted: Mounted | null = null;
const baseOptions = (overrides: Partial<UseQrScannerOptions> = {}): UseQrScannerOptions => ({
  active: true,
  restartKey: 0,
  onDecoded: vi.fn(),
  ...overrides,
});

/** Lets the camera start and runs the scan loop for `ms` of fake time, one frame per 200 ms. */
async function runFor(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function installMediaDevices(devices: Partial<MediaDevices> | undefined) {
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: devices });
}

beforeEach(() => {
  vi.useFakeTimers();
  detected = [];
  api.ensureCameraPermission.mockReset().mockResolvedValue(undefined);
  camera.getCameraStream.mockReset();
  camera.applyAutofocusAndZoom.mockClear();
  installMediaDevices({ getUserMedia: vi.fn(), enumerateDevices: vi.fn(async () => []) });
  // A frame every 200 ms: slower than the 150 ms throttle, so every frame is processed.
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
    setTimeout(() => callback(performance.now()), 200) as unknown as number,
  );
  vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
  // A native detector that reads whatever `detected` holds, one code per frame.
  vi.stubGlobal(
    "BarcodeDetector",
    class {
      async detect() {
        const next = detected.shift();
        return next ? [{ rawValue: next }] : [];
      }
    },
  );
  // happy-dom's video element has no real media state; give it a playing 640x480 picture.
  for (const [name, value] of [["readyState", 4], ["videoWidth", 640], ["videoHeight", 480]] as const) {
    Object.defineProperty(HTMLVideoElement.prototype, name, { configurable: true, get: () => value });
  }
  Object.defineProperty(HTMLVideoElement.prototype, "srcObject", { configurable: true, writable: true, value: null });
});

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("camera start", () => {
  it("does nothing while inactive", async () => {
    mounted = mount(<Harness {...baseOptions({ active: false })} />);
    await runFor(500);
    expect(api.ensureCameraPermission).not.toHaveBeenCalled();
    expect(camera.getCameraStream).not.toHaveBeenCalled();
  });

  it("asks for permission, opens the camera and shows it in the video element", async () => {
    const { stream } = makeStream();
    camera.getCameraStream.mockResolvedValue(stream);
    mounted = mount(<Harness {...baseOptions()} />);
    await runFor(10);
    expect(api.ensureCameraPermission).toHaveBeenCalledTimes(1);
    expect(camera.getCameraStream).toHaveBeenCalledTimes(1);
    expect(mounted.container.querySelector("video")!.srcObject).toBe(stream);
    expect(camera.applyAutofocusAndZoom).toHaveBeenCalled();
    expect(latest.cameraError).toBeNull();
  });

  it("carries on when the native permission check fails", async () => {
    api.ensureCameraPermission.mockRejectedValue(new Error("denied"));
    camera.getCameraStream.mockResolvedValue(makeStream().stream);
    mounted = mount(<Harness {...baseOptions()} />);
    await runFor(10);
    expect(camera.getCameraStream).toHaveBeenCalled();
    expect(latest.cameraError).toBeNull();
  });

  it("reads the cameras that are available once the camera is open", async () => {
    camera.getCameraStream.mockResolvedValue(makeStream("cam-1").stream);
    installMediaDevices({
      getUserMedia: vi.fn(),
      enumerateDevices: vi.fn(async () => [
        { kind: "videoinput", deviceId: "cam-1", label: "FaceTime HD Camera", groupId: "g" } as MediaDeviceInfo,
      ]),
    });
    mounted = mount(<Harness {...baseOptions()} />);
    await runFor(10);
    expect(latest.availableCameras.map((camera) => camera.deviceId)).toEqual(["cam-1"]);
  });
});

describe("camera errors", () => {
  async function failWith(error: unknown) {
    camera.getCameraStream.mockRejectedValue(error);
    mounted = mount(<Harness {...baseOptions()} />);
    await runFor(10);
  }
  const named = (name: string) => Object.assign(new Error(name), { name });

  it.each([
    ["NotAllowedError", "Camera permission was denied. Please allow camera access in System Settings > Privacy & Security > Camera."],
    ["PermissionDeniedError", "Camera permission was denied. Please allow camera access in System Settings > Privacy & Security > Camera."],
    ["NotFoundError", "No camera detected. Please verify your webcam is connected."],
    ["DevicesNotFoundError", "No camera detected. Please verify your webcam is connected."],
    ["NotReadableError", "Camera is currently in use by another application."],
    ["TrackStartError", "Camera is currently in use by another application."],
  ])("%s becomes a plain sentence", async (name, message) => {
    await failWith(named(name));
    expect(latest.cameraError).toBe(message);
  });

  it("prefers the operating system's own wording for a denied permission", async () => {
    api.ensureCameraPermission.mockRejectedValue(new Error("Camera access is turned off for this app."));
    await failWith(named("NotAllowedError"));
    expect(latest.cameraError).toBe("Camera access is turned off for this app.");
  });

  it("describes any other failure in plain words", async () => {
    await failWith(new Error("boom"));
    expect(latest.cameraError).toBe("Camera error: boom");
  });

  it("explains a device with no camera API, depending on whether the page is secure", async () => {
    installMediaDevices(undefined);
    vi.stubGlobal("isSecureContext", true);
    mounted = mount(<Harness {...baseOptions()} />);
    await runFor(10);
    expect(latest.cameraError).toContain("not supported on this device");
    mounted.unmount();

    vi.stubGlobal("isSecureContext", false);
    mounted = mount(<Harness {...baseOptions()} />);
    await runFor(10);
    expect(latest.cameraError).toContain("secure context");
  });

  it("hides the message after a few seconds and clears it on request", async () => {
    await failWith(named("NotFoundError"));
    expect(latest.cameraError).not.toBeNull();
    await runFor(ERROR_AUTO_DISMISS_MS);
    expect(latest.cameraError).toBeNull();

    await act(async () => {
      mounted!.rerender(<Harness {...baseOptions({ restartKey: 1 })} />);
    });
    await runFor(10);
    expect(latest.cameraError).not.toBeNull();
    act(() => latest.clearCameraError());
    expect(latest.cameraError).toBeNull();
  });
});

describe("scanning", () => {
  async function startScanning(options: Partial<UseQrScannerOptions> = {}) {
    const { stream, track } = makeStream();
    camera.getCameraStream.mockResolvedValue(stream);
    const opts = baseOptions(options);
    mounted = mount(<Harness {...opts} />);
    await runFor(10);
    return { opts, track };
  }

  it("hands each code it reads to onDecoded, and keeps scanning when it returns nothing", async () => {
    const onDecoded = vi.fn();
    detected = ["first", "second"];
    await startScanning({ onDecoded });
    await runFor(1000);
    expect(onDecoded.mock.calls.map(([code]) => code)).toEqual(["first", "second"]);
  });

  it("stops the camera and the loop when onDecoded returns true", async () => {
    const onDecoded = vi.fn().mockResolvedValue(true);
    detected = ["link", "another"];
    const { track } = await startScanning({ onDecoded });
    await runFor(1000);
    expect(onDecoded).toHaveBeenCalledTimes(1);
    expect(track.stop).toHaveBeenCalled();
  });

  it("lets onDecoded stop the camera itself and keep scanning", async () => {
    const onDecoded = vi.fn((_code: string, controls: { stopCamera: () => void }) => controls.stopCamera());
    detected = ["frame"];
    const { track } = await startScanning({ onDecoded });
    await runFor(400);
    expect(track.stop).toHaveBeenCalled();
    expect(onDecoded).toHaveBeenCalledTimes(1);
  });

  it("drops a code whose handling failed, reports it, and goes on", async () => {
    const onError = vi.fn();
    const onDecoded = vi
      .fn()
      .mockRejectedValueOnce(new Error("no network"))
      .mockResolvedValue(undefined);
    detected = ["bad", "good"];
    await startScanning({ onDecoded, onError });
    await runFor(1000);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "no network" }));
    expect(onDecoded).toHaveBeenCalledTimes(2);
  });

  it("calls the newest onDecoded without restarting the camera", async () => {
    const first = vi.fn();
    const second = vi.fn();
    await startScanning({ onDecoded: first });
    camera.getCameraStream.mockClear();
    await act(async () => {
      mounted!.rerender(<Harness {...baseOptions({ onDecoded: second })} />);
    });
    detected = ["code"];
    await runFor(500);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith("code", expect.any(Object));
    expect(camera.getCameraStream).not.toHaveBeenCalled();
  });

  it("restarts the camera when restartKey changes", async () => {
    const { track } = await startScanning();
    camera.getCameraStream.mockResolvedValue(makeStream().stream);
    await act(async () => {
      mounted!.rerender(<Harness {...baseOptions({ restartKey: 1 })} />);
    });
    await runFor(10);
    expect(track.stop).toHaveBeenCalled();
    expect(camera.getCameraStream).toHaveBeenCalledTimes(2);
  });

  it("stops every track and forgets the cameras when it goes inactive", async () => {
    const { track } = await startScanning();
    await act(async () => {
      mounted!.rerender(<Harness {...baseOptions({ active: false })} />);
    });
    expect(track.stop).toHaveBeenCalled();
    expect(latest.availableCameras).toEqual([]);
    expect(latest.isFrontCamera).toBe(false);
  });

  it("stops the camera when the screen unmounts", async () => {
    const { track } = await startScanning();
    mounted!.unmount();
    mounted = null;
    expect(track.stop).toHaveBeenCalled();
  });

  it("stopCamera releases the stream on demand", async () => {
    const { track } = await startScanning();
    act(() => latest.stopCamera());
    expect(track.stop).toHaveBeenCalled();
  });

  it("applies autofocus when the view is tapped", async () => {
    await startScanning();
    camera.applyAutofocusAndZoom.mockClear();
    await act(async () => {
      await latest.handleScannerTap();
    });
    expect(camera.applyAutofocusAndZoom).toHaveBeenCalledTimes(1);
  });
});

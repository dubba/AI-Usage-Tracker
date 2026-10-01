import { describe, expect, it, vi } from "vitest";
import { applyAutofocusAndZoom, getCameraStream } from "./camera-stream";

const STREAM = { id: "stream" } as unknown as MediaStream;
const reject = () => Promise.reject(new Error("OverconstrainedError"));

/** A getUserMedia that fails for the first `failures` calls, then succeeds. */
const failingFirst = (failures: number) => {
  const calls: MediaStreamConstraints[] = [];
  const fn = vi.fn(async (constraints: MediaStreamConstraints) => {
    calls.push(constraints);
    return calls.length <= failures ? reject() : STREAM;
  });
  return { fn, calls };
};

describe("getCameraStream with a chosen camera", () => {
  it("asks for that exact camera at 720p first", async () => {
    const { fn, calls } = failingFirst(0);
    await expect(getCameraStream(fn, "cam-1", true)).resolves.toBe(STREAM);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ video: { deviceId: { exact: "cam-1" }, width: { ideal: 1280 }, height: { ideal: 720 } } });
  });

  it("retries the same camera without resolution limits, which auxiliary lenses need", async () => {
    const { fn, calls } = failingFirst(1);
    await getCameraStream(fn, "tele", true);
    expect(calls[1]).toEqual({ video: { deviceId: { exact: "tele" } } });
  });

  it("then tries the camera as a preference rather than a requirement", async () => {
    const { fn, calls } = failingFirst(2);
    await getCameraStream(fn, "tele", true);
    expect(calls[2]).toEqual({ video: { deviceId: { ideal: "tele" } } });
  });

  it("falls back to the rear camera on mobile when the chosen one cannot be opened", async () => {
    const { fn, calls } = failingFirst(3);
    await getCameraStream(fn, "gone", true);
    expect(calls[3]).toEqual({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } } });
  });
});

describe("getCameraStream without a chosen camera", () => {
  it("prefers the rear camera on mobile", async () => {
    const { fn, calls } = failingFirst(0);
    await getCameraStream(fn, null, true);
    expect(calls).toEqual([{ video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } } }]);
  });

  it("settles for any camera on mobile when no rear camera is available", async () => {
    const { fn, calls } = failingFirst(1);
    await getCameraStream(fn, null, true);
    expect(calls[1]).toEqual({ video: true });
  });

  it("never asks a desktop webcam for a facing mode", async () => {
    const { fn, calls } = failingFirst(0);
    await getCameraStream(fn, null, false);
    expect(calls).toEqual([{ video: true }]);
    expect(JSON.stringify(calls)).not.toContain("facingMode");
  });

  it("retries a desktop webcam at 720p when plain video fails", async () => {
    const { fn, calls } = failingFirst(1);
    await getCameraStream(fn, null, false);
    expect(calls[1]).toEqual({ video: { width: { ideal: 1280 }, height: { ideal: 720 } } });
  });

  it("gives up with the last error when nothing works", async () => {
    const { fn } = failingFirst(99);
    await expect(getCameraStream(fn, null, false)).rejects.toThrow("OverconstrainedError");
    await expect(getCameraStream(failingFirst(99).fn, null, true)).rejects.toThrow("OverconstrainedError");
  });
});

describe("applyAutofocusAndZoom", () => {
  const track = (capabilities: unknown, applyConstraints = vi.fn(async () => {})) =>
    ({ getCapabilities: () => capabilities, applyConstraints }) as unknown as MediaStreamTrack;

  it("does nothing without a track", async () => {
    await expect(applyAutofocusAndZoom(undefined)).resolves.toBeUndefined();
  });

  it("asks for continuous focus and the least zoom when available", async () => {
    const applyConstraints = vi.fn(async () => {});
    await applyAutofocusAndZoom(
      track({ focusMode: ["manual", "continuous", "auto"], zoom: { min: 0.5, max: 5 } }, applyConstraints),
    );
    expect(applyConstraints).toHaveBeenCalledWith({ advanced: [{ focusMode: "continuous", zoom: 1 }] });
  });

  it("falls back to auto focus", async () => {
    const applyConstraints = vi.fn(async () => {});
    await applyAutofocusAndZoom(track({ focusMode: ["auto"] }, applyConstraints));
    expect(applyConstraints).toHaveBeenCalledWith({ advanced: [{ focusMode: "auto" }] });
  });

  it("does not change the camera when it offers nothing to tune", async () => {
    const applyConstraints = vi.fn(async () => {});
    await applyAutofocusAndZoom(track({}, applyConstraints));
    await applyAutofocusAndZoom({ applyConstraints } as unknown as MediaStreamTrack);
    expect(applyConstraints).not.toHaveBeenCalled();
  });

  it("ignores a camera that rejects the constraints", async () => {
    const applyConstraints = vi.fn(async () => {
      throw new Error("not supported");
    });
    await expect(applyAutofocusAndZoom(track({ focusMode: ["auto"] }, applyConstraints))).resolves.toBeUndefined();
  });
});

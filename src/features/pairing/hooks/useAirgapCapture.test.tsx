// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ verifyAirgapFrames: vi.fn() }));
vi.mock("../../../shared/lib/api", () => ({ pairingApi: api }));

import { mount, settle, type Mounted } from "../../../test-utils/react";
import { useAirgapCapture } from "./useAirgapCapture";

type Capture = ReturnType<typeof useAirgapCapture>;
let capture: Capture;
const callbacks = { onVerifyStart: vi.fn(), onVerifyError: vi.fn(), onRescan: vi.fn() };

function keep(value: Capture) {
  capture = value;
}

function Harness({ active = true }: { active?: boolean }) {
  keep(useAirgapCapture({ active, ...callbacks }));
  return null;
}

let mounted: Mounted | null = null;
const render = (active = true) => {
  mounted = mount(<Harness active={active} />);
};

const frame = (session: string, index: number, total: number) => `aiut-airgap://1/${session}/${index}/${total}/ab12?d=payload${index}`;

/** Scans one frame; returns whether the hook said the capture is complete. */
function scan(code: string): boolean {
  const done = vi.fn();
  act(() => capture.addFrame(code, done));
  return done.mock.calls.length > 0;
}

beforeEach(() => {
  api.verifyAirgapFrames.mockReset();
  api.verifyAirgapFrames.mockResolvedValue({ sessionId: "s1", verifyCode: "4821" });
  for (const spy of Object.values(callbacks)) spy.mockReset();
});

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  vi.useRealTimers();
});

describe("useAirgapCapture: collecting frames", () => {
  it("starts empty", () => {
    render();
    expect(capture.chunks.size).toBe(0);
    expect(capture.total).toBe(0);
    expect(capture.verifyPrompt).toBe(false);
    expect(capture.verifyCode).toBeNull();
  });

  it("keeps each frame once and reports the total", () => {
    render();
    expect(scan(frame("s1", 1, 3))).toBe(false);
    expect(scan(frame("s1", 1, 3))).toBe(false);
    expect(scan(frame("s1", 3, 3))).toBe(false);
    expect([...capture.chunks.keys()]).toEqual([1, 3]);
    expect(capture.total).toBe(3);
    expect(capture.sessionIdRef.current).toBe("s1");
    expect(capture.verifyPrompt).toBe(false);
  });

  it("ignores anything that is not a well-formed frame", () => {
    render();
    scan("https://example.com");
    scan("aiut-airgap://broken");
    scan("aiut-airgap://1/s1/0/3/ab12?d=x");
    expect(capture.chunks.size).toBe(0);
    expect(capture.sessionIdRef.current).toBeNull();
  });

  it("starts over when a frame of another transfer arrives", () => {
    render();
    scan(frame("s1", 1, 3));
    scan(frame("s1", 2, 3));
    scan(frame("s2", 2, 2));
    expect([...capture.chunks.keys()]).toEqual([2]);
    expect(capture.total).toBe(2);
    expect(capture.sessionIdRef.current).toBe("s2");
  });

  it("on the last frame records the time taken, opens the comparison and tells the caller", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-16T12:00:00Z"));
    render();
    scan(frame("s1", 1, 2));
    vi.setSystemTime(new Date("2026-11-16T12:00:04.4Z"));
    expect(scan(frame("s1", 2, 2))).toBe(true);
    expect(capture.captureSecs).toBe(4);
    expect(capture.verifyPrompt).toBe(true);
    expect(capture.verifyPromptRef.current).toBe(true);
  });

  it("reports at least one second for an instant capture", () => {
    render();
    scan(frame("s1", 1, 1));
    expect(capture.captureSecs).toBe(1);
  });
});

describe("useAirgapCapture: asking for the code to compare", () => {
  it("asks once with every frame, then holds the code", async () => {
    render();
    scan(frame("s1", 2, 2));
    scan(frame("s1", 1, 2));
    expect(capture.verifying).toBe(true);
    expect(callbacks.onVerifyStart).toHaveBeenCalledTimes(1);
    await settle();
    expect(api.verifyAirgapFrames).toHaveBeenCalledTimes(1);
    expect(api.verifyAirgapFrames).toHaveBeenCalledWith([frame("s1", 2, 2), frame("s1", 1, 2)]);
    expect(capture.verifyCode).toBe("4821");
    expect(capture.verifying).toBe(false);
    // Re-rendering with the code in hand does not ask again.
    mounted?.rerender(<Harness />);
    await settle();
    expect(api.verifyAirgapFrames).toHaveBeenCalledTimes(1);
  });

  it("waits until the scanner is on screen", async () => {
    render(false);
    scan(frame("s1", 1, 1));
    await settle();
    expect(api.verifyAirgapFrames).not.toHaveBeenCalled();
    mounted?.rerender(<Harness active />);
    await settle();
    expect(api.verifyAirgapFrames).toHaveBeenCalledTimes(1);
  });

  it("on failure reports it, throws the frames away and asks to scan again", async () => {
    api.verifyAirgapFrames.mockRejectedValue(new Error("frames do not match"));
    render();
    scan(frame("s1", 1, 1));
    await settle();
    expect(callbacks.onVerifyError).toHaveBeenCalledWith("frames do not match");
    expect(callbacks.onRescan).toHaveBeenCalledTimes(1);
    expect(capture.chunks.size).toBe(0);
    expect(capture.verifyPrompt).toBe(false);
    expect(capture.verifyPromptRef.current).toBe(false);
    expect(capture.sessionIdRef.current).toBeNull();
    expect(capture.captureSecs).toBeNull();
    expect(capture.verifying).toBe(false);
  });

  it("verifies again when the same transfer is rescanned after a failure", async () => {
    api.verifyAirgapFrames.mockRejectedValueOnce("bad frames");
    render();
    scan(frame("s1", 1, 1));
    await settle();
    expect(callbacks.onVerifyError).toHaveBeenCalledWith("bad frames");
    scan(frame("s1", 1, 1));
    await settle();
    expect(api.verifyAirgapFrames).toHaveBeenCalledTimes(2);
    expect(capture.verifyCode).toBe("4821");
  });
});

describe("useAirgapCapture: leaving the comparison", () => {
  async function completed() {
    render();
    scan(frame("s1", 1, 1));
    await settle();
    expect(capture.verifyCode).toBe("4821");
  }

  it("rescan goes back to scanning the same transfer with nothing captured", async () => {
    await completed();
    act(() => capture.rescan());
    expect(capture.verifyPrompt).toBe(false);
    expect(capture.verifyCode).toBeNull();
    expect(capture.chunks.size).toBe(0);
    expect(capture.captureSecs).toBeNull();
    // The transfer is still the one being scanned, so its next frame adds to it.
    expect(capture.sessionIdRef.current).toBe("s1");
  });

  it("closePrompt hides the comparison and keeps the frames and the code", async () => {
    await completed();
    act(() => capture.closePrompt());
    expect(capture.verifyPrompt).toBe(false);
    expect(capture.verifyPromptRef.current).toBe(false);
    expect(capture.verifyCode).toBe("4821");
    expect(capture.chunks.size).toBe(1);
  });

  it("clearCapture forgets the frames and the transfer but leaves the prompt flag", async () => {
    await completed();
    act(() => capture.clearCapture());
    expect(capture.chunks.size).toBe(0);
    expect(capture.total).toBe(0);
    expect(capture.verifyCode).toBeNull();
    expect(capture.sessionIdRef.current).toBeNull();
    expect(capture.verifyPrompt).toBe(true);
  });

  it("resetAll clears everything, including the importing flag", async () => {
    await completed();
    act(() => capture.setImporting(true));
    act(() => capture.resetAll());
    expect(capture.chunks.size).toBe(0);
    expect(capture.verifyPrompt).toBe(false);
    expect(capture.verifyCode).toBeNull();
    expect(capture.importing).toBe(false);
    expect(capture.verifying).toBe(false);
  });
});

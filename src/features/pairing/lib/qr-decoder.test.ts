// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const jsqr = vi.hoisted(() => vi.fn());
vi.mock("jsqr", () => ({ default: jsqr }));

import { decodeQrSandboxed, sanitizeDecodedQrText } from "./qr-decoder";

const frame = (width: number, height: number) =>
  ({ width, height, data: new Uint8ClampedArray(Math.max(0, Math.min(width * height * 4, 16))) }) as unknown as ImageData;

describe("sanitizeDecodedQrText", () => {
  it.each(["aiusage-pair:abc", "aiusage:abc", "aiut-airgap:1/3/payload", "aiut-airgap://payload"])("accepts %s", (text) => {
    expect(sanitizeDecodedQrText(text)).toBe(text);
  });

  it("trims surrounding whitespace", () => {
    expect(sanitizeDecodedQrText("  aiusage:abc\n")).toBe("aiusage:abc");
  });

  it.each([
    ["https://example.com", "another scheme"],
    ["javascript:alert(1)", "script scheme"],
    ["file:///etc/passwd", "file scheme"],
    ["xaiusage:abc", "prefix not at the start"],
    ["AIUSAGE:abc", "different case"],
    ["", "empty text"],
    ["   ", "only whitespace"],
  ])("rejects %s (%s)", (text) => {
    expect(sanitizeDecodedQrText(text)).toBeNull();
  });

  it("rejects control characters inside the text", () => {
    expect(sanitizeDecodedQrText("aiusage:ab\u0000c")).toBeNull();
    expect(sanitizeDecodedQrText("aiusage:ab\ncd")).toBeNull();
    expect(sanitizeDecodedQrText("aiusage:ab\u007Fcd")).toBeNull();
  });

  it("rejects payloads over the length cap but accepts one right at it", () => {
    const prefix = "aiusage:";
    expect(sanitizeDecodedQrText(prefix + "a".repeat(2048 - prefix.length))).not.toBeNull();
    expect(sanitizeDecodedQrText(prefix + "a".repeat(2049 - prefix.length))).toBeNull();
  });

  it.each([null, undefined, 42, {}, ["aiusage:x"]])("rejects the non-string %j", (value) => {
    expect(sanitizeDecodedQrText(value)).toBeNull();
  });
});

describe("decodeQrSandboxed", () => {
  beforeEach(() => {
    jsqr.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the text jsQR finds when it is an allowed payload", () => {
    jsqr.mockReturnValue({ data: "aiusage-pair:token" });
    expect(decodeQrSandboxed(frame(640, 480))).toBe("aiusage-pair:token");
    expect(jsqr).toHaveBeenCalledWith(expect.anything(), 640, 480, { inversionAttempts: "attemptBoth" });
  });

  it("returns null when no code is found", () => {
    jsqr.mockReturnValue(null);
    expect(decodeQrSandboxed(frame(640, 480))).toBeNull();
  });

  it("drops a decoded payload with a disallowed scheme", () => {
    jsqr.mockReturnValue({ data: "https://evil.example" });
    expect(decodeQrSandboxed(frame(640, 480))).toBeNull();
  });

  it("contains an exception thrown by the decoder", () => {
    jsqr.mockImplementation(() => {
      throw new Error("crafted frame");
    });
    expect(decodeQrSandboxed(frame(640, 480))).toBeNull();
  });

  it.each([
    [0, 480],
    [640, 0],
    [-1, 480],
    [4097, 100],
    [100, 4097],
    [4096, 4096],
  ])("refuses a %ix%i frame without calling the decoder", (width, height) => {
    expect(decodeQrSandboxed(frame(width, height))).toBeNull();
    expect(jsqr).not.toHaveBeenCalled();
  });

  describe("large frames", () => {
    function fakeCanvases(contextAvailable = true) {
      const created: Array<{ width: number; height: number }> = [];
      const original = document.createElement.bind(document);
      vi.spyOn(document, "createElement").mockImplementation(((tag: string) => {
        if (tag !== "canvas") return original(tag);
        const canvas = {
          width: 0,
          height: 0,
          getContext: () =>
            contextAvailable
              ? {
                  putImageData: () => {},
                  drawImage: () => {},
                  getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(4), width: w, height: h }),
                }
              : null,
        };
        created.push(canvas);
        return canvas as unknown as HTMLCanvasElement;
      }) as typeof document.createElement);
      return created;
    }

    it("shrinks a frame above the pixel budget before decoding", () => {
      fakeCanvases();
      jsqr.mockReturnValue({ data: "aiusage:x" });
      expect(decodeQrSandboxed(frame(1920, 1080))).toBe("aiusage:x");
      const [, width, height] = jsqr.mock.calls[0];
      expect(width * height).toBeLessThanOrEqual(960 * 960);
      expect(width / height).toBeCloseTo(1920 / 1080, 1);
    });

    it("does not touch a canvas for a frame within the budget", () => {
      const created = fakeCanvases();
      jsqr.mockReturnValue(null);
      decodeQrSandboxed(frame(960, 960));
      expect(created).toHaveLength(0);
    });

    it("gives up when it cannot get a canvas to shrink with", () => {
      fakeCanvases(false);
      expect(decodeQrSandboxed(frame(1920, 1080))).toBeNull();
      expect(jsqr).not.toHaveBeenCalled();
    });
  });
});

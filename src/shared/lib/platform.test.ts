// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { isAndroid, isMobileDevice, isMobileUserAgent } from "./platform";

function stub(userAgent: string, coarse = false) {
  vi.stubGlobal("navigator", { userAgent });
  vi.stubGlobal("matchMedia", () => ({ matches: coarse }));
  window.matchMedia = (() => ({ matches: coarse })) as unknown as typeof window.matchMedia;
}

afterEach(() => vi.unstubAllGlobals());

describe("platform detection", () => {
  it("detects mobile user agents", () => {
    stub("Mozilla/5.0 (Linux; Android 14; Pixel 8)");
    expect(isMobileUserAgent()).toBe(true);
    expect(isAndroid()).toBe(true);
    stub("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)");
    expect(isMobileUserAgent()).toBe(true);
    expect(isAndroid()).toBe(false);
  });

  it("treats a desktop user agent with a fine pointer as not mobile", () => {
    stub("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)");
    expect(isMobileUserAgent()).toBe(false);
    expect(isMobileDevice()).toBe(false);
  });

  it("treats a coarse pointer as mobile even with a desktop user agent", () => {
    stub("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", true);
    expect(isMobileUserAgent()).toBe(false);
    expect(isMobileDevice()).toBe(true);
  });
});

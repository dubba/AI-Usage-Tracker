import { describe, expect, it } from "vitest";
import {
  clampSidebarWidth,
  DEFAULT_DESKTOP_SIDEBAR_WIDTH,
  DEFAULT_MOBILE_SIDEBAR_WIDTH,
  defaultSidebarWidth,
  maxSidebarWidth,
  MAX_SIDEBAR_WIDTH,
} from "./sidebar-width";

describe("maxSidebarWidth", () => {
  it("leaves room for the main area on desktop", () => {
    expect(maxSidebarWidth({ overlay: false, viewportWidth: 1280, shellWidth: 1200, min: 240 })).toBe(680);
  });

  it("caps at the absolute maximum on very wide windows", () => {
    expect(maxSidebarWidth({ overlay: false, viewportWidth: 3000, shellWidth: 3000, min: 240 })).toBe(MAX_SIDEBAR_WIDTH);
  });

  it("leaves a tap-away gutter beside the phone overlay", () => {
    expect(maxSidebarWidth({ overlay: true, viewportWidth: 390, shellWidth: 390, min: 240 })).toBe(342);
  });

  it("never goes below the minimum, even in a tiny window", () => {
    expect(maxSidebarWidth({ overlay: false, viewportWidth: 600, shellWidth: 600, min: 240 })).toBe(240);
  });
});

describe("clampSidebarWidth", () => {
  it("rounds and keeps the width inside the range", () => {
    expect(clampSidebarWidth(300.4, 240, 600)).toBe(300);
    expect(clampSidebarWidth(100, 240, 600)).toBe(240);
    expect(clampSidebarWidth(900, 240, 600)).toBe(600);
  });

  it("lets the maximum win when there is less room than the minimum", () => {
    expect(clampSidebarWidth(500, 300, 250)).toBe(250);
  });
});

describe("defaultSidebarWidth", () => {
  it("has separate defaults for the phone overlay and desktop", () => {
    expect(defaultSidebarWidth(true)).toBe(DEFAULT_MOBILE_SIDEBAR_WIDTH);
    expect(defaultSidebarWidth(false)).toBe(DEFAULT_DESKTOP_SIDEBAR_WIDTH);
  });
});

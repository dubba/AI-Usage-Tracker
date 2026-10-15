// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  computeDropdownPlacement,
  createsFixedContainingBlock,
  getClippingBounds,
  getFixedContainingBlockBox,
  getMenuContentHeight,
} from "./dropdown-placement";

function rectOf(rect: { top: number; left: number; width: number; height: number }) {
  return {
    x: rect.left,
    y: rect.top,
    top: rect.top,
    left: rect.left,
    right: rect.left + rect.width,
    bottom: rect.top + rect.height,
    width: rect.width,
    height: rect.height,
    toJSON: () => ({}),
  } as DOMRect;
}

function styleWith(values: Record<string, string>) {
  return values as unknown as CSSStyleDeclaration;
}

describe("dropdown-placement", () => {
  beforeEach(() => {
    vi.stubGlobal("innerHeight", 800);
    vi.stubGlobal("innerWidth", 600);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  describe("getClippingBounds", () => {
    it("returns viewport bounds when there are no clipping ancestors", () => {
      const el = document.createElement("div");
      document.body.appendChild(el);

      const bounds = getClippingBounds(el);
      expect(bounds.top).toBe(0);
      expect(bounds.bottom).toBe(800);
    });

    it("intersects with named scroll containers like dashboard-scroll", () => {
      const container = document.createElement("div");
      container.className = "dashboard-scroll";
      container.getBoundingClientRect = () => ({
        top: 60,
        bottom: 700,
        left: 0,
        right: 400,
        width: 400,
        height: 640,
        x: 0,
        y: 60,
        toJSON: () => ({}),
      });

      const child = document.createElement("button");
      container.appendChild(child);
      document.body.appendChild(container);

      const bounds = getClippingBounds(child);
      expect(bounds.top).toBe(60);
      expect(bounds.bottom).toBe(700);
    });

    it("bounds isFixed elements to the viewport", () => {
      const container = document.createElement("div");
      container.className = "dashboard-scroll";
      container.getBoundingClientRect = () => ({
        top: 60,
        bottom: 500,
        left: 0,
        right: 400,
        width: 400,
        height: 440,
        x: 0,
        y: 60,
        toJSON: () => ({}),
      });

      const child = document.createElement("div");
      container.appendChild(child);
      document.body.appendChild(container);

      const bounds = getClippingBounds(child, { isFixed: true });
      expect(bounds.top).toBe(0);
      expect(bounds.bottom).toBe(800);
    });
  });

  describe("createsFixedContainingBlock", () => {
    const plain = () => styleWith({ transform: "none", filter: "none", perspective: "none", willChange: "auto", contain: "none" });

    it("returns false for plain styles", () => {
      expect(createsFixedContainingBlock(plain())).toBe(false);
    });

    it("returns false when unsupported properties come back empty or undefined", () => {
      expect(createsFixedContainingBlock(styleWith({}))).toBe(false);
      expect(createsFixedContainingBlock(styleWith({ transform: "", backdropFilter: undefined as unknown as string }))).toBe(false);
    });

    it("returns true for transform, filter, and perspective", () => {
      expect(createsFixedContainingBlock(styleWith({ transform: "matrix(1, 0, 0, 1, 0, 0)" }))).toBe(true);
      expect(createsFixedContainingBlock(styleWith({ transform: "translateY(0)" }))).toBe(true);
      expect(createsFixedContainingBlock(styleWith({ filter: "brightness(1.18)" }))).toBe(true);
      expect(createsFixedContainingBlock(styleWith({ perspective: "500px" }))).toBe(true);
    });

    it("returns true for backdrop-filter, which modal backdrops always set", () => {
      expect(createsFixedContainingBlock(styleWith({ backdropFilter: "blur(3px)" }))).toBe(true);
    });

    it("returns true for will-change and layout containment", () => {
      expect(createsFixedContainingBlock(styleWith({ willChange: "transform" }))).toBe(true);
      expect(createsFixedContainingBlock(styleWith({ contain: "layout paint" }))).toBe(true);
    });
  });

  describe("getFixedContainingBlockBox", () => {
    it("returns a zero box when the viewport is the containing block", () => {
      const el = document.createElement("div");
      document.body.appendChild(el);
      expect(getFixedContainingBlockBox(el)).toEqual({ left: 0, top: 0, height: 0 });
    });

    it("returns null safely", () => {
      expect(getFixedContainingBlockBox(null)).toEqual({ left: 0, top: 0, height: 0 });
    });

    it("measures the padding-box origin of a transformed ancestor, adjusted for scroll", () => {
      const backdrop = document.createElement("div");
      backdrop.getBoundingClientRect = () => rectOf({ top: 100, left: 60, width: 400, height: 600 });
      Object.defineProperty(backdrop, "clientLeft", { value: 2, configurable: true });
      Object.defineProperty(backdrop, "clientTop", { value: 3, configurable: true });
      Object.defineProperty(backdrop, "clientHeight", { value: 593, configurable: true });
      Object.defineProperty(backdrop, "scrollLeft", { value: 0, configurable: true });
      Object.defineProperty(backdrop, "scrollTop", { value: 40, configurable: true });
      const child = document.createElement("div");
      backdrop.appendChild(child);
      document.body.appendChild(backdrop);

      const real = window.getComputedStyle;
      vi.spyOn(window, "getComputedStyle").mockImplementation(((el: Element) => {
        if (el === backdrop) {
          return styleWith({
            transform: "none",
            filter: "none",
            backdropFilter: "blur(3px)",
            perspective: "none",
            willChange: "auto",
            contain: "none",
          });
        }
        return real.call(window, el);
      }) as typeof window.getComputedStyle);

      // left = 60 + 2 - 0, top = 100 + 3 - 40, height = clientHeight
      expect(getFixedContainingBlockBox(child)).toEqual({ left: 62, top: 63, height: 593 });
    });

    it("starts past a reserved scrollbar gutter, not at the border edge", () => {
      // `.modal-backdrop` is full-viewport with `scrollbar-gutter: stable
      // both-edges` and a 6px scrollbar: Chromium reports clientLeft = 6 and
      // places fixed descendants from x = 6, not from its border edge at x = 0.
      const backdrop = document.createElement("div");
      backdrop.getBoundingClientRect = () => rectOf({ top: 0, left: 0, width: 375, height: 812 });
      Object.defineProperty(backdrop, "clientLeft", { value: 6, configurable: true });
      Object.defineProperty(backdrop, "clientTop", { value: 0, configurable: true });
      Object.defineProperty(backdrop, "clientHeight", { value: 812, configurable: true });
      const child = document.createElement("div");
      backdrop.appendChild(child);
      document.body.appendChild(backdrop);

      const real = window.getComputedStyle;
      vi.spyOn(window, "getComputedStyle").mockImplementation(((el: Element) =>
        el === backdrop ? styleWith({ backdropFilter: "blur(3px)" }) : real.call(window, el)) as typeof window.getComputedStyle);

      expect(getFixedContainingBlockBox(child)).toEqual({ left: 6, top: 0, height: 812 });
    });
  });

  describe("getMenuContentHeight", () => {
    it("returns 0 for null", () => {
      expect(getMenuContentHeight(null)).toBe(0);
    });

    it("measures scrollHeight and borders when content overflows", () => {
      const menu = document.createElement("div");
      menu.getBoundingClientRect = () => ({
        top: 0,
        bottom: 120,
        left: 0,
        right: 200,
        width: 200,
        height: 120,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      });
      Object.defineProperty(menu, "scrollHeight", { value: 215, configurable: true });

      expect(getMenuContentHeight(menu)).toBe(215);
    });
  });

  describe("computeDropdownPlacement", () => {
    it("opens downward when there is sufficient space below", () => {
      const toggle = document.createElement("button");
      toggle.getBoundingClientRect = () => ({
        top: 100,
        bottom: 132,
        left: 300,
        right: 332,
        width: 32,
        height: 32,
        x: 300,
        y: 100,
        toJSON: () => ({}),
      });

      const result = computeDropdownPlacement(toggle, null, {
        gap: 8,
        estimatedHeight: 200,
      });

      expect(result.openUpward).toBe(false);
      expect(result.spaceBelow).toBe(800 - 132 - 8); // 660
      expect(result.spaceAbove).toBe(100 - 0 - 8); // 92
      expect(result.maxHeight).toBe(660);
    });

    it("flips upward when space below is insufficient for the menu height", () => {
      const toggle = document.createElement("button");
      // Placed near the bottom: bottom at 680, viewport is 800
      toggle.getBoundingClientRect = () => ({
        top: 648,
        bottom: 680,
        left: 300,
        right: 332,
        width: 32,
        height: 32,
        x: 300,
        y: 648,
        toJSON: () => ({}),
      });

      // Menu requires 215px, but space below is only 800 - 680 - 8 = 112px
      const result = computeDropdownPlacement(toggle, null, {
        gap: 8,
        estimatedHeight: 215,
      });

      expect(result.openUpward).toBe(true);
      expect(result.spaceBelow).toBe(112);
      expect(result.spaceAbove).toBe(640);
      expect(result.maxHeight).toBe(640);
    });

    it("uses measured menu height from DOM element over estimated height", () => {
      const toggle = document.createElement("button");
      // Space below is 800 - 592 - 8 = 200px
      toggle.getBoundingClientRect = () => ({
        top: 560,
        bottom: 592,
        left: 300,
        right: 332,
        width: 32,
        height: 32,
        x: 300,
        y: 560,
        toJSON: () => ({}),
      });

      const menu = document.createElement("div");
      Object.defineProperty(menu, "scrollHeight", { value: 215, configurable: true });

      // With an old estimate of 195, 200px space below would NOT flip
      // But with actual measured height of 215px, it MUST flip upward!
      const result = computeDropdownPlacement(toggle, menu, {
        gap: 8,
        estimatedHeight: 195,
      });

      expect(result.menuHeight).toBe(215);
      expect(result.openUpward).toBe(true);
      expect(result.spaceBelow).toBe(200);
      expect(result.spaceAbove).toBe(552);
    });

    it("respects clipping container bounds (e.g. dashboard-scroll)", () => {
      const container = document.createElement("div");
      container.className = "dashboard-scroll";
      container.getBoundingClientRect = () => ({
        top: 50,
        bottom: 600,
        left: 0,
        right: 400,
        width: 400,
        height: 550,
        x: 0,
        y: 50,
        toJSON: () => ({}),
      });

      const toggle = document.createElement("button");
      // Inside container: toggle bottom at 560, container bottom at 600 -> space below is 600 - 560 - 8 = 32px
      toggle.getBoundingClientRect = () => ({
        top: 528,
        bottom: 560,
        left: 300,
        right: 332,
        width: 32,
        height: 32,
        x: 300,
        y: 528,
        toJSON: () => ({}),
      });

      container.appendChild(toggle);
      document.body.appendChild(container);

      const result = computeDropdownPlacement(toggle, null, {
        gap: 8,
        estimatedHeight: 200,
        isFixed: false,
      });

      expect(result.openUpward).toBe(true);
      expect(result.spaceBelow).toBe(32);
      expect(result.spaceAbove).toBe(528 - 50 - 8); // 470
      expect(result.maxHeight).toBe(470);
    });

    it("respects maxHeightCap when set", () => {
      const toggle = document.createElement("button");
      toggle.getBoundingClientRect = () => ({
        top: 100,
        bottom: 132,
        left: 300,
        right: 332,
        width: 32,
        height: 32,
        x: 300,
        y: 100,
        toJSON: () => ({}),
      });

      const result = computeDropdownPlacement(toggle, null, {
        gap: 5,
        maxHeightCap: 280,
      });

      expect(result.maxHeight).toBe(280);
    });
  });
});

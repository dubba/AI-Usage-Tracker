// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  computeDropdownPlacement,
  getClippingBounds,
  getMenuContentHeight,
} from "./dropdown-placement";

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

// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { click, mount, type Mounted } from "../../test-utils/react";
import { UsageDisplayToggle } from "./UsageDisplayToggle";
import { getUsageDisplayMode, setUsageDisplayMode } from "../../shared/lib/usage-display";

describe("UsageDisplayToggle", () => {
  let app: Mounted | null = null;

  beforeEach(() => {
    setUsageDisplayMode("left");
  });

  afterEach(() => {
    app?.unmount();
    app = null;
    vi.restoreAllMocks();
  });

  it("renders L and U toggle buttons with correct initial active state", () => {
    app = mount(<UsageDisplayToggle />);

    const buttons = document.querySelectorAll<HTMLButtonElement>(".provider-window-toggle button");
    expect(buttons.length).toBe(2);

    const [leftBtn, usedBtn] = Array.from(buttons);
    expect(leftBtn.textContent?.trim()).toBe("L");
    expect(usedBtn.textContent?.trim()).toBe("U");

    expect(leftBtn.classList.contains("active")).toBe(true);
    expect(leftBtn.getAttribute("aria-pressed")).toBe("true");
    expect(usedBtn.classList.contains("active")).toBe(false);
    expect(usedBtn.getAttribute("aria-pressed")).toBe("false");
  });

  it("switches to U when clicked and updates active class", () => {
    app = mount(<UsageDisplayToggle />);

    const buttons = document.querySelectorAll<HTMLButtonElement>(".provider-window-toggle button");
    const [leftBtn, usedBtn] = Array.from(buttons);

    click(usedBtn);
    expect(getUsageDisplayMode()).toBe("used");
    expect(usedBtn.classList.contains("active")).toBe(true);
    expect(usedBtn.getAttribute("aria-pressed")).toBe("true");
    expect(leftBtn.classList.contains("active")).toBe(false);
    expect(leftBtn.getAttribute("aria-pressed")).toBe("false");

    click(leftBtn);
    expect(getUsageDisplayMode()).toBe("left");
    expect(leftBtn.classList.contains("active")).toBe(true);
    expect(leftBtn.getAttribute("aria-pressed")).toBe("true");
    expect(usedBtn.classList.contains("active")).toBe(false);
    expect(usedBtn.getAttribute("aria-pressed")).toBe("false");
  });

  it("renders % Left and % Used when labels is 'words'", () => {
    app = mount(<UsageDisplayToggle labels="words" />);

    const buttons = document.querySelectorAll<HTMLButtonElement>("button");
    expect(Array.from(buttons).map((b) => b.textContent?.trim())).toEqual(["% Left", "% Used"]);
  });

  it("subtracts the switcher's border width so the highlight aligns with the padding box", () => {
    vi.spyOn(HTMLElement.prototype, "clientLeft", "get").mockReturnValue(1);
    vi.spyOn(HTMLElement.prototype, "clientTop", "get").mockReturnValue(1);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.getAttribute("role") === "group") return new DOMRect(10, 20, 100, 36);
      const label = this.textContent?.trim();
      if (label === "U") return new DOMRect(14, 24, 40, 28);
      if (label === "L") return new DOMRect(56, 24, 40, 28);
      return new DOMRect();
    });
    app = mount(<UsageDisplayToggle />);
    const group = document.querySelector<HTMLElement>("[role=group]")!;
    // Active button is 4px inside root's border box, minus 1px border = 3px inside the padding box.
    expect(group.style.getPropertyValue("--segment-x")).toBe("45px");
    expect(group.style.getPropertyValue("--segment-y")).toBe("3px");
  });

  it("does not arm transitions while hidden and disarms when collapsed to zero size", async () => {
    let resizeCallback: ResizeObserverCallback | null = null;
    const OriginalResizeObserver = globalThis.ResizeObserver;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(cb: ResizeObserverCallback) {
          resizeCallback = cb;
        }
        observe() {}
        disconnect() {}
        unobserve() {}
      },
    );
    let visible = false;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (!visible) return new DOMRect(0, 0, 0, 0);
      if (this.getAttribute("role") === "group") return new DOMRect(0, 0, 100, 30);
      return new DOMRect(46, 3, 40, 26);
    });
    const rafQueue: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      rafQueue.push(cb);
      return rafQueue.length;
    });
    const flushRaf = () => {
      const pending = rafQueue.splice(0, rafQueue.length);
      for (const cb of pending) cb(16);
    };

    try {
      app = mount(<UsageDisplayToggle />);
      const group = document.querySelector<HTMLElement>("[role=group]")!;
      flushRaf();
      expect(group.dataset.segmentReady).toBeUndefined();
      expect(group.style.getPropertyValue("--segment-w")).toBe("");

      // Revealing the page places the pill immediately with transitions still disabled.
      visible = true;
      act(() => {
        resizeCallback?.([], {} as ResizeObserver);
      });
      expect(group.style.getPropertyValue("--segment-x")).toBe("46px");
      expect(group.style.getPropertyValue("--segment-w")).toBe("40px");
      expect(group.dataset.segmentReady).toBeUndefined();

      // After the snapped frame paints (two animation frames), transitions arm.
      flushRaf();
      expect(group.dataset.segmentReady).toBeUndefined();
      flushRaf();
      expect(group.dataset.segmentReady).toBe("true");

      // Leaving the page hides it to 0x0 and disarms transitions again without zeroing --segment-*.
      visible = false;
      act(() => {
        resizeCallback?.([], {} as ResizeObserver);
      });
      expect(group.dataset.segmentReady).toBeUndefined();
      expect(group.style.getPropertyValue("--segment-w")).toBe("40px");
    } finally {
      vi.stubGlobal("ResizeObserver", OriginalResizeObserver);
    }
  });
});

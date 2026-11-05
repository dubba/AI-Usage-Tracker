// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clampSidebarWidth,
  DEFAULT_DESKTOP_SIDEBAR_WIDTH,
  DEFAULT_MOBILE_SIDEBAR_WIDTH,
  defaultSidebarWidth,
  maxSidebarWidth,
  measureMeterFitWidth,
  measureNavAlignedWidth,
  MAX_SIDEBAR_WIDTH,
  sidebarFitWidth,
  sidebarToggleStacks,
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

  it("leaves the measured room for the account cards when that is more than the fixed floor", () => {
    expect(maxSidebarWidth({ overlay: false, viewportWidth: 1280, shellWidth: 1200, min: 240, mainMin: 860 })).toBe(340);
    expect(maxSidebarWidth({ overlay: false, viewportWidth: 1280, shellWidth: 1200, min: 240, mainMin: 300 })).toBe(680);
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

describe("sidebarFitWidth", () => {
  it("uses the wider of the sync line and the L / U row", () => {
    expect(sidebarFitWidth(360, 305)).toBe(360);
    expect(sidebarFitWidth(280, 305)).toBe(305);
    expect(sidebarFitWidth(360, null)).toBe(360);
    expect(sidebarFitWidth(null, 305)).toBe(305);
    expect(sidebarFitWidth(null, null)).toBeNull();
  });
});

describe("sidebarToggleStacks", () => {
  it("keeps the L / U toggle on the shared line at exactly the fit width", () => {
    expect(sidebarToggleStacks(286, 286)).toBe(false);
    expect(sidebarToggleStacks(285, 286)).toBe(true);
    expect(sidebarToggleStacks(286, null)).toBe(false);
  });
});

describe("defaultSidebarWidth", () => {
  it("returns the defaults for the phone overlay and desktop", () => {
    expect(defaultSidebarWidth(true)).toBe(DEFAULT_MOBILE_SIDEBAR_WIDTH);
    expect(defaultSidebarWidth(false)).toBe(DEFAULT_DESKTOP_SIDEBAR_WIDTH);
    expect(DEFAULT_MOBILE_SIDEBAR_WIDTH).toBe(300);
    expect(DEFAULT_DESKTOP_SIDEBAR_WIDTH).toBe(300);
    expect(sidebarToggleStacks(DEFAULT_MOBILE_SIDEBAR_WIDTH, 286)).toBe(false);
  });
});

describe("measureNavAlignedWidth", () => {
  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  function setup(navRight: number | null) {
    const shell = document.createElement("div");
    const sidebar = document.createElement("aside");
    sidebar.style.paddingRight = "12px";
    sidebar.style.borderRightWidth = "1px";
    sidebar.style.borderRightStyle = "solid";
    shell.append(sidebar);
    if (navRight !== null) {
      const nav = document.createElement("nav");
      nav.className = "top-bar-nav";
      vi.spyOn(nav, "getBoundingClientRect").mockReturnValue(new DOMRect(35, 12, navRight - 35, 40));
      shell.append(nav);
    }
    document.body.append(shell);
    vi.spyOn(shell, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 1280, 800));
    return { shell, sidebar };
  }

  it("is the switch's right edge plus what lies between the cards' right edge and the sidebar's", () => {
    const { shell, sidebar } = setup(305);
    // 5px list padding + 12px sidebar padding + 1px border.
    expect(measureNavAlignedWidth(shell, sidebar)).toBe(323);
  });

  it("is null without a top bar, as on the phone overlay", () => {
    const { shell, sidebar } = setup(null);
    expect(measureNavAlignedWidth(shell, sidebar)).toBeNull();
  });
});

describe("measureMeterFitWidth", () => {
  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  /** Rows of meters; each number is one label-and-value pair's natural width. */
  function setup(rows: number[][]) {
    const sidebar = document.createElement("aside");
    const metersEls: HTMLElement[] = [];
    for (const heads of rows) {
      const meters = document.createElement("span");
      meters.className = "sidebar-meters";
      meters.style.columnGap = "12px";
      for (const width of heads) {
        const head = document.createElement("span");
        head.className = "sidebar-meter-head";
        head.dataset.natural = String(width);
        meters.append(head);
      }
      sidebar.append(meters);
      metersEls.push(meters);
    }
    document.body.append(sidebar);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      // The invisible copy `naturalWidth` measures carries the head's natural width.
      if (this.getAttribute("aria-hidden") === "true") return new DOMRect(0, 0, Number(this.dataset.natural), 14);
      if (this === sidebar) return new DOMRect(0, 0, 262, 600);
      if (metersEls.includes(this)) return new DOMRect(0, 0, 146, 40);
      return new DOMRect(0, 0, 0, 0);
    });
    return sidebar;
  }

  it("is what the sidebar spends beside the meters plus the widest row's two pairs and the gap", () => {
    // 262 - 146 = 116 beside the meters; the Grok row needs 95 + 70 + 12; 2px buffer.
    expect(measureMeterFitWidth(setup([[62, 62], [95, 70], [66, 66]]))).toBe(116 + 95 + 70 + 12 + 2);
  });

  it("is null when no row is on screen", () => {
    const sidebar = document.createElement("aside");
    document.body.append(sidebar);
    expect(measureMeterFitWidth(sidebar)).toBeNull();
  });
});

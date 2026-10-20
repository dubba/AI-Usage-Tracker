// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { FALLBACK_MIN_SIDEBAR_WIDTH, measureMinSidebarWidth, measureToggleLineWidth } from "./sidebar-width";

function sidebarWith(buttonsWidth: number | null): HTMLElement {
  const sidebar = document.createElement("aside");
  sidebar.style.cssText =
    "padding-left: 12px; padding-right: 12px; border-left-width: 0px; border-right-width: 1px; border-style: solid";
  if (buttonsWidth !== null) {
    const heading = document.createElement("div");
    heading.className = "provider-sidebar-heading";
    heading.style.cssText =
      "padding-left: 5px; padding-right: 5px; border-left-width: 0px; border-right-width: 0px";
    const buttons = document.createElement("div");
    buttons.className = "provider-sidebar-heading-actions";
    buttons.getBoundingClientRect = () => ({ width: buttonsWidth }) as DOMRect;
    heading.append(buttons);
    sidebar.append(heading);
  }
  document.body.append(sidebar);
  return sidebar;
}

describe("measureMinSidebarWidth", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("stops at the Group button: the button group plus the heading and sidebar padding", () => {
    // 197.4 buttons + 10 heading padding + 24 sidebar padding + 1 border = 232.4, rounded up.
    expect(measureMinSidebarWidth(sidebarWith(197.4))).toBe(233);
  });

  it("falls back when the buttons are missing or have no width yet", () => {
    expect(measureMinSidebarWidth(sidebarWith(null))).toBe(FALLBACK_MIN_SIDEBAR_WIDTH);
    expect(measureMinSidebarWidth(sidebarWith(0))).toBe(FALLBACK_MIN_SIDEBAR_WIDTH);
  });
});

describe("measureToggleLineWidth", () => {
  const originalRect = HTMLElement.prototype.getBoundingClientRect;

  afterEach(() => {
    HTMLElement.prototype.getBoundingClientRect = originalRect;
  });

  /** Buttons are 180px and the L / U toggle is 61px, whatever the sidebar's current width is. */
  function sidebarWithRow(): HTMLElement {
    const sidebar = document.createElement("aside");
    sidebar.style.cssText =
      "padding-left: 12px; padding-right: 12px; border-left-width: 0px; border-right-width: 1px; border-style: solid";
    const heading = document.createElement("div");
    heading.className = "provider-sidebar-heading";
    heading.style.cssText = "padding-left: 5px; padding-right: 5px; column-gap: 8px; border-width: 0";
    const actions = document.createElement("div");
    actions.className = "provider-sidebar-heading-actions";
    const toggle = document.createElement("div");
    toggle.className = "usage-display-toggle";
    heading.append(actions, toggle);
    sidebar.append(heading);
    document.body.append(sidebar);
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      if (this.classList.contains("provider-sidebar-heading-actions")) return { width: 180 } as DOMRect;
      if (this.classList.contains("usage-display-toggle")) return { width: 61 } as DOMRect;
      return { width: 0 } as DOMRect;
    };
    return sidebar;
  }

  it("fits the buttons, the gap, and the L / U toggle on one line", () => {
    // 180 buttons + 8 gap + 61 toggle + 10 heading padding + 24 sidebar padding + 1 border + 2 buffer.
    expect(measureToggleLineWidth(sidebarWithRow())).toBe(286);
  });

  it("returns null without the toggle row", () => {
    const sidebar = document.createElement("aside");
    document.body.append(sidebar);
    expect(measureToggleLineWidth(sidebar)).toBeNull();
  });
});

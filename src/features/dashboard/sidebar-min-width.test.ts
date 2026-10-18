// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { FALLBACK_MIN_SIDEBAR_WIDTH, measureMinSidebarWidth, measureSyncLineFitWidth } from "./sidebar-width";

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

describe("measureSyncLineFitWidth", () => {
  const originalRect = HTMLElement.prototype.getBoundingClientRect;

  afterEach(() => {
    HTMLElement.prototype.getBoundingClientRect = originalRect;
  });

  function sidebarWithStatus(withDetail: boolean): HTMLElement {
    const sidebar = document.createElement("aside");
    sidebar.style.cssText =
      "padding-left: 12px; padding-right: 12px; border-left-width: 0px; border-right-width: 1px; border-style: solid";
    const status = document.createElement("div");
    status.className = "sidebar-sync-status";
    status.innerHTML =
      '<span class="sidebar-sync-status-words">Accounts synced 2m ago</span>' +
      (withDetail ? '<span class="sidebar-sync-status-detail">2 accounts out of date</span>' : "");
    sidebar.append(status);
    document.body.append(sidebar);
    // The unwrapped row is 285px wide; the out-of-date note, if counted, would make it 400px.
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      const isStatus = this.classList.contains("sidebar-sync-status");
      const width = isStatus ? (this.querySelector(".sidebar-sync-status-detail") ? 400 : 285) : 0;
      return { width } as DOMRect;
    };
    return sidebar;
  }

  it("fits the whole sync line plus the sidebar padding, ignoring the wrapping note", () => {
    // 285 row + 24 padding + 1 border + 2 buffer.
    expect(measureSyncLineFitWidth(sidebarWithStatus(true))).toBe(312);
    expect(measureSyncLineFitWidth(sidebarWithStatus(false))).toBe(312);
  });

  it("returns null without a sync line", () => {
    const sidebar = document.createElement("aside");
    document.body.append(sidebar);
    expect(measureSyncLineFitWidth(sidebar)).toBeNull();
  });
});

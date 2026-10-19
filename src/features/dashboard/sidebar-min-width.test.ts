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

  /**
   * A sidebar whose sync row reads `liveLabel`. The stubbed row is as wide as its text:
   * 100px for "Not synced yet", 285px for "Accounts synced 2m ago", 295px for "...12h ago",
   * and 400px more if the out-of-date note is still in it.
   */
  function sidebarWithStatus(liveLabel: string, withDetail = false): HTMLElement {
    const sidebar = document.createElement("aside");
    sidebar.style.cssText =
      "padding-left: 12px; padding-right: 12px; border-left-width: 0px; border-right-width: 1px; border-style: solid";
    const status = document.createElement("div");
    status.className = "sidebar-sync-status";
    const label = document.createElement("span");
    label.className = "sidebar-sync-status-label";
    label.textContent = liveLabel;
    status.append(label);
    if (withDetail) {
      const detail = document.createElement("span");
      detail.className = "sidebar-sync-status-detail";
      detail.textContent = "2 accounts out of date";
      status.append(detail);
    }
    sidebar.append(status);
    document.body.append(sidebar);
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      if (!this.classList.contains("sidebar-sync-status")) return { width: 0 } as DOMRect;
      const text = this.textContent ?? "";
      const base = text.includes("12h ago") ? 295 : text.includes("2m ago") ? 285 : 100;
      return { width: base + (text.includes("out of date") ? 400 : 0) } as DOMRect;
    };
    return sidebar;
  }

  it("fits the whole sample sync line plus the sidebar padding", () => {
    // 285 row + 24 padding + 1 border + 2 buffer.
    expect(measureSyncLineFitWidth(sidebarWithStatus("Accounts synced 2m ago"))).toBe(312);
  });

  it("is sized for the sample label even while the live label is shorter", () => {
    expect(measureSyncLineFitWidth(sidebarWithStatus("Not synced yet"))).toBe(312);
  });

  it("follows a live label that is longer than the sample", () => {
    expect(measureSyncLineFitWidth(sidebarWithStatus("Accounts synced 12h ago"))).toBe(322);
  });

  it("ignores the wrapping out-of-date note", () => {
    expect(measureSyncLineFitWidth(sidebarWithStatus("Accounts synced 2m ago", true))).toBe(312);
  });

  it("returns null without a sync line", () => {
    const sidebar = document.createElement("aside");
    document.body.append(sidebar);
    expect(measureSyncLineFitWidth(sidebar)).toBeNull();
  });
});

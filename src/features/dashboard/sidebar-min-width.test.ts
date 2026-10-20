// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { FALLBACK_MIN_SIDEBAR_WIDTH, measureMinSidebarWidth, measureSyncLineFitWidth, measureToggleLineWidth } from "./sidebar-width";

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

describe("measureSyncLineFitWidth", () => {
  const originalRect = HTMLElement.prototype.getBoundingClientRect;

  afterEach(() => {
    HTMLElement.prototype.getBoundingClientRect = originalRect;
  });

  /**
   * The stubbed row is 100px for "Not synced yet", 320px once it reads "just now",
   * 340px for "12h ago", and 400px more while the out-of-date note is still in it.
   */
  function sidebarWithStatus(liveLabel: string, withDetail = false): HTMLElement {
    const sidebar = document.createElement("aside");
    sidebar.style.cssText =
      "padding-left: 12px; padding-right: 12px; border-left-width: 0px; border-right-width: 1px; border-style: solid";
    const status = document.createElement("div");
    status.className = "sidebar-sync-status";
    const text = document.createElement("div");
    text.className = "sidebar-sync-status-text";
    const label = document.createElement("span");
    label.className = "sidebar-sync-status-label";
    const words = document.createElement("span");
    words.className = "sidebar-sync-status-words";
    const title = document.createElement("span");
    title.className = "sidebar-sync-status-title";
    const elapsedText = liveLabel.startsWith("Accounts synced ") ? liveLabel.slice("Accounts synced ".length) : null;
    title.textContent = elapsedText === null ? liveLabel : "Accounts synced";
    words.append(title);
    if (elapsedText !== null) {
      words.append(" ");
      const elapsed = document.createElement("span");
      elapsed.className = "sidebar-sync-status-elapsed";
      elapsed.textContent = elapsedText;
      words.append(elapsed);
    }
    label.append(words);
    text.append(label);
    if (withDetail) {
      const detail = document.createElement("span");
      detail.className = "sidebar-sync-status-detail";
      detail.textContent = "2 accounts out of date";
      text.append(detail);
    }
    status.append(text);
    sidebar.append(status);
    document.body.append(sidebar);
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      if (!this.classList.contains("sidebar-sync-status")) return { width: 0 } as DOMRect;
      const content = this.textContent ?? "";
      const base = content.includes("12h ago") ? 340 : content.includes("just now") ? 320 : 100;
      return { width: base + (content.includes("out of date") ? 400 : 0) } as DOMRect;
    };
    return sidebar;
  }

  it("fits Accounts synced just now plus the sidebar padding", () => {
    // 320 row + 24 padding + 1 border + 2 buffer.
    expect(measureSyncLineFitWidth(sidebarWithStatus("Accounts synced just now"))).toBe(347);
  });

  it("is sized for just now even while the live label is shorter", () => {
    expect(measureSyncLineFitWidth(sidebarWithStatus("Not synced yet"))).toBe(347);
  });

  it("follows a live label that is longer than just now", () => {
    expect(measureSyncLineFitWidth(sidebarWithStatus("Accounts synced 12h ago"))).toBe(367);
  });

  it("ignores the wrapping out-of-date note", () => {
    expect(measureSyncLineFitWidth(sidebarWithStatus("Accounts synced just now", true))).toBe(347);
  });

  it("returns null without a sync line", () => {
    const sidebar = document.createElement("aside");
    document.body.append(sidebar);
    expect(measureSyncLineFitWidth(sidebar)).toBeNull();
  });
});

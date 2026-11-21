// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, type Mounted } from "../../test-utils/react";
import { TooltipLayer } from "./TooltipLayer";
import { computeTooltipPosition, getTooltipPlacement } from "./tooltip-position";

function TestHarness() {
  return (
    <div className="app-shell">
      <div className="isolated-chart" style={{ isolation: "isolate", overflow: "hidden" }}>
        <button type="button" className="generic-btn" data-tooltip="Generic tooltip">
          Generic
        </button>
        <button type="button" className="empty-btn" data-tooltip="">
          Empty
        </button>
        <span className="activity-reset-hit is-right" data-tooltip={"Weekly reset · Nov 10 @ 1:32a\n22% used in previous week"} />
      </div>
      <button type="button" className="sidebar-settings-btn" data-tooltip="Settings">
        Settings
      </button>
      <button type="button" className="mobile-sidebar-toggle-btn" data-tooltip="Toggle menu">
        Toggle
      </button>
      <button type="button" className="mobile-sidebar-close-btn" data-tooltip="Close menu">
        Close
      </button>
      <div className="outside-area">Outside</div>
      <TooltipLayer />
    </div>
  );
}

describe("computeTooltipPosition", () => {
  const viewport = { width: 390, height: 844, safeTop: 0, safeBottom: 0, safeLeft: 0, safeRight: 0 };

  it("centers below the trigger by default and clamps inside the horizontal viewport bounds", () => {
    const nearRight = computeTooltipPosition(
      { left: 360, right: 384, top: 100, bottom: 130, width: 24, height: 30 },
      { width: 200, height: 32 },
      viewport,
      { placement: "bottom", align: "center", offset: 8 },
    );
    expect(nearRight.top).toBe(138);
    expect(nearRight.left).toBe(390 - 8 - 200);

    const nearLeft = computeTooltipPosition(
      { left: 4, right: 24, top: 100, bottom: 130, width: 20, height: 30 },
      { width: 200, height: 32 },
      viewport,
      { placement: "bottom", align: "center", offset: 8 },
    );
    expect(nearLeft.left).toBe(8);
  });

  it("flips above the trigger when placing below would overflow the bottom of the viewport", () => {
    const pos = computeTooltipPosition(
      { left: 100, right: 160, top: 800, bottom: 830, width: 60, height: 30 },
      { width: 140, height: 40 },
      viewport,
      { placement: "bottom", align: "center", offset: 8 },
    );
    expect(pos.placement).toBe("top");
    expect(pos.top).toBe(800 - 8 - 40);
  });

  it("flips below the trigger when placing above would overflow the top of the viewport", () => {
    const pos = computeTooltipPosition(
      { left: 100, right: 160, top: 12, bottom: 42, width: 60, height: 30 },
      { width: 140, height: 40 },
      viewport,
      { placement: "top", align: "center", offset: 8 },
    );
    expect(pos.placement).toBe("bottom");
    expect(pos.top).toBe(42 + 8);
  });

  it("places right-anchored tooltips to the right and flips left near the right edge", () => {
    const rightPos = computeTooltipPosition(
      { left: 12, right: 24, top: 100, bottom: 140, width: 12, height: 40 },
      { width: 100, height: 24 },
      viewport,
      { placement: "right", align: "center", offset: 10 },
    );
    expect(rightPos).toEqual({ left: 34, top: 108, placement: "right" });

    const flippedLeft = computeTooltipPosition(
      { left: 340, right: 360, top: 100, bottom: 140, width: 20, height: 40 },
      { width: 100, height: 24 },
      viewport,
      { placement: "right", align: "center", offset: 10 },
    );
    expect(flippedLeft).toEqual({ left: 230, top: 108, placement: "left" });
  });

  it("respects an explicit container anchor for start/center/end alignment", () => {
    const container = { left: 20, right: 220, top: 10, bottom: 46, width: 200, height: 36 };
    const trigger = { left: 90, right: 150, top: 13, bottom: 43, width: 60, height: 30 };

    const end = computeTooltipPosition(trigger, { width: 120, height: 24 }, viewport, {
      placement: "bottom",
      align: "end",
      offset: 6,
      inset: 2,
      anchorRect: container,
    });
    expect(end.left).toBe(220 - 2 - 120);
  });

  it("maps top-bar nav, segmented switches, stacked L/U toggles, and mobile header buttons to the right alignments", () => {
    const wrapper = document.createElement("div");
    wrapper.innerHTML = `
      <div class="top-bar-nav">
        <button class="top-bar-nav-item" data-tooltip="Dashboard"></button>
        <button class="top-bar-nav-item" data-tooltip="Usage"></button>
        <button class="top-bar-nav-item" data-tooltip="Settings"></button>
      </div>
      <div class="top-bar-segmented"><button data-tooltip="Left"></button></div>
      <div class="activity-period-switch"><button data-tooltip="7D"></button></div>
      <button class="top-bar-add-account" data-tooltip="Add"></button>
      <div class="dashboard-header-actions"><button class="sidebar-section-button" data-tooltip="Group"></button></div>
      <div class="provider-window-toggle"><button data-tooltip="Left"></button></div>
    `;
    document.body.appendChild(wrapper);
    try {
      const navItems = [...wrapper.querySelectorAll<HTMLElement>(".top-bar-nav-item")];
      expect(getTooltipPlacement(navItems[0]).align).toBe("start");
      expect(getTooltipPlacement(navItems[1]).align).toBe("center");
      expect(getTooltipPlacement(navItems[2]).align).toBe("end");
      expect(getTooltipPlacement(wrapper.querySelector(".top-bar-segmented button")!).align).toBe("end");
      expect(getTooltipPlacement(wrapper.querySelector(".activity-period-switch button")!).align).toBe("end");
      expect(getTooltipPlacement(wrapper.querySelector(".top-bar-add-account")!).align).toBe("end");
      expect(getTooltipPlacement(wrapper.querySelector(".dashboard-header-actions .sidebar-section-button")!).align).toBe("end");

      const toggleBtn = wrapper.querySelector<HTMLElement>(".provider-window-toggle button")!;
      expect(getTooltipPlacement(toggleBtn).align).toBe("end");
      document.documentElement.setAttribute("data-sidebar-toggle-stacked", "");
      expect(getTooltipPlacement(toggleBtn).align).toBe("start");
      document.documentElement.removeAttribute("data-sidebar-toggle-stacked");
    } finally {
      wrapper.remove();
    }
  });
});

describe("TooltipLayer", () => {
  let app: Mounted | null = null;

  afterEach(() => {
    vi.useRealTimers();
    app?.unmount();
    app = null;
  });

  it("renders tooltips directly into document.body outside isolated/clipping containers", () => {
    app = mount(<TestHarness />);
    const resetHit = document.querySelector<HTMLElement>(".activity-reset-hit")!;

    act(() => {
      resetHit.dispatchEvent(new Event("touchstart", { bubbles: true }));
    });

    const tooltip = document.body.querySelector<HTMLElement>(":scope > .app-tooltip");
    expect(tooltip).not.toBeNull();
    expect(tooltip?.getAttribute("role")).toBe("tooltip");
    expect(tooltip?.textContent).toBe("Weekly reset · Nov 10 @ 1:32a\n22% used in previous week");
    expect(tooltip?.closest(".isolated-chart")).toBeNull();
    expect(resetHit.getAttribute("data-tooltip-active")).toBe("true");
  });

  it("shows on mouse pointerover, ignores empty tooltips, and hides on pointerout", () => {
    app = mount(<TestHarness />);
    const btn = document.querySelector<HTMLButtonElement>(".generic-btn")!;
    const empty = document.querySelector<HTMLButtonElement>(".empty-btn")!;

    act(() => {
      btn.dispatchEvent(new MouseEvent("pointerover", { bubbles: true }));
    });
    expect(document.body.querySelector(".app-tooltip")?.textContent).toBe("Generic tooltip");

    act(() => {
      btn.dispatchEvent(new MouseEvent("pointerout", { bubbles: true, relatedTarget: document.body }));
    });
    expect(document.body.querySelector(".app-tooltip")).toBeNull();

    act(() => {
      empty.dispatchEvent(new MouseEvent("pointerover", { bubbles: true }));
    });
    expect(document.body.querySelector(".app-tooltip")).toBeNull();
  });

  it("activates data-tooltip-active on touch and dismisses on outside tap, scroll, or timeout", () => {
    vi.useFakeTimers();
    app = mount(<TestHarness />);
    const btn = document.querySelector<HTMLButtonElement>(".generic-btn")!;
    const outside = document.querySelector<HTMLElement>(".outside-area")!;

    act(() => {
      btn.dispatchEvent(new Event("touchstart", { bubbles: true }));
    });
    expect(btn.getAttribute("data-tooltip-active")).toBe("true");
    expect(document.body.querySelector(".app-tooltip")?.textContent).toBe("Generic tooltip");

    act(() => {
      outside.dispatchEvent(new Event("touchstart", { bubbles: true }));
    });
    expect(btn.getAttribute("data-tooltip-active")).toBeNull();
    expect(document.body.querySelector(".app-tooltip")).toBeNull();

    act(() => {
      btn.dispatchEvent(new Event("touchstart", { bubbles: true }));
    });
    expect(document.body.querySelector(".app-tooltip")).not.toBeNull();

    act(() => {
      vi.advanceTimersByTime(2600);
    });
    expect(document.body.querySelector(".app-tooltip")).toBeNull();
    expect(btn.getAttribute("data-tooltip-active")).toBeNull();

    act(() => {
      btn.dispatchEvent(new Event("touchstart", { bubbles: true }));
    });
    expect(document.body.querySelector(".app-tooltip")).not.toBeNull();

    act(() => {
      window.dispatchEvent(new Event("scroll"));
    });
    expect(document.body.querySelector(".app-tooltip")).toBeNull();
  });

  it("does not activate tooltips on touch for mobile sidebar toggle, close, or settings buttons", () => {
    app = mount(<TestHarness />);
    for (const selector of [".sidebar-settings-btn", ".mobile-sidebar-toggle-btn", ".mobile-sidebar-close-btn"]) {
      const button = document.querySelector<HTMLButtonElement>(selector)!;
      act(() => {
        button.dispatchEvent(new Event("touchstart", { bubbles: true }));
      });
      expect(button.getAttribute("data-tooltip-active")).toBeNull();
      expect(document.body.querySelector(".app-tooltip")).toBeNull();
    }
  });

  it("dismisses an active tooltip when Escape is pressed", () => {
    app = mount(<TestHarness />);
    const btn = document.querySelector<HTMLButtonElement>(".generic-btn")!;

    act(() => {
      btn.dispatchEvent(new MouseEvent("pointerover", { bubbles: true }));
    });
    expect(document.body.querySelector(".app-tooltip")).not.toBeNull();

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(document.body.querySelector(".app-tooltip")).toBeNull();
  });
});

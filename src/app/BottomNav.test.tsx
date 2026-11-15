// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { click, mount, type Mounted } from "../test-utils/react";
import { BottomNav } from "./BottomNav";
import { setBottomNavLabels } from "../shared/lib/bottom-nav-labels";
import type { Section } from "./useSidebarNavigation";

let mounted: Mounted | null = null;
afterEach(() => {
  mounted?.unmount();
  mounted = null;
  setBottomNavLabels("on");
  vi.restoreAllMocks();
});

function render(section: Section, props: { inert?: boolean } = {}) {
  const onSelect = vi.fn();
  mounted = mount(<BottomNav section={section} onSelect={onSelect} {...props} />);
  const nav = mounted.container.querySelector("nav")!;
  return { onSelect, nav, items: [...nav.querySelectorAll<HTMLButtonElement>("button")] };
}

describe("BottomNav", () => {
  it("is the Main navigation, with Dashboard, Usage and Settings in that order", () => {
    const { nav, items } = render("accounts");
    expect(nav.getAttribute("aria-label")).toBe("Main");
    expect(items.map((item) => item.textContent)).toEqual(["Dashboard", "Usage", "Settings"]);
    expect(items.every((item) => item.type === "button" && item.querySelector("svg") !== null)).toBe(true);
  });

  it.each([
    ["accounts", 0],
    ["activity", 1],
    ["settings", 2],
  ] as const)("marks only the %s item as the current page", (section, index) => {
    const { items } = render(section);
    items.forEach((item, position) => {
      expect(item.getAttribute("aria-current")).toBe(position === index ? "page" : null);
      expect(item.classList.contains("is-active")).toBe(position === index);
    });
  });

  it("selects the page of the item tapped, including the one already shown", () => {
    const { items, onSelect } = render("accounts");
    click(items[0]);
    click(items[1]);
    click(items[2]);
    expect(onSelect.mock.calls.map(([section]) => section)).toEqual(["accounts", "activity", "settings"]);
  });

  it("drops the page names when they are turned off, and names each button for screen readers", () => {
    setBottomNavLabels("off");
    const { nav, items } = render("activity");
    expect(nav.classList.contains("is-icon-only")).toBe(true);
    expect(items.map((item) => item.textContent)).toEqual(["", "", ""]);
    expect(items.map((item) => item.getAttribute("aria-label"))).toEqual(["Dashboard", "Usage", "Settings"]);
    expect(items[1].getAttribute("aria-current")).toBe("page");
  });

  it("shows the page names by default, with no separate accessible name", () => {
    const { nav, items } = render("accounts");
    expect(nav.classList.contains("is-icon-only")).toBe(false);
    expect(items.every((item) => !item.hasAttribute("aria-label"))).toBe(true);
  });

  it("takes nothing behind an open sidebar", () => {
    expect(render("activity").nav.hasAttribute("inert")).toBe(false);
    mounted!.unmount();
    expect(render("activity", { inert: true }).nav.hasAttribute("inert")).toBe(true);
  });

  it("snaps the highlight when toggling page labels instead of animating past the resized bar", async () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.tagName === "NAV") {
        return this.classList.contains("is-icon-only")
          ? new DOMRect(0, 0, 210, 54)
          : new DOMRect(0, 0, 294, 62);
      }
      const buttons = [...(this.parentElement?.querySelectorAll("button") ?? [])];
      const index = buttons.indexOf(this as HTMLButtonElement);
      const iconOnly = this.parentElement?.classList.contains("is-icon-only") ?? false;
      const width = iconOnly ? 64 : 92;
      const height = iconOnly ? 40 : 48;
      return new DOMRect(7 + index * (width + 2), 7, width, height);
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

    const { nav, onSelect } = render("settings");
    expect(nav.style.getPropertyValue("--segment-w")).toBe("92px");
    expect(nav.style.getPropertyValue("--segment-h")).toBe("48px");
    expect(nav.style.getPropertyValue("--segment-x")).toBe("195px");
    flushRaf();
    flushRaf();
    expect(nav.dataset.segmentReady).toBe("true");

    // Turning off labels shrinks the bar immediately: the highlight must disarm and snap to the
    // new bounds on that frame, then re-arm transitions once the snapped frame paints.
    await act(async () => {
      setBottomNavLabels("off");
      await Promise.resolve();
    });
    expect(nav.classList.contains("is-icon-only")).toBe(true);
    expect(nav.dataset.segmentReady).toBeUndefined();
    expect(nav.style.getPropertyValue("--segment-w")).toBe("64px");
    expect(nav.style.getPropertyValue("--segment-h")).toBe("40px");
    expect(nav.style.getPropertyValue("--segment-x")).toBe("139px");

    flushRaf();
    expect(nav.dataset.segmentReady).toBeUndefined();
    flushRaf();
    expect(nav.dataset.segmentReady).toBe("true");

    // Switching pages keeps transitions armed so the pill still slides smoothly.
    mounted!.rerender(<BottomNav section="accounts" onSelect={onSelect} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(nav.dataset.segmentReady).toBe("true");
    expect(nav.style.getPropertyValue("--segment-x")).toBe("7px");
  });
});

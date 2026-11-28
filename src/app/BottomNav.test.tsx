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

  it("animates page switches with a compositor FLIP transform and continues smoothly if interrupted", async () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.tagName === "NAV") return new DOMRect(0, 0, 294, 62);
      const buttons = [...(this.parentElement?.querySelectorAll("button") ?? [])];
      const index = buttons.indexOf(this as HTMLButtonElement);
      return new DOMRect(7 + index * 94, 7, 92, 48);
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

    const animations: Array<{
      playState: AnimationPlayState;
      cancel: ReturnType<typeof vi.fn>;
      effect: { getComputedTiming: () => { progress: number | null } };
      keyframes: Keyframe[];
      options: KeyframeAnimationOptions;
    }> = [];
    const animateSpy = vi.spyOn(HTMLElement.prototype, "animate").mockImplementation(
      (keyframes: Keyframe[] | PropertyIndexedKeyframes | null, options?: number | KeyframeAnimationOptions) => {
        const anim = {
          playState: "running" as AnimationPlayState,
          cancel: vi.fn(() => {
            anim.playState = "idle";
          }),
          effect: { getComputedTiming: () => ({ progress: 0.25 }) },
          keyframes: Array.isArray(keyframes) ? keyframes : [],
          options: typeof options === "object" && options ? options : {},
        };
        animations.push(anim);
        return anim as unknown as Animation;
      },
    );

    const { nav, onSelect } = render("accounts");
    flushRaf();
    flushRaf();
    expect(nav.dataset.segmentReady).toBe("true");
    expect(nav.dataset.segmentFlip).toBe("true");

    // Accounts (x=7) -> Settings (x=195): delta is -188px.
    mounted!.rerender(<BottomNav section="settings" onSelect={onSelect} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(animateSpy).toHaveBeenCalledTimes(1);
    expect(animations[0].options.pseudoElement).toBe("::before");
    expect(animations[0].keyframes[0]).toEqual({ transform: "translate3d(-188px, 0px, 0) scale(1, 1)" });

    // Interrupt at 25% progress (visual x = 7 + 188 * 0.25 = 54) toward Usage (x=101): delta is -47px.
    mounted!.rerender(<BottomNav section="activity" onSelect={onSelect} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(animations[0].cancel).toHaveBeenCalledTimes(1);
    expect(animateSpy).toHaveBeenCalledTimes(2);
    expect(animations[1].keyframes[0]).toEqual({ transform: "translate3d(-47px, 0px, 0) scale(1, 1)" });

    // Reduced motion skips the FLIP animation.
    vi.spyOn(window, "matchMedia").mockImplementation(
      (query: string) => ({ matches: query === "(prefers-reduced-motion: reduce)" }) as MediaQueryList,
    );
    mounted!.rerender(<BottomNav section="accounts" onSelect={onSelect} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(animateSpy).toHaveBeenCalledTimes(2);
  });
});

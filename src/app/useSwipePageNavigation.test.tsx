// @vitest-environment happy-dom
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { beginReordering, endReordering, resetReorderingForTests } from "../shared/lib/reorder-activity";
import { mount, type Mounted } from "../test-utils/react";
import { useSwipePageNavigation } from "./useSwipePageNavigation";

function dispatchTouch(
  type: "touchstart" | "touchmove" | "touchend" | "touchcancel",
  target: EventTarget,
  options: {
    touches?: Array<{ identifier?: number; clientX: number; clientY: number }>;
    changedTouches?: Array<{ identifier?: number; clientX: number; clientY: number }>;
  } = {},
) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, {
    touches: options.touches ?? [],
    changedTouches: options.changedTouches ?? options.touches ?? [],
  });
  target.dispatchEvent(event);
}

function swipe(
  target: EventTarget,
  from: { x: number; y: number },
  to: { x: number; y: number },
  mid?: { x: number; y: number },
) {
  dispatchTouch("touchstart", target, { touches: [{ identifier: 1, clientX: from.x, clientY: from.y }] });
  if (mid) {
    dispatchTouch("touchmove", target, { touches: [{ identifier: 1, clientX: mid.x, clientY: mid.y }] });
  }
  dispatchTouch("touchmove", target, { touches: [{ identifier: 1, clientX: to.x, clientY: to.y }] });
  dispatchTouch("touchend", target, {
    touches: [],
    changedTouches: [{ identifier: 1, clientX: to.x, clientY: to.y }],
  });
}

function Harness({
  enabled = true,
  onStepPage,
  children,
}: {
  enabled?: boolean;
  onStepPage: (delta: -1 | 1) => void;
  children?: React.ReactNode;
}) {
  const stageRef = useRef<HTMLElement>(null);
  useSwipePageNavigation(stageRef, enabled, onStepPage);
  return (
    <main ref={stageRef} className="main-stage">
      <div className="page-body">
        <p>Swipe area</p>
        {children}
      </div>
    </main>
  );
}

let mounted: Mounted | null = null;

beforeEach(() => {
  resetReorderingForTests();
});

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  resetReorderingForTests();
});

describe("useSwipePageNavigation", () => {
  it("steps forward (+1) when swiping left and backward (-1) when swiping right", () => {
    const onStepPage = vi.fn();
    mounted = mount(<Harness onStepPage={onStepPage} />);
    const body = mounted.container.querySelector(".page-body")!;

    swipe(body, { x: 260, y: 200 }, { x: 160, y: 205 }, { x: 220, y: 202 });
    expect(onStepPage).toHaveBeenLastCalledWith(1);

    swipe(body, { x: 100, y: 200 }, { x: 210, y: 204 }, { x: 140, y: 202 });
    expect(onStepPage).toHaveBeenLastCalledWith(-1);
    expect(onStepPage).toHaveBeenCalledTimes(2);
  });

  it("does not switch pages when disabled (desktop layout or modal open)", () => {
    const onStepPage = vi.fn();
    mounted = mount(<Harness enabled={false} onStepPage={onStepPage} />);
    const body = mounted.container.querySelector(".page-body")!;

    swipe(body, { x: 260, y: 200 }, { x: 120, y: 200 });
    expect(onStepPage).not.toHaveBeenCalled();
  });

  it("ignores vertical scrolling even if the finger drifts horizontally later", () => {
    const onStepPage = vi.fn();
    mounted = mount(<Harness onStepPage={onStepPage} />);
    const body = mounted.container.querySelector(".page-body")!;

    // Moves vertically first (locked out of horizontal swipe), then drifts horizontally.
    swipe(body, { x: 200, y: 300 }, { x: 110, y: 250 }, { x: 196, y: 270 });
    expect(onStepPage).not.toHaveBeenCalled();
  });

  it("ignores short taps and small movements below the swipe threshold", () => {
    const onStepPage = vi.fn();
    mounted = mount(<Harness onStepPage={onStepPage} />);
    const body = mounted.container.querySelector(".page-body")!;

    swipe(body, { x: 200, y: 200 }, { x: 170, y: 200 });
    expect(onStepPage).not.toHaveBeenCalled();
  });

  it("ignores multi-touch gestures and cancelled touches", () => {
    const onStepPage = vi.fn();
    mounted = mount(<Harness onStepPage={onStepPage} />);
    const body = mounted.container.querySelector(".page-body")!;

    // Multi-touch start
    dispatchTouch("touchstart", body, {
      touches: [
        { identifier: 1, clientX: 250, clientY: 200 },
        { identifier: 2, clientX: 100, clientY: 200 },
      ],
    });
    dispatchTouch("touchend", body, { changedTouches: [{ identifier: 1, clientX: 120, clientY: 200 }] });
    expect(onStepPage).not.toHaveBeenCalled();

    // Cancelled single-finger touch
    dispatchTouch("touchstart", body, { touches: [{ identifier: 1, clientX: 250, clientY: 200 }] });
    dispatchTouch("touchmove", body, { touches: [{ identifier: 1, clientX: 190, clientY: 200 }] });
    dispatchTouch("touchcancel", body);
    dispatchTouch("touchend", body, { changedTouches: [{ identifier: 1, clientX: 120, clientY: 200 }] });
    expect(onStepPage).not.toHaveBeenCalled();
  });

  it("ignores swipes while drag-to-reorder is active or cooling down", () => {
    const onStepPage = vi.fn();
    mounted = mount(<Harness onStepPage={onStepPage} />);
    const body = mounted.container.querySelector(".page-body")!;

    beginReordering();
    swipe(body, { x: 260, y: 200 }, { x: 120, y: 200 });
    expect(onStepPage).not.toHaveBeenCalled();

    endReordering();
    swipe(body, { x: 260, y: 200 }, { x: 120, y: 200 });
    expect(onStepPage).not.toHaveBeenCalled();
  });

  it("ignores swipes on form inputs, open dropdown menus, and horizontally scrollable elements", () => {
    const onStepPage = vi.fn();
    mounted = mount(
      <Harness onStepPage={onStepPage}>
        <input type="text" aria-label="Name" />
        <div className="horizontal-box" style={{ overflowX: "auto" }}>
          <span>Wide content</span>
        </div>
      </Harness>,
    );
    const input = mounted.container.querySelector("input")!;
    swipe(input, { x: 260, y: 200 }, { x: 120, y: 200 });
    expect(onStepPage).not.toHaveBeenCalled();

    const scroller = mounted.container.querySelector<HTMLElement>(".horizontal-box")!;
    Object.defineProperty(scroller, "scrollWidth", { configurable: true, get: () => 500 });
    Object.defineProperty(scroller, "clientWidth", { configurable: true, get: () => 200 });
    swipe(scroller.firstElementChild!, { x: 260, y: 200 }, { x: 120, y: 200 });
    expect(onStepPage).not.toHaveBeenCalled();

    const menu = document.createElement("div");
    menu.className = "mobile-dropdown-menu";
    mounted.container.querySelector(".page-body")!.append(menu);
    swipe(mounted.container.querySelector("p")!, { x: 260, y: 200 }, { x: 120, y: 200 });
    expect(onStepPage).not.toHaveBeenCalled();
  });
});

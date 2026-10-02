// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, useRef } from "react";
import { mount, type Mounted } from "../../test-utils/react";
import { usePullToRefresh } from "./usePullToRefresh";
import { PullToRefreshIndicator } from "./PullToRefreshIndicator";
import * as reorderActivity from "../../shared/lib/reorder-activity";

function TestPullComponent({ onRefresh }: { onRefresh?: () => void | Promise<void> }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const pullData = usePullToRefresh({
    containerRef,
    scrollRef,
    onRefresh,
  });

  return (
    <div ref={containerRef} className="test-container" style={{ height: "400px", overflow: "hidden" }}>
      <PullToRefreshIndicator data={pullData} />
      <div ref={scrollRef} className="test-scroll" style={{ height: "100%", overflowY: "auto" }}>
        <p>Dashboard Content</p>
      </div>
    </div>
  );
}

describe("usePullToRefresh and PullToRefreshIndicator", () => {
  let app: Mounted | null = null;

  beforeEach(() => {
    Object.defineProperty(window, "innerWidth", { value: 400, writable: true, configurable: true });
    Object.defineProperty(window, "ontouchstart", { value: {}, writable: true, configurable: true });
  });

  afterEach(() => {
    app?.unmount();
    app = null;
    vi.restoreAllMocks();
  });

  function createTouchEvent(type: string, target: Element, clientX: number, clientY: number) {
    const touch = {
      clientX,
      clientY,
      identifier: 0,
      target,
    };
    return new TouchEvent(type, {
      bubbles: true,
      cancelable: true,
      touches: type === "touchend" || type === "touchcancel" ? [] : [touch as unknown as Touch],
      targetTouches: type === "touchend" || type === "touchcancel" ? [] : [touch as unknown as Touch],
      changedTouches: [touch as unknown as Touch],
    });
  }

  it("does not show indicator initially in idle state", () => {
    app = mount(<TestPullComponent onRefresh={vi.fn()} />);
    expect(document.querySelector(".pull-to-refresh-indicator")).toBeNull();
  });

  it("does not engage if scroll element is not at top (scrollTop > 0)", () => {
    app = mount(<TestPullComponent onRefresh={vi.fn()} />);
    const container = document.querySelector(".test-container")!;
    const scrollEl = document.querySelector(".test-scroll")!;
    scrollEl.scrollTop = 50;

    act(() => {
      container.dispatchEvent(createTouchEvent("touchstart", container, 100, 100));
      window.dispatchEvent(createTouchEvent("touchmove", container, 100, 250));
    });

    expect(document.querySelector(".pull-to-refresh-indicator")).toBeNull();
  });

  it("does not engage if reordering is active", () => {
    vi.spyOn(reorderActivity, "isReordering").mockReturnValue(true);
    app = mount(<TestPullComponent onRefresh={vi.fn()} />);
    const container = document.querySelector(".test-container")!;

    act(() => {
      container.dispatchEvent(createTouchEvent("touchstart", container, 100, 100));
      window.dispatchEvent(createTouchEvent("touchmove", container, 100, 250));
    });

    expect(document.querySelector(".pull-to-refresh-indicator")).toBeNull();
  });

  it("shows indicator on downward pull and primes on long pull down", () => {
    app = mount(<TestPullComponent onRefresh={vi.fn()} />);
    const container = document.querySelector(".test-container")!;

    // Partial pull
    act(() => {
      container.dispatchEvent(createTouchEvent("touchstart", container, 100, 100));
      window.dispatchEvent(createTouchEvent("touchmove", container, 100, 160)); // deltaY = 60
    });

    const indicator = document.querySelector(".pull-to-refresh-indicator");
    expect(indicator).not.toBeNull();
    expect(indicator?.classList.contains("is-primed")).toBe(false);

    // Long pull past threshold
    act(() => {
      window.dispatchEvent(createTouchEvent("touchmove", container, 100, 260)); // deltaY = 160
    });

    expect(indicator?.classList.contains("is-primed")).toBe(true);
  });

  it("triggers onRefresh on release when primed and animates through states", async () => {
    vi.useFakeTimers();
    const onRefresh = vi.fn().mockResolvedValue(undefined);
    app = mount(<TestPullComponent onRefresh={onRefresh} />);
    const container = document.querySelector(".test-container")!;

    act(() => {
      container.dispatchEvent(createTouchEvent("touchstart", container, 100, 100));
      window.dispatchEvent(createTouchEvent("touchmove", container, 100, 260)); // primed
      window.dispatchEvent(createTouchEvent("touchend", container, 100, 260));
    });

    expect(onRefresh).toHaveBeenCalledTimes(1);
    const indicator = document.querySelector(".pull-to-refresh-indicator");
    expect(indicator?.classList.contains("is-refreshing")).toBe(true);

    // Fast forward through minimum spin and settling
    await act(async () => {
      vi.advanceTimersByTime(750);
    });

    expect(indicator?.classList.contains("is-settling")).toBe(true);

    await act(async () => {
      vi.advanceTimersByTime(300);
    });

    expect(document.querySelector(".pull-to-refresh-indicator")).toBeNull();
    vi.useRealTimers();
  });

  it("does not trigger onRefresh if released before reaching threshold", async () => {
    vi.useFakeTimers();
    const onRefresh = vi.fn();
    app = mount(<TestPullComponent onRefresh={onRefresh} />);
    const container = document.querySelector(".test-container")!;

    act(() => {
      container.dispatchEvent(createTouchEvent("touchstart", container, 100, 100));
      window.dispatchEvent(createTouchEvent("touchmove", container, 100, 140)); // deltaY = 40 (not primed)
      window.dispatchEvent(createTouchEvent("touchend", container, 100, 140));
    });

    expect(onRefresh).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(250);
    });

    expect(document.querySelector(".pull-to-refresh-indicator")).toBeNull();
    vi.useRealTimers();
  });
});

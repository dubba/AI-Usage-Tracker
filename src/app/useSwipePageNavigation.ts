import { useEffect, useRef, type RefObject } from "react";
import { isReordering } from "../shared/lib/reorder-activity";

const LOCK_SLOP_PX = 12;
const SWIPE_MIN_DISTANCE_PX = 48;
const HORIZONTAL_BIAS = 1.25;

const BLOCKED_TARGET_SELECTOR = [
  "input",
  "textarea",
  "select",
  "[role='slider']",
  "[contenteditable='true']",
  "[role='dialog']",
  "dialog",
  ".mobile-dropdown-menu",
  ".custom-dropdown-menu",
].join(", ");

interface TouchPointLike {
  identifier?: number;
  clientX: number;
  clientY: number;
}

interface SwipeGesture {
  identifier: number | undefined;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  axis: "x" | null;
}

function hasHorizontalScroller(target: Element, boundary: HTMLElement): boolean {
  let current: Element | null = target;
  while (current && current !== boundary) {
    if (current instanceof HTMLElement && current.scrollWidth > current.clientWidth + 1) {
      const overflowX = getComputedStyle(current).overflowX;
      if (overflowX === "auto" || overflowX === "scroll") return true;
    }
    current = current.parentElement;
  }
  return false;
}

function findTouch(list: ArrayLike<TouchPointLike> | undefined, identifier: number | undefined): TouchPointLike | null {
  if (!list || list.length === 0) return null;
  if (identifier === undefined) return list[0] ?? null;
  for (let i = 0; i < list.length; i += 1) {
    if (list[i].identifier === identifier) return list[i];
  }
  return list[0] ?? null;
}

/**
 * Switches between main pages (Dashboard <-> Usage <-> Settings) when the user swipes
 * horizontally inside `stageRef` on mobile/overlay layouts.
 */
export function useSwipePageNavigation(
  stageRef: RefObject<HTMLElement | null>,
  enabled: boolean,
  onStepPage: (delta: -1 | 1) => void,
): void {
  const onStepPageRef = useRef(onStepPage);
  useEffect(() => {
    onStepPageRef.current = onStepPage;
  }, [onStepPage]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || !enabled) return;

    let gesture: SwipeGesture | null = null;

    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1 || isReordering()) {
        gesture = null;
        return;
      }
      if (document.querySelector(".mobile-dropdown-menu, .custom-dropdown-menu")) {
        gesture = null;
        return;
      }
      const target = event.target instanceof Element ? event.target : null;
      if (!target || target.closest(BLOCKED_TARGET_SELECTOR) || hasHorizontalScroller(target, stage)) {
        gesture = null;
        return;
      }
      const touch = event.touches[0];
      if (!touch) {
        gesture = null;
        return;
      }
      gesture = {
        identifier: touch.identifier,
        startX: touch.clientX,
        startY: touch.clientY,
        lastX: touch.clientX,
        lastY: touch.clientY,
        axis: null,
      };
    };

    const onTouchMove = (event: TouchEvent) => {
      if (!gesture) return;
      if (event.touches.length !== 1 || isReordering()) {
        gesture = null;
        return;
      }
      const touch = findTouch(event.touches, gesture.identifier);
      if (!touch) {
        gesture = null;
        return;
      }
      gesture.lastX = touch.clientX;
      gesture.lastY = touch.clientY;
      const absX = Math.abs(touch.clientX - gesture.startX);
      const absY = Math.abs(touch.clientY - gesture.startY);
      if (gesture.axis === null && Math.max(absX, absY) >= LOCK_SLOP_PX) {
        if (absX > absY * HORIZONTAL_BIAS) {
          gesture.axis = "x";
        } else {
          // Vertical or diagonal scroll intent: abandon swipe so scrolling never flips pages.
          gesture = null;
        }
      }
    };

    const onTouchEnd = (event: TouchEvent) => {
      const current = gesture;
      gesture = null;
      if (!current || isReordering()) return;
      if (event.touches && event.touches.length > 0) return;

      const touch = findTouch(event.changedTouches, current.identifier);
      const endX = touch ? touch.clientX : current.lastX;
      const endY = touch ? touch.clientY : current.lastY;
      const dx = endX - current.startX;
      const dy = endY - current.startY;
      if (Math.abs(dx) < SWIPE_MIN_DISTANCE_PX || Math.abs(dx) <= Math.abs(dy) * HORIZONTAL_BIAS) {
        return;
      }
      // Swiping left (negative dx) moves forward (Dashboard -> Usage -> Settings); right moves back.
      onStepPageRef.current(dx < 0 ? 1 : -1);
    };

    const onTouchCancel = () => {
      gesture = null;
    };

    stage.addEventListener("touchstart", onTouchStart, { passive: true });
    stage.addEventListener("touchmove", onTouchMove, { passive: true });
    stage.addEventListener("touchend", onTouchEnd, { passive: true });
    stage.addEventListener("touchcancel", onTouchCancel, { passive: true });
    return () => {
      stage.removeEventListener("touchstart", onTouchStart);
      stage.removeEventListener("touchmove", onTouchMove);
      stage.removeEventListener("touchend", onTouchEnd);
      stage.removeEventListener("touchcancel", onTouchCancel);
    };
  }, [stageRef, enabled]);
}

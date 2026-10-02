import { useEffect, useRef, useState, type RefObject } from "react";
import { isReordering } from "../../shared/lib/reorder-activity";

export type PullToRefreshState = "idle" | "pulling" | "refreshing" | "settling";

export interface PullToRefreshData {
  state: PullToRefreshState;
  distance: number;
  progress: number;
  isPrimed: boolean;
}

interface UsePullToRefreshOptions {
  containerRef: RefObject<HTMLElement | null>;
  scrollRef: RefObject<HTMLElement | null>;
  onRefresh?: () => void | Promise<void>;
  disabled?: boolean;
}

/** Threshold in pixels of finger movement required to prime the refresh (emulating Chrome's long pull). */
const PULL_TRIGGER_DISTANCE = 120;
/** Maximum visual travel distance for the floating indicator badge. */
const MAX_INDICATOR_TRAVEL = 64;
/** Resting position during refresh in pixels. */
const REFRESH_RESTING_DISTANCE = 52;
/** Minimum duration in ms to display the refreshing state so user sees feedback. */
const MIN_REFRESH_SPIN_MS = 700;

export function usePullToRefresh({
  containerRef,
  scrollRef,
  onRefresh,
  disabled = false,
}: UsePullToRefreshOptions): PullToRefreshData {
  const [pullData, setPullData] = useState<PullToRefreshData>({
    state: "idle",
    distance: 0,
    progress: 0,
    isPrimed: false,
  });

  const stateRef = useRef(pullData.state);
  stateRef.current = pullData.state;

  const touchStartYRef = useRef(0);
  const touchStartXRef = useRef(0);
  const isPullingRef = useRef(false);
  const hasTriggeredHapticRef = useRef(false);
  const onRefreshRef = useRef(onRefresh);
  onRefreshRef.current = onRefresh;

  useEffect(() => {
    const container = containerRef.current;
    if (!container || disabled) return;

    const isMobile = () => {
      if (typeof window === "undefined") return false;
      return window.innerWidth <= 860 || "ontouchstart" in window || navigator.maxTouchPoints > 0;
    };

    const handleTouchStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      if (!isMobile()) return;
      if (stateRef.current === "refreshing" || stateRef.current === "settling") return;
      if (isReordering()) return;

      const scrollEl = scrollRef.current;
      // Only activate when the scrollable content is scrolled all the way to the top
      if (scrollEl && scrollEl.scrollTop > 0) return;

      const touch = e.touches[0];
      touchStartYRef.current = touch.clientY;
      touchStartXRef.current = touch.clientX;
      isPullingRef.current = false;
      hasTriggeredHapticRef.current = false;
    };

    const handleTouchMove = (e: TouchEvent) => {
      if (touchStartYRef.current === 0) return;
      if (isReordering()) {
        resetPull();
        return;
      }

      const scrollEl = scrollRef.current;
      if (scrollEl && scrollEl.scrollTop > 0) {
        if (isPullingRef.current) resetPull();
        return;
      }

      const touch = e.touches[0];
      const deltaY = touch.clientY - touchStartYRef.current;
      const deltaX = touch.clientX - touchStartXRef.current;

      // Ignore upward scroll or predominantly horizontal swipes
      if (!isPullingRef.current) {
        if (deltaY <= 0) return;
        if (Math.abs(deltaX) > deltaY) return;
        // Require at least 8px downward movement to begin pull gesture
        if (deltaY > 8) {
          isPullingRef.current = true;
        }
      }

      if (isPullingRef.current) {
        if (e.cancelable) {
          e.preventDefault();
        }

        const rawPull = Math.max(0, deltaY - 8);
        const progress = Math.min(1, rawPull / PULL_TRIGGER_DISTANCE);
        const distance = Math.min(MAX_INDICATOR_TRAVEL, (rawPull / PULL_TRIGGER_DISTANCE) * REFRESH_RESTING_DISTANCE);
        const primed = progress >= 1;

        if (primed && !hasTriggeredHapticRef.current) {
          hasTriggeredHapticRef.current = true;
          try {
            navigator.vibrate?.(15);
          } catch {
            // Haptics unavailable on some platforms
          }
        } else if (!primed && hasTriggeredHapticRef.current) {
          hasTriggeredHapticRef.current = false;
        }

        setPullData({
          state: "pulling",
          distance,
          progress,
          isPrimed: primed,
        });
      }
    };

    const handleTouchEnd = () => {
      if (!isPullingRef.current) {
        touchStartYRef.current = 0;
        return;
      }

      const primed = hasTriggeredHapticRef.current;
      isPullingRef.current = false;
      touchStartYRef.current = 0;

      if (primed && onRefreshRef.current) {
        setPullData({
          state: "refreshing",
          distance: REFRESH_RESTING_DISTANCE,
          progress: 1,
          isPrimed: true,
        });

        const refreshPromise = Promise.resolve(onRefreshRef.current());
        const minSpinPromise = new Promise((resolve) => setTimeout(resolve, MIN_REFRESH_SPIN_MS));

        void Promise.allSettled([refreshPromise, minSpinPromise]).then(() => {
          setPullData({
            state: "settling",
            distance: REFRESH_RESTING_DISTANCE,
            progress: 1,
            isPrimed: false,
          });
          setTimeout(() => {
            setPullData({
              state: "idle",
              distance: 0,
              progress: 0,
              isPrimed: false,
            });
          }, 250);
        });
      } else {
        // Not primed: smoothly spring back up offscreen
        setPullData({
          state: "settling",
          distance: 0,
          progress: 0,
          isPrimed: false,
        });
        setTimeout(() => {
          setPullData({
            state: "idle",
            distance: 0,
            progress: 0,
            isPrimed: false,
          });
        }, 200);
      }
    };

    const resetPull = () => {
      touchStartYRef.current = 0;
      isPullingRef.current = false;
      hasTriggeredHapticRef.current = false;
      setPullData({
        state: "idle",
        distance: 0,
        progress: 0,
        isPrimed: false,
      });
    };

    container.addEventListener("touchstart", handleTouchStart, { passive: true });
    window.addEventListener("touchmove", handleTouchMove, { passive: false });
    window.addEventListener("touchend", handleTouchEnd, { passive: true });
    window.addEventListener("touchcancel", handleTouchEnd, { passive: true });

    return () => {
      container.removeEventListener("touchstart", handleTouchStart);
      window.removeEventListener("touchmove", handleTouchMove);
      window.removeEventListener("touchend", handleTouchEnd);
      window.removeEventListener("touchcancel", handleTouchEnd);
    };
  }, [containerRef, scrollRef, disabled]);

  return pullData;
}

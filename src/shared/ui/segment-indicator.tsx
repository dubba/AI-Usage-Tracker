import { useLayoutEffect, type RefObject } from "react";
import "./segment-indicator.css";

interface SegmentRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const SLIDE_DURATION_MS = 280;
const SLIDE_EASING = "cubic-bezier(0.22, 0.8, 0.28, 1)";
const SUBPIXEL_THRESHOLD = 0.5;

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function rectMovedSignificantly(a: SegmentRect | null, b: SegmentRect): boolean {
  if (!a) return true;
  return (
    Math.abs(a.x - b.x) > SUBPIXEL_THRESHOLD ||
    Math.abs(a.y - b.y) > SUBPIXEL_THRESHOLD ||
    Math.abs(a.w - b.w) > SUBPIXEL_THRESHOLD ||
    Math.abs(a.h - b.h) > SUBPIXEL_THRESHOLD
  );
}

/**
 * Slides a segmented control's highlight onto its selected direct child (`.active` or `.is-active`).
 * The first placement is in place before the screen paints; later selections travel on the
 * compositor via a WAAPI FLIP transform on `::before` (with CSS transition fallback) so page
 * switches stay smooth and rest back on the exact layout pixel grid.
 */
export function useSegmentIndicator(rootRef: RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    let armFirstFrame = 0;
    let armSecondFrame = 0;
    let lastActive: HTMLElement | null = null;
    let lastRect: SegmentRect | null = null;
    let fromStart: SegmentRect | null = null;
    let activeAnimation: Animation | null = null;

    const cancelArm = () => {
      cancelAnimationFrame(armFirstFrame);
      cancelAnimationFrame(armSecondFrame);
      armFirstFrame = 0;
      armSecondFrame = 0;
    };

    const stopAnimation = () => {
      activeAnimation?.cancel();
      activeAnimation = null;
      fromStart = null;
    };

    const disarm = () => {
      cancelArm();
      stopAnimation();
      delete root.dataset.segmentReady;
      delete root.dataset.segmentFlip;
    };

    const arm = () => {
      if (root.dataset.segmentReady || armFirstFrame || armSecondFrame) return;
      // Wait past the snapped frame's paint before enabling transitions so initial mount or
      // revealing a hidden page never animates the pill from the top-left corner.
      armFirstFrame = requestAnimationFrame(() => {
        armFirstFrame = 0;
        armSecondFrame = requestAnimationFrame(() => {
          armSecondFrame = 0;
          const active = root.querySelector<HTMLElement>(":scope > .active, :scope > .is-active");
          if (!active) return;
          const box = active.getBoundingClientRect();
          if (box.width > 0 && box.height > 0) {
            root.dataset.segmentReady = "true";
            if (typeof root.animate === "function") {
              root.dataset.segmentFlip = "true";
            }
          }
        });
      });
    };

    const currentVisualRect = (): SegmentRect | null => {
      if (!lastRect) return null;
      if (activeAnimation && activeAnimation.playState === "running" && fromStart) {
        const progress = activeAnimation.effect?.getComputedTiming().progress;
        if (typeof progress === "number" && Number.isFinite(progress)) {
          return {
            x: fromStart.x + (lastRect.x - fromStart.x) * progress,
            y: fromStart.y + (lastRect.y - fromStart.y) * progress,
            w: fromStart.w + (lastRect.w - fromStart.w) * progress,
            h: fromStart.h + (lastRect.h - fromStart.h) * progress,
          };
        }
      }
      return lastRect;
    };

    const place = (snap = false, forceSnap = false) => {
      const active = root.querySelector<HTMLElement>(":scope > .active, :scope > .is-active");
      if (!active) {
        lastActive = null;
        lastRect = null;
        disarm();
        return;
      }
      const rootBox = root.getBoundingClientRect();
      const box = active.getBoundingClientRect();
      if (rootBox.width <= 0 || rootBox.height <= 0 || box.width <= 0 || box.height <= 0) {
        lastActive = active;
        lastRect = null;
        disarm();
        return;
      }
      // `::before` is positioned in `root`'s padding box (inside its border), whereas
      // `getBoundingClientRect()` returns border boxes. Subtract `clientLeft`/`clientTop` so the
      // pill aligns directly with the active option rather than shifting down and right.
      const nextRect: SegmentRect = {
        x: box.left - rootBox.left - root.clientLeft,
        y: box.top - rootBox.top - root.clientTop,
        w: box.width,
        h: box.height,
      };
      const next: Record<string, string> = {
        "--segment-x": `${nextRect.x}px`,
        "--segment-y": `${nextRect.y}px`,
        "--segment-w": `${nextRect.w}px`,
        "--segment-h": `${nextRect.h}px`,
      };

      const shouldSnap = snap && (forceSnap || active === lastActive);
      const canFlip =
        Boolean(root.dataset.segmentReady && root.dataset.segmentFlip) &&
        !shouldSnap &&
        lastRect !== null &&
        active !== lastActive &&
        !prefersReducedMotion();

      const fromRect = canFlip ? currentVisualRect() : null;
      if (canFlip) {
        stopAnimation();
      }

      let changed = false;
      for (const [name, value] of Object.entries(next)) {
        if (root.style.getPropertyValue(name) !== value) {
          root.style.setProperty(name, value);
          changed = true;
        }
      }

      if (canFlip && fromRect) {
        const dx = fromRect.x - nextRect.x;
        const dy = fromRect.y - nextRect.y;
        const sx = nextRect.w > 0 ? fromRect.w / nextRect.w : 1;
        const sy = nextRect.h > 0 ? fromRect.h / nextRect.h : 1;
        if (
          Math.abs(dx) > 0.25 ||
          Math.abs(dy) > 0.25 ||
          Math.abs(sx - 1) > 0.002 ||
          Math.abs(sy - 1) > 0.002
        ) {
          fromStart = fromRect;
          try {
            const anim = root.animate(
              [
                { transform: `translate3d(${dx}px, ${dy}px, 0) scale(${sx}, ${sy})` },
                { transform: "translate3d(0px, 0px, 0px) scale(1, 1)" },
              ],
              {
                duration: SLIDE_DURATION_MS,
                easing: SLIDE_EASING,
                pseudoElement: "::before",
              },
            );
            activeAnimation = anim;
            // Calling `cancel()` rejects `anim.finished` with AbortError per the WAAPI spec;
            // consume it so interrupting a slide or unmounting never triggers an unhandled rejection.
            anim.finished?.catch(() => {});
            anim.onfinish = () => {
              if (activeAnimation === anim) {
                activeAnimation = null;
                fromStart = null;
              }
            };
            anim.oncancel = () => {
              if (activeAnimation === anim) {
                activeAnimation = null;
                fromStart = null;
              }
            };
          } catch {
            // Engine rejected pseudoElement animation: fall back to CSS layout transitions.
            fromStart = null;
            delete root.dataset.segmentFlip;
          }
        }
      }

      // Keep transitions when switching between options, but snap immediately when the control
      // itself resizes (e.g. toggling BottomNav's labels) so the highlight never lags outside the
      // pill's new bounds. Ignore subpixel ResizeObserver noise while keeping explicit forceSnaps.
      if (shouldSnap && changed && (forceSnap || rectMovedSignificantly(lastRect, nextRect))) {
        disarm();
      }
      lastActive = active;
      lastRect = nextRect;
      arm();
    };

    place();

    const onResize = () => place(true);
    const onMutations: MutationCallback = (records) => {
      const rootChanged = records.some((record) => record.target === root);
      place(true, rootChanged);
    };

    const observed = [...root.children].filter((child): child is HTMLElement => child instanceof HTMLElement);
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(onResize);
    resize?.observe(root);
    for (const child of observed) resize?.observe(child);

    // Class changes are the selection moving (or the root switching layout modes like is-icon-only).
    // Style writes are ignored, so placing does not loop.
    const mutations = new MutationObserver(onMutations);
    mutations.observe(root, { attributes: true, attributeFilter: ["class"], subtree: true });
    window.addEventListener("resize", onResize);

    return () => {
      cancelArm();
      stopAnimation();
      resize?.disconnect();
      mutations.disconnect();
      window.removeEventListener("resize", onResize);
      delete root.dataset.segmentReady;
      delete root.dataset.segmentFlip;
    };
  }, [rootRef]);
}

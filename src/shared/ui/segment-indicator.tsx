import { useLayoutEffect, type RefObject } from "react";
import "./segment-indicator.css";

/**
 * Slides a segmented control's highlight onto its selected direct child (`.active` or `.is-active`).
 * The first placement is in place before the screen paints; later selections travel.
 */
export function useSegmentIndicator(rootRef: RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    let armFirstFrame = 0;
    let armSecondFrame = 0;

    const cancelArm = () => {
      cancelAnimationFrame(armFirstFrame);
      cancelAnimationFrame(armSecondFrame);
      armFirstFrame = 0;
      armSecondFrame = 0;
    };

    const disarm = () => {
      cancelArm();
      delete root.dataset.segmentReady;
    };

    const arm = () => {
      if (root.dataset.segmentReady || armFirstFrame || armSecondFrame) return;
      // Wait past the snapped frame's paint before enabling CSS transitions so initial mount or
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
          }
        });
      });
    };

    const place = () => {
      const active = root.querySelector<HTMLElement>(":scope > .active, :scope > .is-active");
      if (!active) {
        disarm();
        return;
      }
      const rootBox = root.getBoundingClientRect();
      const box = active.getBoundingClientRect();
      if (rootBox.width <= 0 || rootBox.height <= 0 || box.width <= 0 || box.height <= 0) {
        disarm();
        return;
      }
      // `::before` is positioned in `root`'s padding box (inside its border), whereas
      // `getBoundingClientRect()` returns border boxes. Subtract `clientLeft`/`clientTop` so the
      // pill aligns directly with the active option rather than shifting down and right.
      const next: Record<string, string> = {
        "--segment-x": `${box.left - rootBox.left - root.clientLeft}px`,
        "--segment-y": `${box.top - rootBox.top - root.clientTop}px`,
        "--segment-w": `${box.width}px`,
        "--segment-h": `${box.height}px`,
      };
      for (const [name, value] of Object.entries(next)) {
        if (root.style.getPropertyValue(name) !== value) root.style.setProperty(name, value);
      }
      arm();
    };

    place();

    const observed = [...root.children].filter((child): child is HTMLElement => child instanceof HTMLElement);
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(place);
    resize?.observe(root);
    for (const child of observed) resize?.observe(child);

    // Class changes are the selection moving. Style writes are ignored, so placing does not loop.
    const mutations = new MutationObserver(place);
    mutations.observe(root, { attributes: true, attributeFilter: ["class"], subtree: true });
    window.addEventListener("resize", place);

    return () => {
      cancelArm();
      resize?.disconnect();
      mutations.disconnect();
      window.removeEventListener("resize", place);
      delete root.dataset.segmentReady;
    };
  }, [rootRef]);
}

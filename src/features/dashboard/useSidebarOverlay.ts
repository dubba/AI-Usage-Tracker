import { useEffect, useRef, type RefObject } from "react";
import { focusableElements } from "../../shared/hooks/useModalA11y";
import { MOBILE_OVERLAY_QUERY } from "./sidebar-width";
import { useMediaQuery } from "../../shared/hooks/useMediaQuery";

/**
 * Accessibility for the sidebar when it is an off-canvas overlay (narrow screens):
 * - `overlay` says whether the overlay layout is active at all
 * - while it is closed, the caller should mark it `inert` so its buttons are
 *   neither tabbable nor exposed to screen readers
 * - while open: Tab is trapped inside, Escape closes it, focus moves in on open
 *   and returns to whatever opened it on close
 * On wide screens the sidebar is a plain landmark and none of this applies.
 */
export function useSidebarOverlay(ref: RefObject<HTMLElement | null>, open: boolean, onClose: () => void) {
  const overlay = useMediaQuery(MOBILE_OVERLAY_QUERY);
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });

  const active = overlay && open;
  useEffect(() => {
    if (!active) return;
    const container = ref.current;
    if (!container) return;

    const opener = document.activeElement as HTMLElement | null;
    const [first] = focusableElements(container);
    (first ?? container).focus({ preventScroll: true });

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusableElements(container);
      if (!items.length) {
        event.preventDefault();
        return;
      }
      const current = document.activeElement as HTMLElement | null;
      const index = current ? items.indexOf(current) : -1;
      if (index === -1) {
        event.preventDefault();
        items[event.shiftKey ? items.length - 1 : 0].focus({ preventScroll: true });
      } else if (event.shiftKey && index === 0) {
        event.preventDefault();
        items[items.length - 1].focus({ preventScroll: true });
      } else if (!event.shiftKey && index === items.length - 1) {
        event.preventDefault();
        items[0].focus({ preventScroll: true });
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      if (opener && document.contains(opener)) opener.focus({ preventScroll: true });
    };
  }, [active, ref]);

  return { overlay };
}

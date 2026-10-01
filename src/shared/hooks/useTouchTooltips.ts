import { useEffect } from "react";

const TAP_TOOLTIP_MS = 3000;

function isTouchLike(event: Event): boolean {
  if (typeof navigator !== "undefined" && /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)) return true;
  if ("pointerType" in event && (event as PointerEvent).pointerType === "touch") return true;
  if (event.type.startsWith("touch")) return true;
  return window.matchMedia?.("(pointer: coarse)").matches || window.matchMedia?.("(hover: none)").matches || false;
}

/**
 * Tooltips are CSS-only and appear on hover or keyboard focus. Touch has
 * neither, so a tap on a `[data-tooltip]` element shows it for a few seconds
 * via `data-tooltip-active`; tapping anywhere else hides it.
 */
export function useTouchTooltips(): void {
  useEffect(() => {
    let active: HTMLElement | null = null;
    let timer: number | null = null;

    const dismiss = () => {
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
      if (active) {
        active.removeAttribute("data-tooltip-active");
        active.setAttribute("data-tooltip-dismissed", "true");
        active.blur();
        active = null;
      }
    };

    const show = (element: HTMLElement) => {
      if (active && active !== element) dismiss();
      element.removeAttribute("data-tooltip-dismissed");
      element.setAttribute("data-tooltip-active", "true");
      active = element;
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (active === element) dismiss();
      }, TAP_TOOLTIP_MS);
    };

    const onTouch = (event: Event) => {
      if (!isTouchLike(event)) return;
      const target = event.target instanceof Element ? event.target : null;
      const withTooltip = target?.closest<HTMLElement>("[data-tooltip]");
      if (withTooltip) show(withTooltip);
      else dismiss();
    };

    window.addEventListener("pointerdown", onTouch, { capture: true, passive: true });
    window.addEventListener("touchstart", onTouch, { capture: true, passive: true });
    return () => {
      window.removeEventListener("pointerdown", onTouch, true);
      window.removeEventListener("touchstart", onTouch, true);
      dismiss();
    };
  }, []);
}

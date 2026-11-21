import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { computeTooltipPosition, getTooltipPlacement } from "./tooltip-position";
import "./tooltip-layer.css";

const TAP_TOOLTIP_HOLD_MS = 2300;
const TAP_TOOLTIP_FADE_MS = 200;
const TOUCH_MOUSE_GUARD_MS = 700;

const MOBILE_SUPPRESSED_SELECTOR =
  ".sidebar-settings-btn, .mobile-sidebar-toggle-btn, .mobile-sidebar-close-btn";

type TooltipMode = "hover" | "focus" | "touch";

interface ActiveTooltip {
  trigger: HTMLElement;
  text: string;
  mode: TooltipMode;
  fading: boolean;
}

function readTooltipText(element: HTMLElement): string | null {
  const text = element.getAttribute("data-tooltip");
  if (!text || text === "false" || text === "undefined") return null;
  return text;
}

function isMobileOrTouchViewport(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return (
    window.matchMedia("(max-width: 860px)").matches ||
    window.matchMedia("(hover: none)").matches ||
    window.matchMedia("(pointer: coarse)").matches
  );
}

function isTouchLike(event: Event): boolean {
  if ("pointerType" in event && (event as PointerEvent).pointerType === "touch") return true;
  if (event.type.startsWith("touch")) return true;
  if (typeof navigator !== "undefined" && /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)) return true;
  if (typeof window !== "undefined" && window.matchMedia) {
    return window.matchMedia("(pointer: coarse)").matches || window.matchMedia("(hover: none)").matches;
  }
  return false;
}

function isSuppressedOnMobile(trigger: HTMLElement, touch: boolean): boolean {
  if (!trigger.matches(MOBILE_SUPPRESSED_SELECTOR)) return false;
  return touch || isMobileOrTouchViewport();
}

function isDraggingGrip(trigger: HTMLElement): boolean {
  return Boolean(trigger.closest(".sidebar-resize-handle.dragging"));
}

function matchesFocusVisible(element: Element): boolean {
  try {
    return element.matches(":focus-visible");
  } catch {
    return false;
  }
}

function resolveTriggerFromTarget(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  return target.closest<HTMLElement>("[data-tooltip]");
}

function resolveFocusTrigger(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  if (!matchesFocusVisible(target)) return null;
  if (target.matches(".sidebar-resize-handle")) {
    return target.querySelector<HTMLElement>(".sidebar-resize-grip[data-tooltip]");
  }
  return target.closest<HTMLElement>("[data-tooltip]");
}

function readSafeInsets(): { safeTop: number; safeBottom: number; safeLeft: number; safeRight: number } {
  if (typeof window === "undefined" || !window.getComputedStyle) {
    return { safeTop: 0, safeBottom: 0, safeLeft: 0, safeRight: 0 };
  }
  const style = window.getComputedStyle(document.documentElement);
  const px = (name: string) => {
    const raw = style.getPropertyValue(name).trim();
    const parsed = parseFloat(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  };
  return {
    safeTop: px("--android-safe-top"),
    safeBottom: px("--android-safe-bottom"),
    safeLeft: px("--android-safe-left"),
    safeRight: px("--android-safe-right"),
  };
}

/**
 * Single top-level tooltip overlay rendered into `document.body`.
 *
 * Replaces CSS `[data-tooltip]::after` pseudo-elements so tooltips are never
 * trapped inside ancestor stacking contexts (`isolation: isolate`, `transform`,
 * `opacity`, `z-index`) or clipped by `overflow` containers, and always stay
 * within the viewport.
 */
export function TooltipLayer() {
  const [active, setActive] = useState<ActiveTooltip | null>(null);
  const activeRef = useRef<ActiveTooltip | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const touchTargetRef = useRef<HTMLElement | null>(null);
  const holdTimerRef = useRef<number | null>(null);
  const fadeTimerRef = useRef<number | null>(null);
  const lastTouchAtRef = useRef<number>(0);
  const lastTouchPointerDownAtRef = useRef<number>(0);

  activeRef.current = active;

  useEffect(() => {
    const clearTouchTimers = () => {
      if (holdTimerRef.current !== null) {
        window.clearTimeout(holdTimerRef.current);
        holdTimerRef.current = null;
      }
      if (fadeTimerRef.current !== null) {
        window.clearTimeout(fadeTimerRef.current);
        fadeTimerRef.current = null;
      }
    };

    const clearTouchAttributes = (markDismissed: boolean) => {
      const previous = touchTargetRef.current;
      if (!previous) return;
      previous.removeAttribute("data-tooltip-active");
      if (markDismissed) {
        previous.setAttribute("data-tooltip-dismissed", "true");
        previous.blur();
      }
      touchTargetRef.current = null;
    };

    const dismiss = (markTouchDismissed = false) => {
      clearTouchTimers();
      clearTouchAttributes(markTouchDismissed);
      if (activeRef.current !== null) {
        setActive(null);
      }
    };

    const show = (trigger: HTMLElement, mode: TooltipMode) => {
      const text = readTooltipText(trigger);
      if (!text || isDraggingGrip(trigger) || isSuppressedOnMobile(trigger, mode === "touch")) {
        dismiss(mode === "touch");
        return;
      }
      clearTouchTimers();
      if (mode === "touch") {
        if (touchTargetRef.current && touchTargetRef.current !== trigger) {
          clearTouchAttributes(true);
        }
        trigger.removeAttribute("data-tooltip-dismissed");
        trigger.setAttribute("data-tooltip-active", "true");
        touchTargetRef.current = trigger;
        holdTimerRef.current = window.setTimeout(() => {
          holdTimerRef.current = null;
          setActive((current) => (current && current.trigger === trigger && current.mode === "touch" ? { ...current, fading: true } : current));
          fadeTimerRef.current = window.setTimeout(() => {
            fadeTimerRef.current = null;
            if (activeRef.current?.trigger === trigger && activeRef.current.mode === "touch") {
              dismiss(true);
            }
          }, TAP_TOOLTIP_FADE_MS);
        }, TAP_TOOLTIP_HOLD_MS);
      } else {
        clearTouchAttributes(false);
      }
      setActive({ trigger, text, mode, fading: false });
    };

    const onPointerOver = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      if (Date.now() - lastTouchAtRef.current < TOUCH_MOUSE_GUARD_MS) return;
      const trigger = resolveTriggerFromTarget(event.target);
      if (!trigger) return;
      if (activeRef.current?.trigger === trigger && activeRef.current.mode === "hover") return;
      show(trigger, "hover");
    };

    const onPointerOut = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      const current = activeRef.current;
      if (!current || current.mode !== "hover") return;
      const nextTrigger = resolveTriggerFromTarget(event.relatedTarget);
      if (nextTrigger === current.trigger) return;
      if (nextTrigger) {
        show(nextTrigger, "hover");
      } else {
        dismiss(false);
      }
    };

    const onPointerDown = (event: PointerEvent) => {
      if (isTouchLike(event)) {
        const now = Date.now();
        lastTouchAtRef.current = now;
        lastTouchPointerDownAtRef.current = now;
        const trigger = resolveTriggerFromTarget(event.target);
        if (trigger) {
          show(trigger, "touch");
        } else {
          dismiss(true);
        }
        return;
      }
      // Dismiss hover tooltip on drag starts or mouse press so it never lingers while dragging.
      if (activeRef.current?.mode === "hover") {
        dismiss(false);
      }
    };

    const onTouchStart = (event: TouchEvent) => {
      const now = Date.now();
      // Skip the follow-up touchstart for a tap already handled by pointerdown.
      if (now - lastTouchPointerDownAtRef.current < 50) return;
      lastTouchAtRef.current = now;
      const trigger = resolveTriggerFromTarget(event.target);
      if (trigger) {
        show(trigger, "touch");
      } else {
        dismiss(true);
      }
    };

    const onFocusIn = (event: FocusEvent) => {
      if (Date.now() - lastTouchAtRef.current < TOUCH_MOUSE_GUARD_MS) return;
      const trigger = resolveFocusTrigger(event.target);
      if (trigger) {
        show(trigger, "focus");
      } else if (activeRef.current?.mode === "focus") {
        dismiss(false);
      }
    };

    const onFocusOut = () => {
      if (activeRef.current?.mode === "focus") {
        dismiss(false);
      }
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && activeRef.current) {
        dismiss(activeRef.current.mode === "touch");
      }
    };

    const onDismissEvent = () => {
      if (activeRef.current) {
        dismiss(activeRef.current.mode === "touch");
      }
    };

    window.addEventListener("pointerover", onPointerOver, true);
    window.addEventListener("pointerout", onPointerOut, true);
    window.addEventListener("pointerdown", onPointerDown, { capture: true, passive: true });
    window.addEventListener("touchstart", onTouchStart, { capture: true, passive: true });
    window.addEventListener("focusin", onFocusIn, true);
    window.addEventListener("focusout", onFocusOut, true);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("scroll", onDismissEvent, { capture: true, passive: true });
    window.addEventListener("resize", onDismissEvent);
    window.addEventListener("blur", onDismissEvent);
    document.addEventListener("pointerleave", onDismissEvent);

    return () => {
      window.removeEventListener("pointerover", onPointerOver, true);
      window.removeEventListener("pointerout", onPointerOut, true);
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("touchstart", onTouchStart, true);
      window.removeEventListener("focusin", onFocusIn, true);
      window.removeEventListener("focusout", onFocusOut, true);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("scroll", onDismissEvent, true);
      window.removeEventListener("resize", onDismissEvent);
      window.removeEventListener("blur", onDismissEvent);
      document.removeEventListener("pointerleave", onDismissEvent);
      dismiss(false);
    };
  }, []);

  // Watch the active trigger while visible so dynamic text updates and DOM removals stay in sync.
  useEffect(() => {
    if (!active) return;
    const { trigger } = active;
    if (!trigger.isConnected) {
      setActive(null);
      return;
    }

    const syncTrigger = () => {
      if (!trigger.isConnected || isDraggingGrip(trigger)) {
        setActive(null);
        return;
      }
      const nextText = readTooltipText(trigger);
      if (!nextText) {
        setActive(null);
        return;
      }
      setActive((current) => (current && current.trigger === trigger && current.text !== nextText ? { ...current, text: nextText } : current));
    };

    const observer = new MutationObserver(syncTrigger);
    observer.observe(trigger, { attributes: true, attributeFilter: ["data-tooltip", "class", "hidden"] });
    const resizeHandle = trigger.closest(".sidebar-resize-handle");
    if (resizeHandle) {
      observer.observe(resizeHandle, { attributes: true, attributeFilter: ["class"] });
    }
    if (trigger.parentElement) {
      observer.observe(trigger.parentElement, { childList: true });
    }
    return () => observer.disconnect();
  }, [active]);

  // Measure and place synchronously before paint so the tooltip never flashes at (0, 0).
  useLayoutEffect(() => {
    const el = tooltipRef.current;
    if (!active || !el) return;
    const { trigger } = active;
    if (!trigger.isConnected) {
      setActive(null);
      return;
    }

    const config = getTooltipPlacement(trigger);
    if (config.maxWidth != null) {
      el.style.maxWidth = `min(${config.maxWidth}px, calc(100vw - 16px))`;
    } else {
      el.style.maxWidth = "";
    }

    const triggerRect = trigger.getBoundingClientRect();
    const tooltipRect = el.getBoundingClientRect();
    const viewportWidth = window.visualViewport?.width ?? window.innerWidth;
    const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
    const insets = readSafeInsets();

    const coords = computeTooltipPosition(
      triggerRect,
      { width: tooltipRect.width, height: tooltipRect.height },
      { width: viewportWidth, height: viewportHeight, ...insets },
      config,
    );

    el.style.left = `${coords.left}px`;
    el.style.top = `${coords.top}px`;
  }, [active]);

  if (!active || typeof document === "undefined") return null;

  const compactMobile = active.trigger.matches(".pairing-switch-camera-fab");
  const className = [
    "app-tooltip",
    active.fading ? "" : "is-visible",
    compactMobile ? "is-compact-mobile" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return createPortal(
    <div ref={tooltipRef} className={className} role="tooltip">
      {active.text}
    </div>,
    document.body,
  );
}

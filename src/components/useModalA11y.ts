import { useEffect, useRef, type RefObject } from "react";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(", ");

function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) => element.offsetParent !== null,
  );
}

/**
 * Accessibility behavior shared by every modal dialog in the app:
 * - traps Tab / Shift+Tab within the dialog while it is open
 * - closes on Escape (unless an inner dropdown menu is open; the dropdown
 *   consumes Escape to close itself first)
 * - moves focus into the dialog on open and restores it on close
 * - locks background scrolling by disabling body overflow
 *
 * `onRequestClose` should perform the modal's own close logic (including any
 * busy-state guards), since it is invoked for both Escape and programmatic use.
 */
export function useModalA11y(
  ref: RefObject<HTMLElement | null>,
  open: boolean,
  onRequestClose: () => void,
): void {
  // Keep the latest close callback so busy-state guards inside it are never
  // evaluated against a stale closure.
  const closeRef = useRef(onRequestClose);
  useEffect(() => {
    closeRef.current = onRequestClose;
  });

  useEffect(() => {
    if (!open) return;
    const container = ref.current;
    if (!container) return;

    const previousActiveElement = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    if (!container.contains(document.activeElement)) {
      const candidates = focusableElements(container);
      const initial =
        candidates.find((el) => !el.classList.contains("ui-modal-close")) ??
        candidates[0] ??
        container;
      initial.focus({ preventScroll: true });
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        // An open dropdown inside the dialog closes itself on Escape; the
        // modal must not close in the same key press.
        if (container.querySelector(".custom-dropdown-container.open")) return;
        event.preventDefault();
        event.stopPropagation();
        closeRef.current();
        return;
      }

      if (event.key !== "Tab") return;
      const items = focusableElements(container);
      if (!items.length) {
        event.preventDefault();
        return;
      }
      const active = document.activeElement as HTMLElement | null;
      if (!active || !container.contains(active)) {
        event.preventDefault();
        items[0].focus({ preventScroll: true });
        return;
      }
      const index = items.indexOf(active);
      if (index === -1) {
        event.preventDefault();
        items[0].focus({ preventScroll: true });
        return;
      }
      if (event.shiftKey && index === 0) {
        event.preventDefault();
        items[items.length - 1].focus({ preventScroll: true });
      } else if (!event.shiftKey && index === items.length - 1) {
        event.preventDefault();
        items[0].focus({ preventScroll: true });
      }
    };

    const backdrop = container.closest<HTMLElement>(".modal-backdrop");

    const checkKeyboard = () => {
      const isMobile =
        typeof navigator !== "undefined" &&
        (/Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
          (typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches));

      if (!isMobile) {
        container.classList.remove("keyboard-open");
        backdrop?.classList.remove("keyboard-open");
        document.documentElement.style.removeProperty("--visual-keyboard-height");
        return;
      }

      // 1. Check visualViewport height reduction
      const vv = window.visualViewport;
      let keyboardDetected = false;
      if (vv && window.innerHeight > 0) {
        const heightDiff = window.innerHeight - vv.height;
        if (heightDiff > 100) {
          document.documentElement.style.setProperty("--visual-keyboard-height", `${heightDiff}px`);
          keyboardDetected = true;
        } else {
          document.documentElement.style.removeProperty("--visual-keyboard-height");
        }
      }

      // 2. Check native Android IME class set by MainActivity
      if (document.documentElement.classList.contains("keyboard-active")) {
        keyboardDetected = true;
      }

      if (keyboardDetected) {
        container.classList.add("keyboard-open");
        backdrop?.classList.add("keyboard-open");
      } else {
        container.classList.remove("keyboard-open");
        backdrop?.classList.remove("keyboard-open");
        document.documentElement.style.removeProperty("--visual-keyboard-height");
      }
    };

    const vv = window.visualViewport;
    if (vv) {
      vv.addEventListener("resize", checkKeyboard);
      vv.addEventListener("scroll", checkKeyboard);
    }
    window.addEventListener("resize", checkKeyboard);

    const observer = new MutationObserver(() => {
      checkKeyboard();
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style"],
    });

    const handleFocusOut = () => {
      setTimeout(checkKeyboard, 100);
    };
    window.addEventListener("focusout", handleFocusOut);

    checkKeyboard();

    const handleFocusIn = (event: FocusEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target || !container.contains(target)) return;
      if (target.matches("input:not([type='checkbox']):not([type='radio']):not([type='button']):not([type='submit']):not([type='reset']), textarea, [contenteditable='true']")) {
        checkKeyboard();
        window.setTimeout(() => {
          target.scrollIntoView({ block: "nearest", behavior: "smooth" });
        }, 120);
      }
    };

    container.addEventListener("focusin", handleFocusIn);
    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      if (vv) {
        vv.removeEventListener("resize", checkKeyboard);
        vv.removeEventListener("scroll", checkKeyboard);
      }
      window.removeEventListener("resize", checkKeyboard);
      window.removeEventListener("focusout", handleFocusOut);
      observer.disconnect();
      container.classList.remove("keyboard-open");
      backdrop?.classList.remove("keyboard-open");
      document.documentElement.style.removeProperty("--visual-keyboard-height");
      container.removeEventListener("focusin", handleFocusIn);
      document.removeEventListener("keydown", handleKeyDown, true);
      document.body.style.overflow = previousOverflow;
      if (previousActiveElement?.isConnected) {
        previousActiveElement.focus({ preventScroll: true });
      }
    };
  }, [open, ref]);
}

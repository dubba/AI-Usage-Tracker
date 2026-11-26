import { useEffect, useRef, type RefObject } from "react";
import { watchVirtualKeyboard } from "../lib/virtual-keyboard";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(", ");

export function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) => element.offsetParent !== null,
  );
}

/**
 * Accessibility behavior shared by every modal dialog in the app:
 * - traps Tab / Shift+Tab within the dialog while it is open
 * - closes on Escape (unless an inner dropdown menu is open; the dropdown
 *   consumes Escape to close itself first)
 * - moves focus into the dialog on open (to an element marked `data-autofocus`, else its ×, so
 *   the first Tab reaches its first control) and restores it on close
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
      // Focus starts on the dialog's ×, with no ring, so the first Tab lands on its first control
      // (shown with a ring). A control marked `data-autofocus` (a field to type in) comes first.
      const initial =
        container.querySelector<HTMLElement>("[data-autofocus]:not([disabled])") ??
        container.querySelector<HTMLElement>(":scope > .ui-modal-close:not([disabled])") ??
        candidates[0] ??
        container;
      // A touch screen has no keyboard to need the ring, and the browser draws one for focus
      // moved by script; it showed as a box around the dialog's first button on the phones.
      const touch = window.matchMedia?.("(pointer: coarse)").matches ?? false;
      // The × never shows its ring on opening: it turns red with focus, which looks like a
      // warning. Anything else is the browser's call: a ring when the dialog was opened from the
      // keyboard, none when it was clicked open.
      const onClose = initial.classList.contains("ui-modal-close");
      initial.focus(touch || onClose ? { preventScroll: true, focusVisible: false } : { preventScroll: true });
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

    const keyboard = watchVirtualKeyboard((keyboardOpen) => {
      container.classList.toggle("keyboard-open", keyboardOpen);
      backdrop?.classList.toggle("keyboard-open", keyboardOpen);
    });

    const handleFocusIn = (event: FocusEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target || !container.contains(target)) return;
      if (target.matches("input:not([type='checkbox']):not([type='radio']):not([type='button']):not([type='submit']):not([type='reset']), textarea, [contenteditable='true']")) {
        keyboard.check();
        window.setTimeout(() => {
          target.scrollIntoView({ block: "nearest", behavior: "smooth" });
        }, 120);
      }
    };

    container.addEventListener("focusin", handleFocusIn);
    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      keyboard.dispose();
      container.classList.remove("keyboard-open");
      backdrop?.classList.remove("keyboard-open");
      container.removeEventListener("focusin", handleFocusIn);
      document.removeEventListener("keydown", handleKeyDown, true);
      document.body.style.overflow = previousOverflow;
      if (previousActiveElement?.isConnected) {
        previousActiveElement.focus({ preventScroll: true });
      }
    };
  }, [open, ref]);
}

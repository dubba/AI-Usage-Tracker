import { isMobileDevice } from "./platform";

const KEYBOARD_HEIGHT_VAR = "--visual-keyboard-height";
/** Smaller viewport shrinkage than this is browser chrome (address bar), not a keyboard. */
const MIN_KEYBOARD_HEIGHT_PX = 100;
const FOCUS_IN_RECHECK_MS = 50;
const FOCUS_OUT_RECHECK_MS = 100;

export interface VirtualKeyboardWatcher {
  /** Re-evaluate immediately (e.g. when an input gains focus). */
  check: () => void;
  dispose: () => void;
}

function setKeyboardHeight(heightPx: number | null): void {
  const style = document.documentElement.style;
  if (heightPx === null) {
    // Writes to `style` feed the MutationObserver below, so only touch it when something changes.
    if (style.getPropertyValue(KEYBOARD_HEIGHT_VAR)) style.removeProperty(KEYBOARD_HEIGHT_VAR);
    return;
  }
  const value = `${heightPx}px`;
  if (style.getPropertyValue(KEYBOARD_HEIGHT_VAR) !== value) style.setProperty(KEYBOARD_HEIGHT_VAR, value);
}

/** One evaluation: updates `--visual-keyboard-height` and reports whether a keyboard is showing. */
function detectKeyboard(): boolean {
  if (!isMobileDevice()) {
    setKeyboardHeight(null);
    return false;
  }

  // 1. visualViewport shrinkage (standard across modern mobile browsers/WebViews)
  const vv = window.visualViewport;
  if (vv && window.innerHeight > 0) {
    const heightDiff = window.innerHeight - vv.height;
    if (heightDiff > MIN_KEYBOARD_HEIGHT_PX) {
      setKeyboardHeight(heightDiff);
      return true;
    }
  }
  setKeyboardHeight(null);

  // 2. Native Android IME class set by MainActivity
  return document.documentElement.classList.contains("keyboard-active");
}

/**
 * Tracks the on-screen keyboard on mobile and keeps `--visual-keyboard-height`
 * in sync. `onChange` receives the current state after every re-evaluation.
 */
export function watchVirtualKeyboard(onChange: (open: boolean) => void): VirtualKeyboardWatcher {
  const check = () => onChange(detectKeyboard());

  const vv = window.visualViewport;
  vv?.addEventListener("resize", check);
  vv?.addEventListener("scroll", check);
  window.addEventListener("resize", check);

  const observer = new MutationObserver(check);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style"] });

  const timers = new Set<number>();
  const recheckAfter = (ms: number) => () => {
    const id = window.setTimeout(() => {
      timers.delete(id);
      check();
    }, ms);
    timers.add(id);
  };
  const handleFocusIn = recheckAfter(FOCUS_IN_RECHECK_MS);
  const handleFocusOut = recheckAfter(FOCUS_OUT_RECHECK_MS);
  window.addEventListener("focusin", handleFocusIn);
  window.addEventListener("focusout", handleFocusOut);

  check();

  return {
    check,
    dispose: () => {
      vv?.removeEventListener("resize", check);
      vv?.removeEventListener("scroll", check);
      window.removeEventListener("resize", check);
      window.removeEventListener("focusin", handleFocusIn);
      window.removeEventListener("focusout", handleFocusOut);
      observer.disconnect();
      timers.forEach((id) => window.clearTimeout(id));
      timers.clear();
      setKeyboardHeight(null);
    },
  };
}

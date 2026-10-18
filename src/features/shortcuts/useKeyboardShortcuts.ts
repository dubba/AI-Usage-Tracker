import { useEffect, useRef } from "react";
import { isMacPlatform, matchShortcut, type ShortcutAction } from "./shortcuts";

/**
 * Desktop keyboard shortcuts. Pass `enabled` false on phones. Nothing happens while a dialog
 * (`aria-modal`) is open, so a shortcut never acts behind it. A handled shortcut also stops the
 * browser default, such as Ctrl+R reloading the page.
 */
export function useKeyboardShortcuts(
  enabled: boolean,
  handlers: Record<ShortcutAction, () => void>,
) {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    if (!enabled) return;
    const mac = isMacPlatform();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      const action = matchShortcut(event, mac);
      if (!action) return;
      event.preventDefault();
      handlersRef.current[action]();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enabled]);
}

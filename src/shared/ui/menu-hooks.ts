import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState, type RefObject } from "react";

/**
 * Where a menu opens relative to its trigger. `measure` reads the trigger and the menu and
 * answers; it is called when the menu opens (before paint), and again whenever the window
 * resizes or anything scrolls while the menu is open, plus whenever `changeKey` changes (e.g. the
 * number of options). `isSame` stops a re-measure that found nothing new from re-rendering.
 *
 * Returns the placement and `measureNow`, for measuring just before opening so the first paint
 * is already in the right place.
 */
export function useAnchoredMenuPlacement<Placement>({
  open,
  initial,
  measure,
  isSame,
  changeKey,
}: {
  open: boolean;
  initial: Placement;
  measure: () => Placement;
  isSame: (a: Placement, b: Placement) => boolean;
  changeKey?: unknown;
}): [Placement, () => void] {
  const [placement, setPlacement] = useState<Placement>(initial);
  // The callbacks run from event listeners and inside state updaters, where an effect event
  // cannot be called, so the latest ones are kept in a ref.
  const latest = useRef({ measure, isSame });
  useLayoutEffect(() => {
    latest.current = { measure, isSame };
  });

  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const next = latest.current.measure();
      setPlacement((previous) => (latest.current.isSame(previous, next) ? previous : next));
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    window.visualViewport?.addEventListener("resize", update);
    window.visualViewport?.addEventListener("scroll", update);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      window.visualViewport?.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("scroll", update);
    };
  }, [open, changeKey]);

  return [placement, () => setPlacement(measure())];
}

/**
 * Closes an open menu on a press outside `containerRef` (any of `pressEvents`) and on Escape.
 * `onDismiss` says whether focus should go back to the trigger (it should for Escape, not for a
 * press elsewhere). The latest `onDismiss` is always the one called.
 */
export function useMenuDismissal({
  open,
  containerRef,
  pressEvents,
  onDismiss,
}: {
  open: boolean;
  containerRef: RefObject<HTMLElement | null>;
  pressEvents: readonly string[];
  onDismiss: (restoreFocus: boolean) => void;
}) {
  const dismiss = useEffectEvent(onDismiss);
  const pressKey = pressEvents.join(",");

  useEffect(() => {
    if (!open) return;
    const handlePress = (event: Event) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) dismiss(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        dismiss(true);
      }
    };
    for (const name of pressKey.split(",")) document.addEventListener(name, handlePress);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      for (const name of pressKey.split(",")) document.removeEventListener(name, handlePress);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open, containerRef, pressKey]);
}

/**
 * Keyboard use of a menu whose items take focus: on open, focus the first enabled item; the
 * arrow keys move between enabled items (wrapping), Home and End jump to the ends. Items are the
 * buttons matching `itemSelector` inside `menuRef`.
 */
export function useMenuKeyboardNav({
  open,
  menuRef,
  itemSelector,
}: {
  open: boolean;
  menuRef: RefObject<HTMLElement | null>;
  itemSelector: string;
}) {
  useEffect(() => {
    if (!open) return;
    const enabledItems = () =>
      Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>(itemSelector) ?? []).filter((item) => !item.disabled);
    enabledItems()[0]?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      const items = enabledItems();
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        if (!items.length) return;
        const current = items.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === "ArrowDown" ? current + 1 : current - 1;
        items[(next + items.length) % items.length]?.focus();
        return;
      }
      if (event.key === "Home" || event.key === "End") {
        event.preventDefault();
        items[event.key === "Home" ? 0 : items.length - 1]?.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open, menuRef, itemSelector]);
}

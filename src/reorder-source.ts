/**
 * Hiding and re-showing the card (or sidebar row) that is being dragged.
 *
 * Everything here goes through `element.style`, never the `style` attribute.
 * In the packaged app the Content-Security-Policy carries a nonce for the
 * inline `<style>` block, which makes browsers ignore `'unsafe-inline'`, so
 * `setAttribute("style", ...)` is refused: the attribute text changes but the
 * element keeps its old inline styles. Restoring a dragged card that way left
 * it hidden for good, with a `style` attribute that no longer said so.
 */

type InlineStyle = Pick<CSSStyleDeclaration, "getPropertyValue" | "getPropertyPriority" | "setProperty" | "removeProperty">;
type Styled = { style: InlineStyle };

export type InlineDisplay = { value: string; priority: string };

export function readInlineDisplay(element: Styled): InlineDisplay {
  return {
    value: element.style.getPropertyValue("display"),
    priority: element.style.getPropertyPriority("display"),
  };
}

export function hideInline(element: Styled): void {
  element.style.setProperty("display", "none", "important");
}

/** Puts the inline `display` back to what it was before the drag hid the element. */
export function restoreInlineDisplay(element: Styled, saved: InlineDisplay): void {
  // A saved "none" can only be a leftover from an earlier drag; never restore to hidden.
  if (saved.value && saved.value !== "none") element.style.setProperty("display", saved.value, saved.priority);
  else element.style.removeProperty("display");
}

/** True when the element is hidden by an inline style, read from the live style rather than the attribute. */
export function isHiddenInline(element: Styled): boolean {
  return element.style.getPropertyValue("display") === "none";
}

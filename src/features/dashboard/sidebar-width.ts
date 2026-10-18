export const MOBILE_OVERLAY_QUERY = "(max-width: 860px)";

export const FALLBACK_MIN_SIDEBAR_WIDTH = 240;
export const MAX_SIDEBAR_WIDTH = 720;
export const DEFAULT_DESKTOP_SIDEBAR_WIDTH = 300;
export const DEFAULT_MOBILE_SIDEBAR_WIDTH = 268;
export const KEYBOARD_STEP = 16;

const MIN_MAIN_WIDTH = 520;
const MOBILE_EDGE_GUTTER = 48;

/** Widest the sidebar may be: leave room for the main area, or for a tap target beside the overlay. */
export function maxSidebarWidth(input: { overlay: boolean; viewportWidth: number; shellWidth: number; min: number }): number {
  const room = input.overlay ? input.viewportWidth - MOBILE_EDGE_GUTTER : input.shellWidth - MIN_MAIN_WIDTH;
  return Math.max(input.min, Math.min(MAX_SIDEBAR_WIDTH, room));
}

/** Rounds `next` into [min, max]; if the room is smaller than `min`, `max` wins. */
export function clampSidebarWidth(next: number, min: number, max: number): number {
  const floor = Math.min(min, max);
  return Math.round(Math.min(max, Math.max(floor, next)));
}

export function defaultSidebarWidth(overlay: boolean): number {
  return overlay ? DEFAULT_MOBILE_SIDEBAR_WIDTH : DEFAULT_DESKTOP_SIDEBAR_WIDTH;
}

/** Horizontal padding and border. A max-content child does not include its parent's. */
function horizontalChrome(element: HTMLElement): number {
  const styles = getComputedStyle(element);
  return (
    parseFloat(styles.paddingLeft) +
    parseFloat(styles.paddingRight) +
    parseFloat(styles.borderLeftWidth) +
    parseFloat(styles.borderRightWidth)
  );
}

const MEASURE_BUFFER_PX = 2;

/**
 * Measures `element` at its natural, unwrapped width using an invisible copy, so the
 * sidebar's current width does not limit the result. `prepare` can change the copy first.
 */
function naturalWidth(sidebar: HTMLElement, element: HTMLElement, prepare?: (clone: HTMLElement) => void): number {
  const clone = element.cloneNode(true) as HTMLElement;
  prepare?.(clone);
  clone.setAttribute("aria-hidden", "true");
  Object.assign(clone.style, {
    position: "absolute",
    visibility: "hidden",
    pointerEvents: "none",
    left: "0",
    top: "0",
    width: "max-content",
    minWidth: "max-content",
    maxWidth: "none",
    flexWrap: "nowrap",
    height: "auto",
  });
  sidebar.append(clone);
  const width = clone.getBoundingClientRect().width;
  clone.remove();
  return width;
}

/**
 * Width at which the whole sync line ("Accounts synced 2m ago") fits on one line beside the
 * refresh and settings buttons, for double-clicking the resize handle. The out-of-date note
 * under it is left out: it wraps, and would otherwise widen the sidebar for no reason.
 */
export function measureSyncLineFitWidth(sidebar: HTMLElement): number | null {
  const status = sidebar.querySelector<HTMLElement>(".sidebar-sync-status");
  if (!status) return null;

  const width = naturalWidth(sidebar, status, (clone) => {
    clone.querySelectorAll(".sidebar-sync-status-detail").forEach((part) => part.remove());
  });
  if (!Number.isFinite(width) || width <= 0) return null;
  return Math.ceil(width + horizontalChrome(sidebar) + MEASURE_BUFFER_PX);
}

/**
 * Narrowest the sidebar can be before the + Account and + Group buttons are cut off: the
 * Group button's right edge lines up with the L / U toggle's right edge below it. The sync line at the bottom
 * wraps ("Accounts synced", then "4m ago") instead of limiting the width, and the L / U
 * toggle drops below the buttons.
 */
export function measureMinSidebarWidth(sidebar: HTMLElement): number {
  const heading = sidebar.querySelector<HTMLElement>(".provider-sidebar-heading");
  const buttons = heading?.querySelector<HTMLElement>(".provider-sidebar-heading-actions");
  if (!heading || !buttons) return FALLBACK_MIN_SIDEBAR_WIDTH;

  // The button group never shrinks or wraps, so its own width is the natural width.
  const width = buttons.getBoundingClientRect().width;
  if (!Number.isFinite(width) || width <= 0) return FALLBACK_MIN_SIDEBAR_WIDTH;
  // No safety margin: at the minimum the Group button's right edge lines up with the right
  // edge of the L / U toggle beneath it (and the account cards). The button group cannot wrap,
  // so rounding up to the next pixel is the only slack.
  return Math.ceil(width + horizontalChrome(heading) + horizontalChrome(sidebar));
}

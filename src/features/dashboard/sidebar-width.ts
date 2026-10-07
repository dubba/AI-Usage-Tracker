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

const MEASURE_BUFFER_PX = 2;

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

/**
 * Measures `element` at its natural, unwrapped width using an invisible copy,
 * so the sidebar's current width does not limit the result.
 */
function naturalWidth(sidebar: HTMLElement, element: HTMLElement): number {
  const clone = element.cloneNode(true) as HTMLElement;
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
 * Narrowest the sidebar can be before the sync line at its bottom is cut off:
 * the status text must fit beside the refresh and settings buttons.
 */
export function measureMinSidebarWidth(sidebar: HTMLElement): number {
  const status = sidebar.querySelector<HTMLElement>(".sidebar-sync-status");
  if (!status) return FALLBACK_MIN_SIDEBAR_WIDTH;

  // Measure the whole row at its natural width with the live label, so at the
  // minimum the gap left of the refresh button matches the gap between the
  // buttons. The row is cloned, so how much the live label is clipped is not
  // counted twice.
  const width = naturalWidth(sidebar, status);

  if (!Number.isFinite(width) || width <= 0) return FALLBACK_MIN_SIDEBAR_WIDTH;
  return Math.ceil(width + horizontalChrome(sidebar) + MEASURE_BUFFER_PX);
}

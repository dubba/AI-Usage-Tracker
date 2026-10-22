export const MOBILE_OVERLAY_QUERY = "(max-width: 860px)";

export const FALLBACK_MIN_SIDEBAR_WIDTH = 240;
export const MAX_SIDEBAR_WIDTH = 720;
export const DEFAULT_DESKTOP_SIDEBAR_WIDTH = 300;
export const DEFAULT_MOBILE_SIDEBAR_WIDTH = 300;
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
    whiteSpace: "nowrap",
    height: "auto",
  });
  sidebar.append(clone);
  const width = clone.getBoundingClientRect().width;
  clone.remove();
  return width;
}

/**
 * Sidebar width at which the Account button, the Group button, and the L / U toggle
 * sit on one line, with the toggle against the right edge. This is the first-launch
 * width and what double-clicking the resize handle sets. Any narrower and the toggle
 * drops to its own line (`sidebarToggleStacks`).
 */
export function measureToggleLineWidth(sidebar: HTMLElement): number | null {
  const heading = sidebar.querySelector<HTMLElement>(".provider-sidebar-heading");
  const actions = heading?.querySelector<HTMLElement>(".provider-sidebar-heading-actions");
  const toggle = heading?.querySelector<HTMLElement>(".usage-display-toggle");
  if (!heading || !actions || !toggle) return null;

  const actionsWidth = naturalWidth(sidebar, actions);
  const toggleWidth = naturalWidth(sidebar, toggle);
  if (!Number.isFinite(actionsWidth) || actionsWidth <= 0) return null;
  if (!Number.isFinite(toggleWidth) || toggleWidth <= 0) return null;

  const gap = parseFloat(getComputedStyle(heading).columnGap);
  const width =
    actionsWidth +
    (Number.isFinite(gap) ? gap : 0) +
    toggleWidth +
    horizontalChrome(heading) +
    horizontalChrome(sidebar);
  if (!Number.isFinite(width) || width <= 0) return null;
  return Math.ceil(width + MEASURE_BUFFER_PX);
}

/** The L / U toggle drops under the buttons when the sidebar is narrower than their shared line. */
export function sidebarToggleStacks(width: number, lineWidth: number | null): boolean {
  return lineWidth !== null && width < lineWidth;
}

/** The phrase the sidebar is opened wide enough to show on one line. */
const SAMPLE_SYNC_TITLE = "Accounts synced";
const SAMPLE_SYNC_ELAPSED = "just now";

/** Keeps the sync copy from wrapping inside the measured copy. */
function unwrapSyncRow(clone: HTMLElement) {
  clone.querySelectorAll(".sidebar-sync-status-detail").forEach((part) => part.remove());
  for (const node of clone.querySelectorAll<HTMLElement>(
    ".sidebar-sync-status-text, .sidebar-sync-status-label, .sidebar-sync-status-words",
  )) {
    node.style.flex = "none";
    node.style.minWidth = "max-content";
    node.style.width = "max-content";
    node.style.maxWidth = "none";
    node.style.whiteSpace = "nowrap";
  }
}

/**
 * Sidebar width at which "Accounts synced just now" stays on one line beside the refresh and
 * settings buttons. The live label is measured too, and the wider one wins, so a longer label
 * is not cut off. The out-of-date note is left out: it wraps under the label on purpose.
 */
export function measureSyncLineFitWidth(sidebar: HTMLElement): number | null {
  const status = sidebar.querySelector<HTMLElement>(".sidebar-sync-status");
  if (!status) return null;

  const live = naturalWidth(sidebar, status, unwrapSyncRow);
  const sample = naturalWidth(sidebar, status, (clone) => {
    unwrapSyncRow(clone);
    const title = clone.querySelector<HTMLElement>(".sidebar-sync-status-title");
    const words = clone.querySelector<HTMLElement>(".sidebar-sync-status-words");
    if (title) title.textContent = SAMPLE_SYNC_TITLE;
    const elapsed = clone.querySelector<HTMLElement>(".sidebar-sync-status-elapsed");
    if (elapsed) {
      elapsed.textContent = SAMPLE_SYNC_ELAPSED;
    } else if (words) {
      words.append(" ");
      const span = document.createElement("span");
      span.className = "sidebar-sync-status-elapsed";
      span.textContent = SAMPLE_SYNC_ELAPSED;
      words.append(span);
    }
  });

  const width = Math.max(live, sample);
  if (!Number.isFinite(width) || width <= 0) return null;
  return Math.ceil(width + horizontalChrome(sidebar) + MEASURE_BUFFER_PX);
}

/** The wider of the sync line and the L / U row, so the default fits both on one line. */
export function sidebarFitWidth(syncLine: number | null, toggleLine: number | null): number | null {
  if (syncLine === null) return toggleLine;
  if (toggleLine === null) return syncLine;
  return Math.max(syncLine, toggleLine);
}

/**
 * Narrowest the sidebar can be before the + Account and + Group buttons are cut off: the
 * Group button's right edge lines up with the L / U toggle's right edge below it. The sync line
 * wraps below the default width, and the L / U toggle drops below the buttons.
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

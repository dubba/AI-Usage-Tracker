export const MOBILE_OVERLAY_QUERY = "(max-width: 860px)";

export const FALLBACK_MIN_SIDEBAR_WIDTH = 240;
export const MAX_SIDEBAR_WIDTH = 720;
export const DEFAULT_DESKTOP_SIDEBAR_WIDTH = 300;
export const DEFAULT_MOBILE_SIDEBAR_WIDTH = 300;
export const KEYBOARD_STEP = 16;

const MIN_MAIN_WIDTH = 520;
const MOBILE_EDGE_GUTTER = 48;

/**
 * Widest the sidebar may be: leave room for the main area, or for a tap target beside the overlay.
 * `mainMin` is the main area's measured need (`measureMainMinWidth`) when it is more than the fixed floor.
 */
export function maxSidebarWidth(input: {
  overlay: boolean;
  viewportWidth: number;
  shellWidth: number;
  min: number;
  mainMin?: number | null;
}): number {
  const mainRoom = Math.max(MIN_MAIN_WIDTH, input.mainMin ?? 0);
  const room = input.overlay ? input.viewportWidth - MOBILE_EDGE_GUTTER : input.shellWidth - mainRoom;
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

/** The `.provider-list`'s left and right padding (obsidian-dashboard.css): the cards sit inside it. */
const LIST_SIDE_PADDING_PX = 5;

/**
 * Sidebar width at which the right edge of its cards lines up with the right edge of the top bar's
 * Accounts / Usage / Settings switch. (The left edges already do: the switch starts at the cards'
 * icons, see `--sidebar-icon-inset` in sidebar-list.css.) This is the default width on a wide
 * window, and what double-clicking the resize handle sets. Null when there is no top bar to line
 * up with (the phone overlay) or it has not been laid out yet.
 */
export function measureNavAlignedWidth(shell: HTMLElement, sidebar: HTMLElement): number | null {
  const nav = shell.querySelector<HTMLElement>(".top-bar-nav");
  if (!nav) return null;
  const navRight = nav.getBoundingClientRect().right - shell.getBoundingClientRect().left;
  if (!Number.isFinite(navRight) || navRight <= 0) return null;
  const styles = getComputedStyle(sidebar);
  // From the cards' right edge to the sidebar's: the list's padding, the sidebar's padding and its
  // right border.
  const inset =
    LIST_SIDE_PADDING_PX + (parseFloat(styles.paddingRight) || 0) + (parseFloat(styles.borderRightWidth) || 0);
  return Math.round(navRight + inset);
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

/**
 * Narrowest the main area can be before a desktop account card's header wraps: the name and email,
 * then the chips, updated time and buttons, all on one line. That is the widest header's one-line
 * width plus everything between the header and the main area's edges (card and page padding, the
 * scroll bar). Null when no desktop card is on screen (another page, or the phone layout).
 */
export function measureMainMinWidth(shell: HTMLElement): number | null {
  const main = shell.querySelector<HTMLElement>(".main-stage");
  if (!main) return null;
  let widest: number | null = null;
  for (const header of shell.querySelectorAll<HTMLElement>(".provider-account-card.desktop-card .provider-account-card-header")) {
    const headerWidth = header.getBoundingClientRect().width;
    if (headerWidth <= 0) continue;
    const parts = [...header.children].filter(
      (child): child is HTMLElement => child instanceof HTMLElement && getComputedStyle(child).position !== "absolute",
    );
    if (!parts.length) continue;
    // The header wraps rather than shrinking its parts, so each one is at its full width already,
    // on one line or two. (A hidden copy of a part measures narrower than the part itself.)
    const gap = parseFloat(getComputedStyle(header).columnGap);
    const line =
      parts.reduce((sum, part) => sum + part.getBoundingClientRect().width, 0) +
      (Number.isFinite(gap) ? gap : 0) * (parts.length - 1) +
      horizontalChrome(header);
    const around = main.getBoundingClientRect().width - headerWidth;
    const need = Math.ceil(line + around + MEASURE_BUFFER_PX);
    if (Number.isFinite(need) && (widest === null || need > widest)) widest = need;
  }
  return widest;
}

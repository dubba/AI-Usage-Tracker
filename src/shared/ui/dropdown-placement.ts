/**
 * Shared dropdown and popover placement calculations.
 * Ensures menus flip upward when they cannot fit below their trigger,
 * measuring the actual rendered menu height and taking clipping containers
 * and viewport boundaries into account.
 */

export type DropdownPlacementOptions = {
  /** Gap in pixels between the trigger and the menu (default 8). */
  gap?: number;
  /** Minimum allowable height for the menu before internal scrolling (default 80). */
  minHeight?: number;
  /** Optional maximum ceiling for menu height (e.g. 280 for CustomDropdown). */
  maxHeightCap?: number;
  /** Fallback estimated height when the menu DOM element is not yet rendered or measured. */
  estimatedHeight?: number;
  /**
   * Whether the menu is rendered with `position: fixed`.
   * When true, only the viewport and containers that create a fixed-position containing block
   * clip the element. When false, all scrollable/clipping ancestors are intersected.
   */
  isFixed?: boolean;
};

export type DropdownPlacementResult = {
  /** True if the menu should render upward (above the trigger). */
  openUpward: boolean;
  /** The maximum height (in pixels) the menu should be allowed to occupy. */
  maxHeight: number;
  /** Space available between the bottom of the anchor and the bottom boundary. */
  spaceBelow: number;
  /** Space available between the top boundary and the top of the anchor. */
  spaceAbove: number;
  /** The menu height used for the placement decision (measured or estimated). */
  menuHeight: number;
};

export type FixedContainingBlockBox = {
  /**
   * Viewport x of the containing block's padding-box origin, adjusted for its
   * own scroll offset. Subtract from viewport-space coordinates to get
   * coordinates in the containing block's space.
   */
  left: number;
  /** Viewport y of the containing block's padding-box origin, adjusted for scroll. */
  top: number;
  /** Height of the containing block's padding box (used for `bottom` offsets). */
  height: number;
};

/**
 * Whether an element becomes the containing block for fixed-position
 * descendants. Covers transform, filter, backdrop-filter, perspective,
 * will-change, and layout/paint containment. Each value is guarded so
 * partial CSSOM implementations (which return "" or undefined for
 * unsupported properties) never report a false positive.
 */
export function createsFixedContainingBlock(style: CSSStyleDeclaration): boolean {
  const transform = style.transform;
  if (transform && transform !== "none") return true;
  const filter = style.filter;
  if (filter && filter !== "none") return true;
  const backdropFilter = (style as CSSStyleDeclaration & { backdropFilter?: string }).backdropFilter;
  if (backdropFilter && backdropFilter !== "none") return true;
  const perspective = style.perspective;
  if (perspective && perspective !== "none") return true;
  const willChange = style.willChange;
  if (willChange && /\b(transform|filter|perspective)\b/.test(willChange)) return true;
  const contain = style.contain;
  if (contain && contain !== "none" && contain !== "" && /(paint|layout|strict|content)/.test(contain)) return true;
  return false;
}

/**
 * Finds the nearest ancestor that is the containing block for fixed-position
 * descendants of `element`, and returns its padding-box origin (in the same
 * coordinate space as getBoundingClientRect) adjusted for its scroll offset.
 * Returns a zero box when the viewport itself is the containing block, in
 * which case viewport-space coordinates need no translation.
 *
 * A fixed menu positioned with viewport-space coordinates lands offset from
 * its anchor whenever such an ancestor exists: `.modal-backdrop` always sets
 * `backdrop-filter: blur(3px)`, and the modal cards set
 * `transform: translateY(0)` in mobile keyboard mode, so menus opened inside
 * modals must translate their coordinates into that ancestor's space.
 */
export function getFixedContainingBlockBox(element: HTMLElement | null): FixedContainingBlockBox {
  const viewport = { left: 0, top: 0, height: 0 };
  if (!element || typeof window === "undefined" || !window.getComputedStyle) return viewport;
  let current = element.parentElement;
  while (current && current !== document.body && current !== document.documentElement) {
    if (createsFixedContainingBlock(window.getComputedStyle(current))) {
      // clientLeft/clientTop/clientHeight describe the padding box exactly:
      // past the border and past any scrollbar or reserved scrollbar gutter.
      // `.modal-backdrop` sets `scrollbar-gutter: stable both-edges` with a
      // 6px `::-webkit-scrollbar`, so in Chromium (Android WebView, WebView2)
      // its padding box starts 6px right of its border edge; measuring only
      // the border shifted every modal dropdown right of its trigger.
      const rect = current.getBoundingClientRect();
      return {
        left: rect.left + current.clientLeft - current.scrollLeft,
        top: rect.top + current.clientTop - current.scrollTop,
        height: current.clientHeight,
      };
    }
    current = current.parentElement;
  }
  return viewport;
}

/**
 * Calculates the visible top and bottom clipping boundaries for an element,
 * considering the viewport and any clipping or scrolling ancestors.
 */
export function getClippingBounds(
  element: HTMLElement,
  options?: { isFixed?: boolean },
): { top: number; bottom: number } {
  const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
  const viewportTop = window.visualViewport?.offsetTop ?? 0;
  let top = viewportTop;
  let bottom = viewportTop + viewportHeight;

  if (options?.isFixed) {
    let current: HTMLElement | null = element.parentElement;
    while (current && current !== document.body && current !== document.documentElement) {
      if (typeof window !== "undefined" && window.getComputedStyle) {
        if (createsFixedContainingBlock(window.getComputedStyle(current))) {
          const rect = current.getBoundingClientRect();
          top = Math.max(top, rect.top);
          bottom = Math.min(bottom, rect.bottom);
        }
      }
      current = current.parentElement;
    }
    return { top, bottom };
  }

  let current: HTMLElement | null = element.parentElement;
  while (current && current !== document.body && current !== document.documentElement) {
    const isNamedScrollContainer =
      current.classList.contains("dashboard-scroll") ||
      current.classList.contains("content-scroll") ||
      current.classList.contains("modal-scroll");

    let isStyleClipping = false;
    if (typeof window !== "undefined" && window.getComputedStyle) {
      const style = window.getComputedStyle(current);
      const overflowY = style.overflowY;
      const overflow = style.overflow;
      isStyleClipping =
        overflowY === "auto" ||
        overflowY === "hidden" ||
        overflowY === "scroll" ||
        overflow === "auto" ||
        overflow === "hidden" ||
        overflow === "scroll";
    }

    if (isNamedScrollContainer || isStyleClipping) {
      const rect = current.getBoundingClientRect();
      top = Math.max(top, rect.top);
      bottom = Math.min(bottom, rect.bottom);
    }

    current = current.parentElement;
  }

  return { top, bottom };
}

/**
 * Returns the unconstrained content height of a rendered menu element,
 * using scrollHeight + borders to account for any currently applied maxHeight.
 */
export function getMenuContentHeight(menu: HTMLElement | null): number {
  if (!menu) return 0;
  const rect = menu.getBoundingClientRect();
  const style = typeof window !== "undefined" && window.getComputedStyle ? window.getComputedStyle(menu) : null;
  const borderTop = style ? parseFloat(style.borderTopWidth) || 0 : 0;
  const borderBottom = style ? parseFloat(style.borderBottomWidth) || 0 : 0;
  const scrollHeightWithBorders = menu.scrollHeight + borderTop + borderBottom;
  return Math.max(rect.height, scrollHeightWithBorders);
}

/**
 * Computes placement for a dropdown/popover menu, flipping upward when there is
 * insufficient space below the anchor to fit the full menu.
 */
export function computeDropdownPlacement(
  anchor: HTMLElement | null,
  menu: HTMLElement | null,
  options: DropdownPlacementOptions = {},
): DropdownPlacementResult {
  if (!anchor) {
    return {
      openUpward: false,
      maxHeight: options.maxHeightCap ?? 280,
      spaceBelow: 0,
      spaceAbove: 0,
      menuHeight: options.estimatedHeight ?? 0,
    };
  }

  const {
    gap = 8,
    minHeight = 80,
    maxHeightCap,
    estimatedHeight = 150,
    isFixed = false,
  } = options;

  const anchorRect = anchor.getBoundingClientRect();
  const { top: topBoundary, bottom: bottomBoundary } = getClippingBounds(anchor, { isFixed });

  const spaceBelow = Math.max(0, bottomBoundary - anchorRect.bottom - gap);
  const spaceAbove = Math.max(0, anchorRect.top - topBoundary - gap);

  const measuredHeight = getMenuContentHeight(menu);
  const menuHeight = measuredHeight > 0 ? measuredHeight : estimatedHeight;

  const fitsBelow = spaceBelow >= menuHeight;
  const fitsAbove = spaceAbove >= menuHeight;
  const openUpward = !fitsBelow && (fitsAbove || spaceAbove > spaceBelow);

  const availableSpace = openUpward ? spaceAbove : spaceBelow;
  const maxHeight =
    maxHeightCap != null
      ? Math.min(maxHeightCap, Math.max(minHeight, Math.floor(availableSpace)))
      : Math.max(minHeight, Math.floor(availableSpace));

  return {
    openUpward,
    maxHeight,
    spaceBelow,
    spaceAbove,
    menuHeight,
  };
}

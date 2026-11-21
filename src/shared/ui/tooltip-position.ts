/**
 * Viewport-aware positioning for the global portal tooltip layer.
 * Keeps every tooltip inside the visible viewport and flips sides when
 * there isn't enough room on the preferred side.
 */

export type TooltipPlacementSide = "bottom" | "top" | "right";
export type TooltipAlign = "center" | "start" | "end";

export interface RectBox {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
}

export interface TooltipSize {
  width: number;
  height: number;
}

export interface TooltipViewport {
  width: number;
  height: number;
  safeTop?: number;
  safeBottom?: number;
  safeLeft?: number;
  safeRight?: number;
}

export interface TooltipPlacementConfig {
  placement: TooltipPlacementSide;
  align: TooltipAlign;
  offset: number;
  inset?: number;
  maxWidth?: number;
  anchorRect?: RectBox;
}

export interface TooltipCoordinates {
  left: number;
  top: number;
  placement: TooltipPlacementSide | "left";
}

const VIEWPORT_MARGIN = 8;

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(max, Math.max(min, value));
}

function horizontalForAlign(anchor: RectBox, tooltipWidth: number, align: TooltipAlign, inset: number): number {
  if (align === "start") return anchor.left + inset;
  if (align === "end") return anchor.right - inset - tooltipWidth;
  return anchor.left + anchor.width / 2 - tooltipWidth / 2;
}

/**
 * Pure geometry calculation for placing a `position: fixed` tooltip relative to
 * its trigger while clamping inside the viewport safe bounds.
 */
export function computeTooltipPosition(
  triggerRect: RectBox,
  tooltipSize: TooltipSize,
  viewport: TooltipViewport,
  config: TooltipPlacementConfig,
): TooltipCoordinates {
  const minX = (viewport.safeLeft ?? 0) + VIEWPORT_MARGIN;
  const maxX = viewport.width - (viewport.safeRight ?? 0) - VIEWPORT_MARGIN;
  const minY = (viewport.safeTop ?? 0) + VIEWPORT_MARGIN;
  const maxY = viewport.height - (viewport.safeBottom ?? 0) - VIEWPORT_MARGIN;
  const anchor = config.anchorRect ?? triggerRect;
  const inset = config.inset ?? 0;

  if (config.placement === "right") {
    const preferredLeft = triggerRect.right + config.offset;
    const flippedLeft = triggerRect.left - config.offset - tooltipSize.width;
    let placement: TooltipCoordinates["placement"] = "right";
    let left = preferredLeft;
    if (preferredLeft + tooltipSize.width > maxX && flippedLeft >= minX) {
      left = flippedLeft;
      placement = "left";
    } else {
      left = clamp(preferredLeft, minX, maxX - tooltipSize.width);
    }
    const centeredTop = triggerRect.top + triggerRect.height / 2 - tooltipSize.height / 2;
    const top = clamp(centeredTop, minY, maxY - tooltipSize.height);
    return { left: Math.round(left), top: Math.round(top), placement };
  }

  const belowTop = triggerRect.bottom + config.offset;
  const aboveTop = triggerRect.top - config.offset - tooltipSize.height;
  let placement: TooltipPlacementSide = config.placement;
  let top: number;

  if (config.placement === "top") {
    if (aboveTop < minY && belowTop + tooltipSize.height <= maxY) {
      top = belowTop;
      placement = "bottom";
    } else {
      top = clamp(aboveTop, minY, maxY - tooltipSize.height);
    }
  } else {
    if (belowTop + tooltipSize.height > maxY && aboveTop >= minY) {
      top = aboveTop;
      placement = "top";
    } else {
      top = clamp(belowTop, minY, maxY - tooltipSize.height);
    }
  }

  const rawLeft = horizontalForAlign(anchor, tooltipSize.width, config.align, inset);
  const left = clamp(rawLeft, minX, maxX - tooltipSize.width);
  return { left: Math.round(left), top: Math.round(top), placement };
}

function anchorBoxFor(trigger: HTMLElement, selector: string): RectBox | undefined {
  const container = trigger.closest<HTMLElement>(selector);
  return container ? container.getBoundingClientRect() : undefined;
}

/**
 * Resolves the preferred side, alignment, offset, and optional container anchor
 * for any `[data-tooltip]` trigger element in the app.
 */
export function getTooltipPlacement(trigger: HTMLElement): TooltipPlacementConfig {
  if (trigger.matches(".reorder-grip")) {
    return { placement: "right", align: "center", offset: 10 };
  }
  if (trigger.matches(".pairing-switch-camera-fab")) {
    return { placement: "top", align: "center", offset: 8 };
  }
  if (trigger.matches(".sidebar-settings-btn")) {
    return { placement: "top", align: "end", offset: 8 };
  }
  if (trigger.matches(".activity-bar-slot, .activity-reset-hit")) {
    const align: TooltipAlign = trigger.classList.contains("is-left")
      ? "start"
      : trigger.classList.contains("is-right")
        ? "end"
        : "center";
    return { placement: "bottom", align, offset: 8, maxWidth: 240 };
  }
  if (trigger.matches(".top-bar-nav-item")) {
    const anchorRect = anchorBoxFor(trigger, ".top-bar-nav");
    if (trigger.matches(":first-child")) {
      return { placement: "bottom", align: "start", offset: 8, inset: 3, anchorRect };
    }
    if (trigger.matches(":last-child")) {
      return { placement: "bottom", align: "end", offset: 8, inset: 3, anchorRect };
    }
    return { placement: "bottom", align: "center", offset: 8, anchorRect };
  }
  if (trigger.matches(".top-bar-segmented button")) {
    return {
      placement: "bottom",
      align: "end",
      offset: 9,
      inset: 2,
      anchorRect: anchorBoxFor(trigger, ".top-bar-segmented"),
    };
  }
  if (trigger.matches(".activity-period-switch button")) {
    return {
      placement: "bottom",
      align: "end",
      offset: 9,
      inset: 2,
      anchorRect: anchorBoxFor(trigger, ".activity-period-switch"),
    };
  }
  if (trigger.matches(".provider-window-toggle button")) {
    const anchorRect = anchorBoxFor(trigger, ".provider-window-toggle");
    if (trigger.closest(".dashboard-header-actions")) {
      return { placement: "bottom", align: "end", offset: 8, anchorRect };
    }
    const stacked = document.documentElement.hasAttribute("data-sidebar-toggle-stacked");
    return {
      placement: "bottom",
      align: stacked ? "start" : "end",
      offset: stacked ? 8 : 12,
      anchorRect,
    };
  }
  if (trigger.matches(".top-bar-add-group")) {
    return { placement: "bottom", align: "center", offset: 8, maxWidth: 320 };
  }
  if (trigger.matches(".add-bucket-header-button")) {
    return { placement: "bottom", align: "start", offset: 12, maxWidth: 260 };
  }
  if (
    trigger.matches(
      ".top-bar-add-account, .ui-modal-close, .provider-average, .sidebar-group-edit-btn, .mobile-sidebar-close-btn, .dashboard-header-actions .sidebar-section-button",
    )
  ) {
    return { placement: "bottom", align: "end", offset: 8 };
  }
  if (trigger.matches(".account-card-name-actions .account-card-action, .sidebar-resize-grip")) {
    return { placement: "bottom", align: "end", offset: 12 };
  }
  if (
    trigger.matches(
      ".account-name-edit, .account-name-confirm, .account-name-cancel, .edit-bucket-title-btn, .delete-bucket-title-btn, .account-card-provider-icon, .add-account-header-button, .mobile-sidebar-toggle-btn",
    )
  ) {
    return { placement: "bottom", align: "start", offset: 10 };
  }
  if (trigger.matches(".account-card-action")) {
    return { placement: "bottom", align: "center", offset: 12 };
  }
  return { placement: "bottom", align: "center", offset: 8 };
}

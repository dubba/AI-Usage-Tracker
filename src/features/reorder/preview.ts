import { accountCards, accountScrollContainer, groupRows, originalOrder } from "./dom";
import { hideInline, isHiddenInline, readInlineDisplay, restoreInlineDisplay } from "./reorder-source";
import type { ActiveDrag, PointerCandidate } from "./types";

const EDGE_SCROLL_ZONE_PX = 52;
const EDGE_SCROLL_MAX_STEP_PX = 18;
const REORDER_ANIMATION_MS = 150;
// A card taller than this is dragged as a compact preview of its top. A card with many model rows
// can be taller than the screen; dragging a copy that size hides the list and makes the drop
// position depend on where the middle of that copy is, not where the finger is.
const MAX_FLOAT_HEIGHT_PX = 200;
const CAPPED_FLOAT_GRAB_OFFSET_PX = 48;

export function reorderElements(drag: ActiveDrag): HTMLElement[] {
  if (drag.descriptor.kind === "group") {
    return groupRows(drag.container).filter((row) => row !== drag.source);
  }
  return accountCards(drag.container).filter((card) => card !== drag.source);
}

function capturePositions(elements: HTMLElement[]): Map<HTMLElement, { left: number; top: number }> {
  return new Map(elements.map((element) => {
    const bounds = element.getBoundingClientRect();
    return [element, { left: bounds.left, top: bounds.top }];
  }));
}

function animateReorder(elements: HTMLElement[], before: Map<HTMLElement, { left: number; top: number }>): void {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  window.requestAnimationFrame(() => {
    for (const element of elements) {
      const previous = before.get(element);
      if (!previous) continue;
      const bounds = element.getBoundingClientRect();
      const deltaX = previous.left - bounds.left;
      const deltaY = previous.top - bounds.top;
      if (Math.abs(deltaX) < 1 && Math.abs(deltaY) < 1) continue;
      for (const animation of element.getAnimations()) animation.cancel();
      element.animate(
        [
          { transform: `translate3d(${deltaX}px, ${deltaY}px, 0)` },
          { transform: "translate3d(0, 0, 0)" },
        ],
        { duration: REORDER_ANIMATION_MS, easing: "cubic-bezier(.2,.8,.2,1)" },
      );
    }
  });
}

function placeholderIndex(drag: ActiveDrag, elements: HTMLElement[]): number {
  const sequence = Array.from(drag.container.children).filter(
    (child) => child === drag.placeholder || elements.includes(child as HTMLElement),
  );
  return sequence.indexOf(drag.placeholder);
}

function floatingCenterY(drag: ActiveDrag): number {
  return drag.lastClientY - drag.floatGrabY + drag.floatHeight / 2;
}

export function updatePlaceholderFromPointer(drag: ActiveDrag): void {
  const clientY = floatingCenterY(drag);
  const elements = reorderElements(drag);
  let reference: HTMLElement | null = null;
  for (const element of elements) {
    const bounds = element.getBoundingClientRect();
    if (clientY < bounds.top + bounds.height / 2) {
      reference = element;
      break;
    }
  }

  const desiredIndex = reference ? elements.indexOf(reference) : elements.length;
  if (placeholderIndex(drag, elements) === desiredIndex) return;

  const before = capturePositions(elements);
  if (reference) drag.container.insertBefore(drag.placeholder, reference);
  else drag.container.appendChild(drag.placeholder);
  animateReorder(elements, before);
}

function autoScrollStep(drag: ActiveDrag): number {
  const bounds = drag.scrollContainer.getBoundingClientRect();
  if (drag.lastClientY < bounds.top + EDGE_SCROLL_ZONE_PX) {
    const strength = 1 - Math.max(0, drag.lastClientY - bounds.top) / EDGE_SCROLL_ZONE_PX;
    return -Math.max(4, Math.round(EDGE_SCROLL_MAX_STEP_PX * strength));
  }
  if (drag.lastClientY > bounds.bottom - EDGE_SCROLL_ZONE_PX) {
    const strength = 1 - Math.max(0, bounds.bottom - drag.lastClientY) / EDGE_SCROLL_ZONE_PX;
    return Math.max(4, Math.round(EDGE_SCROLL_MAX_STEP_PX * strength));
  }
  return 0;
}

function applyFloatingStyles(element: HTMLElement, bounds: DOMRect, clip: boolean): void {
  Object.assign(element.style, {
    position: "fixed",
    left: `${bounds.left}px`,
    top: `${bounds.top}px`,
    margin: "0",
    zIndex: "10000",
    pointerEvents: "none",
    boxSizing: "border-box",
    transform: "translate3d(0, 0, 0)",
    transformOrigin: "top left",
    willChange: "transform",
  });
  element.style.setProperty("width", `${bounds.width}px`, "important");
  element.style.setProperty("max-width", `${bounds.width}px`, "important");
  element.style.setProperty("height", `${bounds.height}px`, "important");
  if (clip) {
    // Cards carry min-height: max-content, which would otherwise win over the shorter height.
    element.style.setProperty("min-height", "0", "important");
    element.style.setProperty("max-height", `${bounds.height}px`, "important");
    element.style.setProperty("overflow", "hidden", "important");
  }
}

function createFloatClone(source: HTMLElement, bounds: DOMRect, clip: boolean): HTMLElement {
  const float = source.cloneNode(true) as HTMLElement;
  float.classList.add("is-dragging", "dashboard-reorder-float");
  float.removeAttribute("data-reorder-enabled");
  float.setAttribute("aria-hidden", "true");
  for (const node of float.querySelectorAll("[id]")) {
    node.removeAttribute("id");
  }
  for (const menu of float.querySelectorAll(".mobile-dropdown-menu")) {
    menu.remove();
  }
  applyFloatingStyles(float, bounds, clip);
  document.body.appendChild(float);
  return float;
}

export function settleVisualDrag(drag: ActiveDrag, commit: boolean): void {
  if (drag.autoScrollFrame != null) window.cancelAnimationFrame(drag.autoScrollFrame);
  for (const element of reorderElements(drag)) {
    for (const animation of element.getAnimations()) animation.cancel();
  }
  if (drag.float !== drag.source) {
    drag.float.remove();
  }

  // Put the card back. The anchor can be gone if the list re-rendered mid-drag, in which case the
  // card goes to the end rather than throwing and leaving it hidden.
  const anchor = commit ? drag.placeholder : drag.originalNextSibling;
  if (anchor && anchor.parentNode === drag.container) {
    drag.container.insertBefore(drag.source, anchor);
  } else {
    drag.container.appendChild(drag.source);
  }
  drag.placeholder.remove();

  drag.source.classList.remove("is-dragging", "is-reorder-origin");
  drag.container.classList.remove("reorder-previewing");
  restoreInlineDisplay(drag.source, drag.originalDisplay);
  try {
    if (drag.source.hasPointerCapture(drag.pointerId)) {
      drag.source.releasePointerCapture(drag.pointerId);
    }
  } catch {
    // The pointer may already have been released by the WebView.
  }
  document.documentElement.classList.remove("dashboard-reordering");
  document.documentElement.classList.remove("dashboard-holding");
  document.documentElement.style.removeProperty("cursor");
  document.body.style.removeProperty("cursor");
}

export function clearDragArtifacts(): void {
  // Hidden cards are found from the live inline style, not a [style*=...] selector: the style
  // attribute can disagree with the element's real styles (see reorder-source.ts).
  const hidden = Array.from(
    document.querySelectorAll<HTMLElement>(".is-reorder-origin, .provider-account-card, .provider-summary-row"),
  ).filter((element) => element.classList.contains("is-reorder-origin") || isHiddenInline(element));
  const strays = document.querySelectorAll(".dashboard-reorder-float, .dashboard-reorder-placeholder");
  for (const element of hidden) {
    element.classList.remove("is-reorder-origin", "is-dragging");
    if (isHiddenInline(element)) element.style.removeProperty("display");
  }
  for (const node of strays) {
    node.remove();
  }
  for (const container of document.querySelectorAll(".reorder-previewing")) {
    container.classList.remove("reorder-previewing");
  }
  document.documentElement.classList.remove("dashboard-reordering");
}

/**
 * Scrolls the list while the pointer is held near its top or bottom edge. Runs one step per
 * animation frame for as long as `isActive()` says this drag is still the current one.
 */
export function startAutoScroll(drag: ActiveDrag, isActive: () => boolean): void {
  const step = () => {
    if (!isActive()) return;
    const delta = autoScrollStep(drag);
    if (delta !== 0) {
      const previousScrollTop = drag.scrollContainer.scrollTop;
      drag.scrollContainer.scrollTop += delta;
      if (drag.scrollContainer.scrollTop !== previousScrollTop) {
        updatePlaceholderFromPointer(drag);
      }
    }
    drag.autoScrollFrame = window.requestAnimationFrame(step);
  };
  drag.autoScrollFrame = window.requestAnimationFrame(step);
}

/**
 * Builds the drag for a pressed card or row: the floating copy under the pointer and the
 * placeholder that marks the drop position. Nothing in the list changes until
 * `enterDragVisuals`, so the caller can register the drag first.
 */
export function prepareDrag(clientX: number, clientY: number, candidate: PointerCandidate): ActiveDrag | null {
  const descriptor = candidate.drag;
  const container = descriptor.source.parentElement;
  if (!container) return null;
  const scrollContainer = descriptor.kind === "group"
    ? container
    : accountScrollContainer(descriptor.source);
  const bounds = descriptor.source.getBoundingClientRect();
  const placeholder = document.createElement("div");
  const placeholderClass = descriptor.kind === "group" ? "provider-reorder-placeholder" : "account-reorder-placeholder";
  placeholder.className = `dashboard-reorder-placeholder ${placeholderClass}`;
  placeholder.setAttribute("aria-hidden", "true");

  // Only cards are shortened; sidebar rows are always small. The gap left in the list is
  // shortened too, so the other cards stay on screen while a tall card is dragged.
  const capped = descriptor.kind === "account" && bounds.height > MAX_FLOAT_HEIGHT_PX;
  const floatHeight = capped ? MAX_FLOAT_HEIGHT_PX : bounds.height;
  placeholder.style.height = `${floatHeight}px`;
  const grabOffsetY = candidate.startY - bounds.top;
  const floatGrabY = capped ? Math.min(grabOffsetY, CAPPED_FLOAT_GRAB_OFFSET_PX) : grabOffsetY;
  const floatBounds = new DOMRect(bounds.left, candidate.startY - floatGrabY, bounds.width, floatHeight);
  const float = createFloatClone(descriptor.source, floatBounds, capped);

  return {
    pointerId: candidate.pointerId,
    startX: candidate.startX,
    startY: candidate.startY,
    lastClientX: clientX,
    lastClientY: clientY,
    floatGrabY,
    floatHeight,
    descriptor,
    container,
    scrollContainer,
    source: descriptor.source,
    float,
    placeholder,
    originalNextSibling: descriptor.source.nextSibling,
    originalDisplay: readInlineDisplay(descriptor.source),
    originalOrder: originalOrder(descriptor, container),
    autoScrollFrame: null,
  };
}

/** Hides the origin, drops the placeholder in its place, and starts following the pointer. */
export function enterDragVisuals(drag: ActiveDrag, pointerType: string, isActive: () => boolean): void {
  drag.source.after(drag.placeholder);

  drag.container.classList.add("reorder-previewing");
  drag.source.classList.add("is-reorder-origin");
  hideInline(drag.source);
  document.documentElement.classList.add("dashboard-reordering");
  document.documentElement.style.setProperty("cursor", "grabbing", "important");
  document.body.style.setProperty("cursor", "grabbing", "important");
  if (pointerType !== "touch" && pointerType !== "pen") {
    try {
      drag.source.setPointerCapture(drag.pointerId);
    } catch {
      // Document-level pointer handlers continue the drag when capture is unavailable.
    }
  }
  updatePlaceholderFromPointer(drag);
  startAutoScroll(drag, isActive);
}

/** Moves the floating copy to follow the pointer. */
export function moveFloat(drag: ActiveDrag): void {
  const deltaX = drag.lastClientX - drag.startX;
  const deltaY = drag.lastClientY - drag.startY;
  drag.float.style.transform = `translate3d(${deltaX}px, ${deltaY}px, 0)`;
}

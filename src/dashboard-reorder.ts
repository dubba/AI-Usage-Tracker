import { bridgeApi } from "./api";
import { storePageAccountOrder } from "./dashboard-page-state";
import { requestDashboardResync } from "./events";
import { logIgnored } from "./log";
import { KNOWN_PROVIDERS, storeSidebarGroupOrder, uniqueStrings } from "./sidebar-order";
import { getLatestSnapshot } from "./snapshot-store";
import type { Provider } from "./types";

const EDGE_SCROLL_ZONE_PX = 52;
const EDGE_SCROLL_MAX_STEP_PX = 18;
const DRAG_THRESHOLD_PX = 5;
const TOUCH_CANCEL_MOVE_PX = 8;
const LONG_PRESS_DELAY_MS = 350;
const REORDER_ANIMATION_MS = 150;

type DragDescriptor =
  | { kind: "group"; groupId: string; provider: Provider; source: HTMLElement }
  | { kind: "account"; accountId: string; provider: Provider; source: HTMLElement };

type PointerCandidate = {
  pointerId: number;
  pointerType: string;
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
  drag: DragDescriptor;
  longPressTimer: number | null;
  isInteractive?: boolean;
};

type ActiveDrag = {
  pointerId: number;
  startX: number;
  startY: number;
  lastClientX: number;
  lastClientY: number;
  grabOffsetY: number;
  sourceHeight: number;
  descriptor: DragDescriptor;
  container: HTMLElement;
  scrollContainer: HTMLElement;
  source: HTMLElement;
  float: HTMLElement;
  placeholder: HTMLElement;
  originalNextSibling: ChildNode | null;
  originalStyle: string | null;
  originalOrder: string[];
  autoScrollFrame: number | null;
};

let pointerCandidate: PointerCandidate | null = null;
let dragState: ActiveDrag | null = null;
let lastDragMoveAt = 0;
let dragStartedAt = 0;
let abandonDragTimer: number | null = null;
let abandonDragGeneration = 0;
let dragTouchActive = false;

function isInteractivePointerTarget(target: Element): boolean {
  return Boolean(
    target.closest(
      "button, a, input, textarea, select, label, .account-card-action, .account-card-provider-icon, .account-name-edit, .account-name-confirm, .account-name-cancel",
    ),
  );
}

function applyPressCursor(): void {
  document.documentElement.classList.add("dashboard-holding");
  document.documentElement.style.setProperty("cursor", "grabbing", "important");
  document.body.style.setProperty("cursor", "grabbing", "important");
}

function clearPressCursor(): void {
  document.documentElement.classList.remove("dashboard-holding");
  if (dragState || document.documentElement.classList.contains("dashboard-reordering")) return;
  document.documentElement.style.removeProperty("cursor");
  document.body.style.removeProperty("cursor");
}

let lastDropAt = 0;






function groupIdFromRow(row: HTMLElement): string | null {
  const groupId = row.dataset.groupId?.trim();
  return groupId ? groupId : null;
}

function providerOf(element: HTMLElement): Provider | null {
  const provider = element.dataset.reorderProvider as Provider | undefined;
  return provider && KNOWN_PROVIDERS.includes(provider) ? provider : null;
}




function arraysEqual<T>(left: T[], right: T[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function groupRows(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(":scope > .provider-summary-row"))
    .filter((row) => row.dataset.groupId !== "all" && !row.classList.contains("is-all-row"));
}

function accountCards(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(":scope > .provider-account-card"));
}




function visibleAccountIds(container: HTMLElement): string[] {
  return uniqueStrings(
    accountCards(container)
      .map((card) => card.dataset.accountId?.trim() ?? "")
      .filter((accountId) => accountId.length > 0),
  );
}


function dragFromPointerTarget(target: Element): DragDescriptor | null {
  const groupRow = target.closest<HTMLElement>(".provider-summary-row[data-reorder-enabled='true']");
  if (groupRow) {
    const groupId = groupIdFromRow(groupRow);
    const provider = providerOf(groupRow) ?? "openai";
    return groupId ? { kind: "group", groupId, provider, source: groupRow } : null;
  }

  if (target.closest("input, textarea, select, [contenteditable='true'], .remove-account-confirmation")) return null;
  const card = target.closest<HTMLElement>(".provider-account-card[data-reorder-enabled='true']");
  if (!card) return null;
  const accountId = card.dataset.accountId;
  const provider = providerOf(card);
  return accountId && provider ? { kind: "account", accountId, provider, source: card } : null;
}

function originalOrder(descriptor: DragDescriptor, container: HTMLElement): string[] {
  if (descriptor.kind === "group") {
    return groupRows(container)
      .map(groupIdFromRow)
      .filter((id): id is string => Boolean(id));
  }
  return visibleAccountIds(container);
}

function reorderElements(drag: ActiveDrag): HTMLElement[] {
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
  if (window.matchMedia("(prefers-reduced-motion: reduce), (pointer: coarse)").matches) return;
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
  return drag.lastClientY - drag.grabOffsetY + drag.sourceHeight / 2;
}

function updatePlaceholderFromPointer(drag: ActiveDrag): void {
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

function runAutoScroll(): void {
  const drag = dragState;
  if (!drag) return;
  const delta = autoScrollStep(drag);
  if (delta !== 0) {
    const previousScrollTop = drag.scrollContainer.scrollTop;
    drag.scrollContainer.scrollTop += delta;
    if (drag.scrollContainer.scrollTop !== previousScrollTop) {
      updatePlaceholderFromPointer(drag);
    }
  }
  drag.autoScrollFrame = window.requestAnimationFrame(runAutoScroll);
}

function accountScrollContainer(source: HTMLElement): HTMLElement {
  return source.closest<HTMLElement>(".dashboard-scroll")
    ?? source.closest<HTMLElement>(".dashboard-content")
    ?? source.parentElement
    ?? document.documentElement;
}

function applyFloatingStyles(element: HTMLElement, bounds: DOMRect): void {
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
}

function createFloatClone(source: HTMLElement, bounds: DOMRect): HTMLElement {
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
  applyFloatingStyles(float, bounds);
  document.body.appendChild(float);
  return float;
}

function beginVisualDrag(clientX: number, clientY: number, candidate: PointerCandidate): ActiveDrag | null {
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
  placeholder.style.height = `${bounds.height}px`;

  const float = createFloatClone(descriptor.source, bounds);

  const active: ActiveDrag = {
    pointerId: candidate.pointerId,
    startX: candidate.startX,
    startY: candidate.startY,
    lastClientX: clientX,
    lastClientY: clientY,
    grabOffsetY: candidate.startY - bounds.top,
    sourceHeight: bounds.height,
    descriptor,
    container,
    scrollContainer,
    source: descriptor.source,
    float,
    placeholder,
    originalNextSibling: descriptor.source.nextSibling,
    originalStyle: descriptor.source.getAttribute("style"),
    originalOrder: originalOrder(descriptor, container),
    autoScrollFrame: null,
  };

  dragState = active;
  lastDragMoveAt = Date.now();
  dragStartedAt = Date.now();
  descriptor.source.after(placeholder);

  container.classList.add("reorder-previewing");
  descriptor.source.classList.add("is-reorder-origin");
  descriptor.source.style.setProperty("display", "none", "important");
  document.documentElement.classList.add("dashboard-reordering");
  document.documentElement.style.setProperty("cursor", "grabbing", "important");
  document.body.style.setProperty("cursor", "grabbing", "important");
  if (candidate.pointerType !== "touch" && candidate.pointerType !== "pen") {
    try {
      descriptor.source.setPointerCapture(candidate.pointerId);
    } catch {
      // Document-level pointer handlers continue the drag when capture is unavailable.
    }
  }
  updatePlaceholderFromPointer(active);
  active.autoScrollFrame = window.requestAnimationFrame(runAutoScroll);
  return active;
}

function clearAbandonedDragTimer(): void {
  if (abandonDragTimer != null) {
    window.clearTimeout(abandonDragTimer);
    abandonDragTimer = null;
  }
}

function noteDragMove(): void {
  lastDragMoveAt = Date.now();
  abandonDragGeneration += 1;
  clearAbandonedDragTimer();
}

function scheduleAbandonedDragFinish(): void {
  const generation = ++abandonDragGeneration;
  clearAbandonedDragTimer();
  abandonDragTimer = window.setTimeout(() => {
    abandonDragTimer = null;
    if (generation !== abandonDragGeneration || !dragState) return;
    if (Date.now() - lastDragMoveAt < 180) {
      scheduleAbandonedDragFinish();
      return;
    }
    finishDrag(true);
  }, 180);
}

function updateFloatingSource(drag: ActiveDrag): void {
  noteDragMove();
  const deltaX = drag.lastClientX - drag.startX;
  const deltaY = drag.lastClientY - drag.startY;
  drag.float.style.transform = `translate3d(${deltaX}px, ${deltaY}px, 0)`;
}

function restoreSourceStyle(drag: ActiveDrag): void {
  if (drag.originalStyle == null) drag.source.removeAttribute("style");
  else drag.source.setAttribute("style", drag.originalStyle);
}

function settleVisualDrag(drag: ActiveDrag, commit: boolean): void {
  if (drag.autoScrollFrame != null) window.cancelAnimationFrame(drag.autoScrollFrame);
  for (const element of reorderElements(drag)) {
    for (const animation of element.getAnimations()) animation.cancel();
  }
  if (drag.float !== drag.source) {
    drag.float.remove();
  }

  if (commit) {
    drag.container.insertBefore(drag.source, drag.placeholder);
  } else if (drag.originalNextSibling && drag.originalNextSibling.parentNode === drag.container) {
    drag.container.insertBefore(drag.source, drag.originalNextSibling);
  } else {
    drag.container.appendChild(drag.source);
  }
  drag.placeholder.remove();

  drag.source.classList.remove("is-dragging", "is-reorder-origin");
  drag.container.classList.remove("reorder-previewing");
  restoreSourceStyle(drag);
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

function committedOrder(drag: ActiveDrag): string[] {
  if (drag.descriptor.kind === "group") {
    const ids = groupRows(drag.container)
      .map(groupIdFromRow)
      .filter((id): id is string => Boolean(id));
    return uniqueStrings(ids);
  }
  return visibleAccountIds(drag.container);
}

export function isReordering(): boolean {
  return dragState != null || Date.now() - lastDropAt < 600;
}

function finishDrag(commit: boolean): void {
  clearAbandonedDragTimer();
  dragTouchActive = false;
  const drag = dragState;
  pointerCandidate = null;
  if (!drag) return;

  settleVisualDrag(drag, commit);
  const nextOrder = commit ? committedOrder(drag) : drag.originalOrder;
  dragState = null;
  lastDropAt = Date.now();

  if (!commit || arraysEqual(drag.originalOrder, nextOrder)) return;

  if (drag.descriptor.kind === "group") {
    storeSidebarGroupOrder(nextOrder);
    void persistGroupOrder(nextOrder);
  } else {
    void persistVisibleAccountOrder(nextOrder, drag.container.dataset.groupId ?? null);
  }
}

function beginPointerCandidate(event: PointerEvent): void {
  if (event.button !== 0 || event.isPrimary === false || dragState) return;
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return;
  const drag = dragFromPointerTarget(target);
  if (!drag) return;

  if (pointerCandidate?.longPressTimer != null) {
    window.clearTimeout(pointerCandidate.longPressTimer);
  }

  const isTouch = event.pointerType === "touch" || event.pointerType === "pen";
  if (isTouch) dragTouchActive = true;
  const isInteractive = isInteractivePointerTarget(target);
  const candidate: PointerCandidate = {
    pointerId: event.pointerId,
    pointerType: event.pointerType,
    startX: event.clientX,
    startY: event.clientY,
    currentX: event.clientX,
    currentY: event.clientY,
    drag,
    longPressTimer: null,
    isInteractive,
  };

  if (isTouch || isInteractive) {
    candidate.longPressTimer = window.setTimeout(() => {
      if (pointerCandidate !== candidate || dragState) return;
      try {
        navigator.vibrate?.(40);
      } catch {
        // Haptics may be unavailable on some platforms.
      }
      beginVisualDrag(candidate.currentX, candidate.currentY, candidate);
    }, LONG_PRESS_DELAY_MS);
  } else {
    // WKWebView resets non-control cursors to the default arrow on mousedown.
    // Pin grabbing on html/body for the hold, before the drag threshold.
    event.preventDefault();
    applyPressCursor();
  }

  pointerCandidate = candidate;
}

function movePointerCandidate(event: PointerEvent): void {
  if (!pointerCandidate || pointerCandidate.pointerId !== event.pointerId) return;

  pointerCandidate.currentX = event.clientX;
  pointerCandidate.currentY = event.clientY;

  if (!dragState) {
    const isTouch = pointerCandidate.pointerType === "touch" || pointerCandidate.pointerType === "pen";
    const distance = Math.hypot(
      event.clientX - pointerCandidate.startX,
      event.clientY - pointerCandidate.startY,
    );

    if (isTouch) {
      if (distance > TOUCH_CANCEL_MOVE_PX) {
        if (pointerCandidate.longPressTimer != null) {
          window.clearTimeout(pointerCandidate.longPressTimer);
          pointerCandidate.longPressTimer = null;
        }
        pointerCandidate = null;
      }
      return;
    }

    if (pointerCandidate.isInteractive) {
      if (distance < DRAG_THRESHOLD_PX) return;
      if (pointerCandidate.longPressTimer != null) {
        window.clearTimeout(pointerCandidate.longPressTimer);
        pointerCandidate.longPressTimer = null;
      }
      if (!beginVisualDrag(event.clientX, event.clientY, pointerCandidate)) {
        pointerCandidate = null;
        return;
      }
      return;
    }

    if (distance < DRAG_THRESHOLD_PX) return;
    if (!beginVisualDrag(event.clientX, event.clientY, pointerCandidate)) {
      pointerCandidate = null;
      return;
    }
  }

  const drag = dragState;
  if (!drag) return;
  event.preventDefault();
  drag.lastClientX = event.clientX;
  drag.lastClientY = event.clientY;
  updateFloatingSource(drag);
  updatePlaceholderFromPointer(drag);
}

function endPointerCandidate(event: PointerEvent): void {
  if (!pointerCandidate || pointerCandidate.pointerId !== event.pointerId) return;
  if (pointerCandidate.longPressTimer != null) {
    window.clearTimeout(pointerCandidate.longPressTimer);
    pointerCandidate.longPressTimer = null;
  }
  if (!dragState) {
    pointerCandidate = null;
    clearPressCursor();
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  finishDrag(true);
}

function cancelPointerCandidate(event?: PointerEvent): void {
  if (event && pointerCandidate && pointerCandidate.pointerId !== event.pointerId) return;
  if (pointerCandidate?.longPressTimer != null) {
    window.clearTimeout(pointerCandidate.longPressTimer);
    pointerCandidate.longPressTimer = null;
  }
  if (!dragState) {
    pointerCandidate = null;
    clearPressCursor();
    return;
  }
  // Android WebView often fires pointercancel at the top overscroll edge
  // without ending the gesture. Keep the drag alive if touchmove continues.
  if (dragState && (event?.pointerType === "touch" || event?.pointerType === "pen")) {
    return;
  }
  finishDrag(false);
}

function onTouchMove(event: TouchEvent): void {
  if (!pointerCandidate && !dragState) return;
  const touch = event.touches[0];
  if (!touch) return;
  dragTouchActive = true;

  if (dragState) {
    if (event.cancelable) {
      event.preventDefault();
    }
    dragState.lastClientX = touch.clientX;
    dragState.lastClientY = touch.clientY;
    updateFloatingSource(dragState);
    updatePlaceholderFromPointer(dragState);
    return;
  }

  if (pointerCandidate) {
    pointerCandidate.currentX = touch.clientX;
    pointerCandidate.currentY = touch.clientY;
    const distance = Math.hypot(
      touch.clientX - pointerCandidate.startX,
      touch.clientY - pointerCandidate.startY,
    );
    if (distance > TOUCH_CANCEL_MOVE_PX) {
      if (pointerCandidate.longPressTimer != null) {
        window.clearTimeout(pointerCandidate.longPressTimer);
        pointerCandidate.longPressTimer = null;
      }
      pointerCandidate = null;
    }
  }
}

function onTouchEnd(event: TouchEvent): void {
  if (pointerCandidate?.longPressTimer != null) {
    window.clearTimeout(pointerCandidate.longPressTimer);
    pointerCandidate.longPressTimer = null;
  }
  if (event.touches.length === 0) dragTouchActive = false;
  if (dragState) {
    if (event.cancelable) {
      event.preventDefault();
    }
    event.stopPropagation();
    finishDrag(true);
  } else {
    pointerCandidate = null;
  }
}

function onTouchCancel(event: TouchEvent): void {
  if (pointerCandidate?.longPressTimer != null) {
    window.clearTimeout(pointerCandidate.longPressTimer);
    pointerCandidate.longPressTimer = null;
  }
  if (dragState) {
    if (event.touches.length > 0) return;
    dragTouchActive = false;
    // Adding touch-action:none when the drag starts can emit a synthetic
    // cancel; ignore that so a long-press does not immediately drop the card.
    if (Date.now() - dragStartedAt < 250) return;
    scheduleAbandonedDragFinish();
    return;
  }
  pointerCandidate = null;
}

export async function persistGroupOrder(orderedGroupIds: string[]): Promise<void> {
  try {
    const snapshot = await bridgeApi.snapshot();
    const accounts = snapshot.accounts;
    const buckets = snapshot.buckets ?? [];

    const orderedAccountIds: string[] = [];
    const assignedAccountIds = new Set<string>();

    for (const groupId of orderedGroupIds) {
      if (groupId === "all") continue;
      if (groupId.startsWith("bucket:")) {
        const bucketId = groupId.slice(7);
        const bucket = buckets.find((b) => b.id === bucketId);
        if (bucket) {
          for (const accId of bucket.accountIds) {
            if (!assignedAccountIds.has(accId)) {
              assignedAccountIds.add(accId);
              orderedAccountIds.push(accId);
            }
          }
        }
      } else if (groupId.startsWith("provider:")) {
        const providerStr = groupId.slice(9);
        const providerAccounts = accounts.filter(
          (acc) => acc.provider === providerStr && !assignedAccountIds.has(acc.id),
        );
        for (const acc of providerAccounts) {
          if (!assignedAccountIds.has(acc.id)) {
            assignedAccountIds.add(acc.id);
            orderedAccountIds.push(acc.id);
          }
        }
      }
    }

    for (const acc of accounts) {
      if (!assignedAccountIds.has(acc.id)) {
        assignedAccountIds.add(acc.id);
        orderedAccountIds.push(acc.id);
      }
    }

    if (orderedAccountIds.length === accounts.length) {
      await bridgeApi.reorderAccounts(orderedAccountIds);
    }
  } catch (cause) {
    logIgnored("dashboard-reorder persist", cause);
  }
  // Either way, have the app re-read the saved state so the screen matches it.
  requestDashboardResync();
}

export async function persistVisibleAccountOrder(orderedVisibleIds: string[], groupId: string | null): Promise<void> {
  const pageId = groupId && groupId.length > 0 ? groupId : "all";
  storePageAccountOrder(pageId, orderedVisibleIds);

  try {
    if (pageId === "all") {
      await bridgeApi.reorderAccounts(orderedVisibleIds);
    } else if (pageId.startsWith("bucket:")) {
      const snapshot = getLatestSnapshot() ?? await bridgeApi.snapshot();
      const bucket = (snapshot.buckets ?? []).find((candidate) => candidate.id === pageId.slice(7));
      if (bucket) {
        const visible = new Set(orderedVisibleIds);
        const nextAccountIds = [...orderedVisibleIds, ...bucket.accountIds.filter((id) => !visible.has(id))];
        await bridgeApi.saveBucket(bucket.name, bucket.provider, nextAccountIds, bucket.id);
      }
    }
  } catch (cause) {
    logIgnored("dashboard-reorder persist", cause);
  }
  requestDashboardResync();
}

/**
 * Installs the pointer/touch gesture handlers for drag-to-reorder on account
 * cards and sidebar groups. Ordering itself is owned by React; this only runs
 * the gesture and reports the resulting order. Returns an uninstall function.
 */
export function installDashboardReorder(): () => void {
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape" && dragState) {
      event.preventDefault();
      cancelPointerCandidate();
    }
  };
  const onClickCapture = (event: MouseEvent) => {
    // Swallow the click that a drop would otherwise register on the dropped item.
    if (Date.now() - lastDropAt > 600) return;
    const target = event.target as HTMLElement | null;
    if (!target?.closest(".provider-summary-row, .provider-account-card")) return;
    event.preventDefault();
    event.stopPropagation();
  };
  const onContextMenu = (event: Event) => {
    if (dragState || Date.now() - lastDropAt < 500) event.preventDefault();
  };
  const onBlur = () => cancelPointerCandidate();

  document.addEventListener("pointerdown", beginPointerCandidate, true);
  document.addEventListener("pointermove", movePointerCandidate, { capture: true, passive: false });
  document.addEventListener("pointerup", endPointerCandidate, { capture: true, passive: false });
  document.addEventListener("pointercancel", cancelPointerCandidate, true);
  document.addEventListener("touchmove", onTouchMove, { capture: true, passive: false });
  document.addEventListener("touchend", onTouchEnd, { capture: true, passive: false });
  document.addEventListener("touchcancel", onTouchCancel, { capture: true, passive: false });
  window.addEventListener("blur", onBlur);
  document.addEventListener("keydown", onKeyDown, true);
  document.addEventListener("click", onClickCapture, true);
  document.addEventListener("contextmenu", onContextMenu, true);

  return () => {
    document.removeEventListener("pointerdown", beginPointerCandidate, true);
    document.removeEventListener("pointermove", movePointerCandidate, true);
    document.removeEventListener("pointerup", endPointerCandidate, true);
    document.removeEventListener("pointercancel", cancelPointerCandidate, true);
    document.removeEventListener("touchmove", onTouchMove, true);
    document.removeEventListener("touchend", onTouchEnd, true);
    document.removeEventListener("touchcancel", onTouchCancel, true);
    window.removeEventListener("blur", onBlur);
    document.removeEventListener("keydown", onKeyDown, true);
    document.removeEventListener("click", onClickCapture, true);
    document.removeEventListener("contextmenu", onContextMenu, true);
  };
}

import { arraysEqual, committedOrder, dragFromPointerTarget, isInteractivePointerTarget } from "./dom";
import { beginReordering, DROP_COOLDOWN_MS, droppedWithin, endReordering } from "../../shared/lib/reorder-activity";
import { persistGroupOrder, persistVisibleAccountOrder } from "./persist";
import { clearDragArtifacts, enterDragVisuals, moveFloat, prepareDrag, settleVisualDrag, updatePlaceholderFromPointer } from "./preview";
import { storeSidebarGroupOrder } from "../dashboard/sidebar-order";
import type { ActiveDrag, PointerCandidate } from "./types";

const DRAG_THRESHOLD_PX = 5;
const TOUCH_CANCEL_MOVE_PX = 8;
const LONG_PRESS_DELAY_MS = 350;
// After a touch is cancelled, a drag with no further movement for this long is finished. A cancel
// right after the drag starts can be a synthetic one (the touch carries on and the next move
// cancels this), but a real cancel is never followed by touchend, so the drag must not wait forever.
const EARLY_CANCEL_GRACE_MS = 1200;
// A new gesture starting this long after a drag began means that drag ended without us seeing it.
const STALE_DRAG_MS = 300;

let pointerCandidate: PointerCandidate | null = null;
let dragState: ActiveDrag | null = null;
let lastDragMoveAt = 0;
let dragStartedAt = 0;
let abandonDragTimer: number | null = null;
let abandonDragGeneration = 0;

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

/** Registers the drag, then puts it on screen (see `prepareDrag` / `enterDragVisuals`). */
function beginVisualDrag(clientX: number, clientY: number, candidate: PointerCandidate): ActiveDrag | null {
  const drag = prepareDrag(clientX, clientY, candidate);
  if (!drag) return null;
  dragState = drag;
  beginReordering();
  lastDragMoveAt = Date.now();
  dragStartedAt = Date.now();
  enterDragVisuals(drag, candidate.pointerType, () => dragState === drag);
  return drag;
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

function scheduleAbandonedDragFinish(delayMs = 180): void {
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
  }, delayMs);
}

function updateFloatingSource(drag: ActiveDrag): void {
  noteDragMove();
  moveFloat(drag);
}

function finishDrag(commit: boolean): void {
  clearAbandonedDragTimer();
  const drag = dragState;
  pointerCandidate = null;
  if (!drag) return;

  // Clear the drag state first so a failure while putting the card back can never leave
  // the gesture half-finished (source hidden, drag still "active").
  dragState = null;
  endReordering();
  try {
    settleVisualDrag(drag, commit);
  } finally {
    clearDragArtifacts();
  }
  const nextOrder = commit ? committedOrder(drag) : drag.originalOrder;

  if (!commit || arraysEqual(drag.originalOrder, nextOrder)) {
    return;
  }

  if (drag.descriptor.kind === "group") {
    storeSidebarGroupOrder(nextOrder);
    void persistGroupOrder(nextOrder);
  } else {
    void persistVisibleAccountOrder(nextOrder, drag.container.dataset.groupId ?? null);
  }
}

function beginPointerCandidate(event: PointerEvent): void {
  if (event.button !== 0 || event.isPrimary === false) return;
  // Only one primary pointer can be down at a time, so a new one means the previous drag already
  // ended and its end was never delivered (touch cancelled, release outside the window). Finish
  // it first, otherwise it blocks every later gesture and leaves its card hidden.
  if (dragState && Date.now() - dragStartedAt > STALE_DRAG_MS) finishDrag(true);
  if (dragState) return;
  clearDragArtifacts();
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return;
  const drag = dragFromPointerTarget(target);
  if (!drag) return;

  if (pointerCandidate?.longPressTimer != null) {
    window.clearTimeout(pointerCandidate.longPressTimer);
  }

  const isTouch = event.pointerType === "touch" || event.pointerType === "pen";
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

  // A mouse move with no button held means the button was released where the page never saw
  // pointerup (outside the window, over a native region). Drop the card where it is.
  if (event.pointerType === "mouse" && event.buttons === 0) {
    if (dragState) {
      finishDrag(true);
    } else {
      if (pointerCandidate.longPressTimer != null) window.clearTimeout(pointerCandidate.longPressTimer);
      pointerCandidate = null;
      clearPressCursor();
    }
    return;
  }

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
    // Adding touch-action:none when the drag starts can emit a synthetic cancel, so a cancel this
    // early gets a longer grace period (any further movement cancels the timer). Ignoring it
    // outright left the drag stuck with the card hidden whenever the cancel was real.
    scheduleAbandonedDragFinish(Date.now() - dragStartedAt < 250 ? EARLY_CANCEL_GRACE_MS : 180);
    return;
  }
  pointerCandidate = null;
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
    if (!droppedWithin(DROP_COOLDOWN_MS)) return;
    const target = event.target as HTMLElement | null;
    if (!target?.closest(".provider-summary-row, .provider-account-card")) return;
    event.preventDefault();
    event.stopPropagation();
  };
  const onContextMenu = (event: Event) => {
    if (dragState || droppedWithin(499)) event.preventDefault();
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

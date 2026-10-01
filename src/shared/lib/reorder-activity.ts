/**
 * Whether a drag-to-reorder is in progress. Other parts of the UI (the clock, the dashboard
 * poll, the sidebar's click handling) hold still while this is true, so they ask this small
 * module instead of reaching into the gesture engine.
 *
 * It stays true for a short cooldown after a drop, long enough to swallow the click the
 * browser fires on the dropped item and to let the saved order settle.
 */

export const DROP_COOLDOWN_MS = 600;

type Listener = (active: boolean) => void;

let dragging = false;
let lastDropAt = 0;
let cooldownTimer: number | undefined;
let lastNotified = false;
const listeners = new Set<Listener>();

export function isReordering(): boolean {
  return dragging || Date.now() - lastDropAt < DROP_COOLDOWN_MS;
}

/** True during the cooldown after a drop (and false while the drag itself is still running). */
export function droppedWithin(ms: number): boolean {
  return Date.now() - lastDropAt <= ms;
}

function notifyIfChanged(): void {
  const active = isReordering();
  if (active === lastNotified) return;
  lastNotified = active;
  for (const listener of [...listeners]) listener(active);
}

export function beginReordering(): void {
  window.clearTimeout(cooldownTimer);
  dragging = true;
  notifyIfChanged();
}

export function endReordering(): void {
  dragging = false;
  lastDropAt = Date.now();
  window.clearTimeout(cooldownTimer);
  // Subscribers hear that reordering is over only once the cooldown has passed.
  cooldownTimer = window.setTimeout(notifyIfChanged, DROP_COOLDOWN_MS + 1);
  notifyIfChanged();
}

/** Calls `listener(true)` when a reorder starts and `listener(false)` when it has fully ended. */
export function subscribeReordering(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** For tests: forget any previous drag. */
export function resetReorderingForTests(): void {
  window.clearTimeout(cooldownTimer);
  dragging = false;
  lastDropAt = 0;
  lastNotified = false;
  listeners.clear();
}

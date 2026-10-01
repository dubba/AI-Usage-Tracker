import { useSyncExternalStore } from "react";
import { isReordering } from "../reorder/active";

const TICK_MS = 1000;

let now = Date.now();
let timer: number | undefined;
const listeners = new Set<() => void>();

function tick(): void {
  // Keep the screen still while an item is being dragged.
  if (isReordering()) return;
  now = Date.now();
  for (const listener of [...listeners]) listener();
}

/**
 * With no subscribers the stored time is not being refreshed, so read the real
 * one (floored to the second so two reads in one render agree).
 */
function currentTime(): number {
  return listeners.size > 0 ? now : Math.floor(Date.now() / 1000) * 1000;
}

function subscribe(listener: () => void): () => void {
  if (listeners.size === 0) {
    now = Date.now();
    timer = window.setInterval(tick, TICK_MS);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) window.clearInterval(timer);
  };
}

/**
 * One shared once-a-second clock. A component passes `select`, which turns the
 * current time into what it displays (a countdown label, a tone, …), and only
 * re-renders when that value actually changes. Most seconds change nothing, so
 * the countdowns on screen update without re-rendering the dashboard.
 *
 * `select` must return a primitive (string, number, boolean).
 */
export function useClock<T extends string | number | boolean | null>(select: (nowMs: number) => T): T {
  return useSyncExternalStore(
    subscribe,
    () => select(currentTime()),
    () => select(Date.now()),
  );
}

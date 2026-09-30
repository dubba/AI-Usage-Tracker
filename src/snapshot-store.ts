import type { DashboardSnapshot } from "./types";

/**
 * The app loads the dashboard snapshot in one place and publishes each result
 * here, so DOM-level helpers (drag-to-reorder) read it instead of calling the
 * backend themselves.
 */
let latest: DashboardSnapshot | null = null;
const listeners = new Set<(snapshot: DashboardSnapshot) => void>();

export function publishSnapshot(snapshot: DashboardSnapshot): void {
  latest = snapshot;
  for (const listener of [...listeners]) listener(snapshot);
}

export function getLatestSnapshot(): DashboardSnapshot | null {
  return latest;
}

export function onSnapshot(listener: (snapshot: DashboardSnapshot) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

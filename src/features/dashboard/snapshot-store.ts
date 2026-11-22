import type { DashboardSnapshot } from "../../types";

/**
 * The app loads the dashboard snapshot in one place and publishes each result
 * here, so DOM-level helpers (drag-to-reorder) read it instead of calling the
 * backend themselves.
 */
let latest: DashboardSnapshot | null = null;

export function publishSnapshot(snapshot: DashboardSnapshot): void {
  latest = snapshot;
}

export function getLatestSnapshot(): DashboardSnapshot | null {
  return latest;
}

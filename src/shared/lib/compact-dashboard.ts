import { createPreferenceStore } from "./preference-store";
import { STORAGE_KEYS } from "./storage";

/** Whether Dashboard account cards shrink into slim single-row summaries ("on") or show full details ("off"). */
export type CompactDashboardMode = "on" | "off";

const DEFAULT_MODE: CompactDashboardMode = "off";

export function isCompactDashboardMode(value: unknown): value is CompactDashboardMode {
  return value === "on" || value === "off";
}

const store = createPreferenceStore<CompactDashboardMode>(
  STORAGE_KEYS.compactDashboard,
  DEFAULT_MODE,
  isCompactDashboardMode,
);
store.refresh();

export const getCompactDashboardMode = store.get;
export const subscribeCompactDashboardMode = store.subscribe;
export const setCompactDashboardMode = store.set;

if (typeof window !== "undefined") {
  // Keeps the app's other windows in step when the choice changes in one of them.
  store.followOtherWindows();
}

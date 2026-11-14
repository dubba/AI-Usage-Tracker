import { createPreferenceStore } from "./preference-store";
import { STORAGE_KEYS } from "./storage";

/** Whether the bottom navigation bar shows the page names under its icons ("on") or icons only. */
export type BottomNavLabels = "on" | "off";

function isBottomNavLabels(value: unknown): value is BottomNavLabels {
  return value === "on" || value === "off";
}

const store = createPreferenceStore<BottomNavLabels>(STORAGE_KEYS.bottomNavLabels, "on", isBottomNavLabels);
store.refresh();

export const getBottomNavLabels = store.get;
export const subscribeBottomNavLabels = store.subscribe;
export const setBottomNavLabels = store.set;

if (typeof window !== "undefined") {
  // Keeps the app's other windows in step when the choice changes in one of them.
  store.followOtherWindows();
}

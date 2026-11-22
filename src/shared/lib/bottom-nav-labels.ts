import { createSharedPreference, isOnOff } from "./preference-store";
import { STORAGE_KEYS } from "./storage";

/** Whether the bottom navigation bar shows the page names under its icons ("on") or icons only. */
const store = createSharedPreference(STORAGE_KEYS.bottomNavLabels, "on", isOnOff);

export const isBottomNavLabels = isOnOff;
export const getBottomNavLabels = store.get;
export const subscribeBottomNavLabels = store.subscribe;
export const setBottomNavLabels = store.set;

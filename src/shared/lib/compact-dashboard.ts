import { createSharedPreference, isOnOff } from "./preference-store";
import { STORAGE_KEYS } from "./storage";

/** Whether Dashboard account cards shrink into slim single-row summaries ("on") or show full details ("off"). */
const store = createSharedPreference(STORAGE_KEYS.compactDashboard, "off", isOnOff);

export const isCompactDashboardMode = isOnOff;
export const getCompactDashboardMode = store.get;
export const subscribeCompactDashboardMode = store.subscribe;
export const setCompactDashboardMode = store.set;

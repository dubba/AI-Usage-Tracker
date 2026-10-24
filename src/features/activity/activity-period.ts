import { createPreferenceStore } from "../../shared/lib/preference-store";
import { STORAGE_KEYS } from "../../shared/lib/storage";

/** How far back the Activity page looks: the last 7 or the last 30 days, today included. */
export type ActivityPeriod = "7d" | "30d";

export const ACTIVITY_PERIODS: readonly ActivityPeriod[] = ["7d", "30d"];

export const ACTIVITY_PERIOD_DAYS: Record<ActivityPeriod, number> = { "7d": 7, "30d": 30 };

export function isActivityPeriod(value: unknown): value is ActivityPeriod {
  return value === "7d" || value === "30d";
}

const store = createPreferenceStore<ActivityPeriod>(STORAGE_KEYS.activityPeriod, "7d", isActivityPeriod);
store.refresh();

export const getActivityPeriod = store.get;
export const subscribeActivityPeriod = store.subscribe;
export const setActivityPeriod = store.set;
/** Re-reads the saved choice (tests, and a choice saved before the page first showed). */
export const refreshActivityPeriod = store.refresh;

if (typeof window !== "undefined") {
  // Keeps the app's other windows in step when the choice changes in one of them.
  store.followOtherWindows();
}

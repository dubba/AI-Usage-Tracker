import { createPreferenceStore } from "./preference-store";
import { STORAGE_KEYS } from "./storage";

/** "left" shows the quota remaining, "used" shows the quota already consumed. */
export type UsageDisplayMode = "left" | "used";

export const USAGE_DISPLAY_MODES: readonly UsageDisplayMode[] = ["left", "used"];

const DEFAULT_MODE: UsageDisplayMode = "left";

export function isUsageDisplayMode(value: unknown): value is UsageDisplayMode {
  return value === "left" || value === "used";
}

/** The percentage to show for a window, given the provider-reported percent remaining. */
export function displayPercent(remaining: number, mode: UsageDisplayMode): number {
  return mode === "used" ? 100 - remaining : remaining;
}

export function usageDisplaySuffix(mode: UsageDisplayMode): string {
  return mode === "used" ? "used" : "left";
}

const store = createPreferenceStore<UsageDisplayMode>(STORAGE_KEYS.usageDisplayMode, DEFAULT_MODE, isUsageDisplayMode);
store.refresh();

export const getUsageDisplayMode = store.get;
export const subscribeUsageDisplayMode = store.subscribe;
export const setUsageDisplayMode = store.set;

if (typeof window !== "undefined") {
  // Keeps the app's other windows in step when the choice changes in one of them.
  store.followOtherWindows();
}

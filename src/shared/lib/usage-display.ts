import { createSharedPreference } from "./preference-store";
import { STORAGE_KEYS } from "./storage";

/** "left" shows the quota remaining, "used" shows the quota already consumed. */
export type UsageDisplayMode = "left" | "used";

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

const store = createSharedPreference<UsageDisplayMode>(STORAGE_KEYS.usageDisplayMode, DEFAULT_MODE, isUsageDisplayMode);

export const getUsageDisplayMode = store.get;
export const subscribeUsageDisplayMode = store.subscribe;
export const setUsageDisplayMode = store.set;

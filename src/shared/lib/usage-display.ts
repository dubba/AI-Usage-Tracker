import { STORAGE_KEYS, storageGet, storageSet } from "./storage";

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

let mode: UsageDisplayMode = readMode();
const listeners = new Set<() => void>();

function readMode(): UsageDisplayMode {
  const saved = storageGet(STORAGE_KEYS.usageDisplayMode);
  return isUsageDisplayMode(saved) ? saved : DEFAULT_MODE;
}

function setMode(next: UsageDisplayMode): void {
  if (next === mode) return;
  mode = next;
  listeners.forEach((notify) => notify());
}

export function getUsageDisplayMode(): UsageDisplayMode {
  return mode;
}

export function subscribeUsageDisplayMode(notify: () => void): () => void {
  listeners.add(notify);
  return () => listeners.delete(notify);
}

export function setUsageDisplayMode(next: UsageDisplayMode): void {
  storageSet(STORAGE_KEYS.usageDisplayMode, next);
  setMode(next);
}

if (typeof window !== "undefined") {
  // Keeps the app's other windows in step when the choice changes in one of them.
  window.addEventListener("storage", (event) => {
    if (event.key === STORAGE_KEYS.usageDisplayMode) setMode(readMode());
  });
}

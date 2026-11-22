import { useSyncExternalStore } from "react";
import { getBottomNavLabels, setBottomNavLabels, subscribeBottomNavLabels } from "../lib/bottom-nav-labels";
import { getCompactDashboardMode, setCompactDashboardMode, subscribeCompactDashboardMode } from "../lib/compact-dashboard";
import { getThemePreference, setThemePreference, subscribeThemePreference, type ThemePreference } from "../lib/theme";
import { getUsageDisplayMode, setUsageDisplayMode, subscribeUsageDisplayMode, type UsageDisplayMode } from "../lib/usage-display";

// Hooks for the saved UI preferences: each returns the current value and a setter that saves it.

const useStoreValue = <T,>(subscribe: (notify: () => void) => () => void, get: () => T): T =>
  useSyncExternalStore(subscribe, get, get);

export function useThemePreference(): [ThemePreference, (next: ThemePreference) => void] {
  return [useStoreValue(subscribeThemePreference, getThemePreference), setThemePreference];
}

export function useUsageDisplayMode(): [UsageDisplayMode, (next: UsageDisplayMode) => void] {
  return [useStoreValue(subscribeUsageDisplayMode, getUsageDisplayMode), setUsageDisplayMode];
}

/** Whether Dashboard account cards render as compact rows. */
export function useCompactDashboard(): [boolean, (compact: boolean) => void] {
  const mode = useStoreValue(subscribeCompactDashboardMode, getCompactDashboardMode);
  return [mode === "on", (compact) => setCompactDashboardMode(compact ? "on" : "off")];
}

/** Whether the bottom navigation bar shows its page names. */
export function useBottomNavLabels(): [boolean, (show: boolean) => void] {
  const labels = useStoreValue(subscribeBottomNavLabels, getBottomNavLabels);
  return [labels === "on", (show) => setBottomNavLabels(show ? "on" : "off")];
}

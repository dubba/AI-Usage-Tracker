import { useSyncExternalStore } from "react";
import { getAccentColor, setAccentColor, subscribeAccentColor } from "../lib/accent-color";
import { getBottomNavLabels, setBottomNavLabels, subscribeBottomNavLabels } from "../lib/bottom-nav-labels";
import { getCompactDashboardMode, setCompactDashboardMode, subscribeCompactDashboardMode } from "../lib/compact-dashboard";
import { getSyncOtherWays, setSyncOtherWays, subscribeSyncOtherWays } from "../lib/sync-other-ways";
import { getThemePreference, setThemePreference, subscribeThemePreference, type ThemePreference } from "../lib/theme";
import { getUsageDisplayMode, setUsageDisplayMode, subscribeUsageDisplayMode, type UsageDisplayMode } from "../lib/usage-display";

// Hooks for the saved UI preferences: each returns the current value and a setter that saves it.

const useStoreValue = <T,>(subscribe: (notify: () => void) => () => void, get: () => T): T =>
  useSyncExternalStore(subscribe, get, get);

export function useThemePreference(): [ThemePreference, (next: ThemePreference) => void] {
  return [useStoreValue(subscribeThemePreference, getThemePreference), setThemePreference];
}

export function useAccentColor(): [string, (next: string) => void] {
  return [useStoreValue(subscribeAccentColor, getAccentColor), setAccentColor];
}

export function useUsageDisplayMode(): [UsageDisplayMode, (next: UsageDisplayMode) => void] {
  return [useStoreValue(subscribeUsageDisplayMode, getUsageDisplayMode), setUsageDisplayMode];
}

/** Whether Dashboard account cards render as compact rows. */
export function useCompactDashboard(): [boolean, (compact: boolean) => void] {
  const mode = useStoreValue(subscribeCompactDashboardMode, getCompactDashboardMode);
  return [mode === "on", (compact) => setCompactDashboardMode(compact ? "on" : "off")];
}

/** Whether Sync Devices shows its "Other ways to connect" link. */
export function useSyncOtherWays(): [boolean, (show: boolean) => void] {
  const shown = useStoreValue(subscribeSyncOtherWays, getSyncOtherWays);
  return [shown === "on", (show) => setSyncOtherWays(show ? "on" : "off")];
}

/** Whether the bottom navigation bar shows its page names. */
export function useBottomNavLabels(): [boolean, (show: boolean) => void] {
  const labels = useStoreValue(subscribeBottomNavLabels, getBottomNavLabels);
  return [labels === "on", (show) => setBottomNavLabels(show ? "on" : "off")];
}

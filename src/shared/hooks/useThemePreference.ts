import { useSyncExternalStore } from "react";
import {
  getThemePreference,
  setThemePreference,
  subscribeThemePreference,
  type ThemePreference,
} from "../lib/theme";

export function useThemePreference(): [ThemePreference, (next: ThemePreference) => void] {
  const preference = useSyncExternalStore(subscribeThemePreference, getThemePreference, getThemePreference);
  return [preference, setThemePreference];
}

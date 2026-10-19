import { createContext, useContext } from "react";
import type { useAppSettings } from "./useAppSettings";
import type { useAppUpdate } from "./useAppUpdate";

export type AppSettingsState = ReturnType<typeof useAppSettings>;
export type AppUpdateState = ReturnType<typeof useAppUpdate>;

/**
 * App-wide settings and update state. `App` runs both hooks once, because the dashboard, the
 * pairing dialog and the update-notes dialog use them whether or not the Settings page is open;
 * the Settings page reads them from here instead of through a long list of props.
 */
export const AppSettingsContext = createContext<AppSettingsState | null>(null);
export const AppUpdateContext = createContext<AppUpdateState | null>(null);

export function useAppSettingsState(): AppSettingsState {
  const value = useContext(AppSettingsContext);
  if (!value) throw new Error("useAppSettingsState needs an AppSettingsContext provider.");
  return value;
}

export function useAppUpdateState(): AppUpdateState {
  const value = useContext(AppUpdateContext);
  if (!value) throw new Error("useAppUpdateState needs an AppUpdateContext provider.");
  return value;
}

import { useCallback, useEffect, useState } from "react";
import { bridgeApi } from "../../shared/lib/api";
import { logIgnored } from "../../shared/lib/log";
import type { AppSettings } from "../../types";

type ReportError = (source: string, cause: unknown, context?: string) => void;

export function useAppSettings({ reportError, clearError }: { reportError: ReportError; clearError: (source: string) => void }) {
  const [appSettings, setAppSettings] = useState<AppSettings | null>(null);
  const [autostart, setAutostart] = useState(false);
  /** Which setting is mid-save, so only that control disables while the request is in flight. */
  const [settingsBusyKey, setSettingsBusyKey] = useState<string | null>(null);

  useEffect(() => {
    bridgeApi.getAppSettings().then(setAppSettings).catch((cause) => reportError("settings", cause, "Couldn't load app settings"));
    bridgeApi.getAutostart().then(setAutostart).catch((cause) => {
      // Unknown state; show it as off rather than blocking the settings screen.
      logIgnored("autostart status", cause);
      setAutostart(false);
    });
  }, [reportError]);

  /** Re-reads settings that may have been imported via device pairing. */
  const reloadFromBackend = useCallback(async () => {
    try {
      setAppSettings(await bridgeApi.getAppSettings());
      clearError("settings");
    } catch (cause) {
      reportError("settings", cause, "Couldn't reload settings after linking devices");
    }
    try {
      setAutostart(await bridgeApi.getAutostart());
    } catch (cause) {
      logIgnored("autostart status", cause);
    }
  }, [clearError, reportError]);

  const saveAccountRefreshMinutes = useCallback(async (minutes: number) => {
    setSettingsBusyKey("refresh");
    try {
      setAppSettings(await bridgeApi.setAccountRefreshMinutes(minutes));
      clearError("settings");
    } catch (cause) {
      reportError("settings", cause, "Couldn't save the refresh interval");
    } finally {
      setSettingsBusyKey(null);
    }
  }, [clearError, reportError]);

  const saveAutomaticUpdatesEnabled = useCallback(async (enabled: boolean) => {
    setSettingsBusyKey("automatic");
    try {
      setAppSettings(await bridgeApi.setAutomaticUpdatesEnabled(enabled));
      clearError("settings");
    } catch (cause) {
      reportError("settings", cause, "Couldn't save the automatic updates setting");
    } finally {
      setSettingsBusyKey(null);
    }
  }, [clearError, reportError]);

  const saveIncludeBetaUpdates = useCallback(async (enabled: boolean) => {
    setSettingsBusyKey("beta");
    try {
      setAppSettings(await bridgeApi.setIncludeBetaUpdates(enabled));
      clearError("settings");
    } catch (cause) {
      reportError("settings", cause, "Couldn't save the beta updates setting");
    } finally {
      setSettingsBusyKey(null);
    }
  }, [clearError, reportError]);

  const toggleAutostart = useCallback(async () => {
    try {
      setAutostart(await bridgeApi.setAutostart(!autostart));
      clearError("autostart");
    } catch (cause) {
      reportError("autostart", cause, "Couldn't change the start-at-login setting");
    }
  }, [autostart, clearError, reportError]);

  return {
    appSettings,
    autostart,
    settingsBusy: settingsBusyKey !== null,
    refreshIntervalBusy: settingsBusyKey === "refresh",
    automaticUpdatesBusy: settingsBusyKey === "automatic",
    includeBetaUpdatesBusy: settingsBusyKey === "beta",
    reloadFromBackend,
    saveAccountRefreshMinutes,
    saveAutomaticUpdatesEnabled,
    saveIncludeBetaUpdates,
    toggleAutostart,
  };
}

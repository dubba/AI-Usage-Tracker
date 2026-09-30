import { useCallback, useEffect, useState } from "react";
import { bridgeApi } from "../api";
import { logIgnored } from "../log";
import type { AppSettings } from "../types";

type ReportError = (source: string, cause: unknown, context?: string) => void;

export function useAppSettings({ reportError, clearError }: { reportError: ReportError; clearError: (source: string) => void }) {
  const [appSettings, setAppSettings] = useState<AppSettings | null>(null);
  const [autostart, setAutostart] = useState(false);
  const [settingsBusy, setSettingsBusy] = useState(false);

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
    setSettingsBusy(true);
    try {
      setAppSettings(await bridgeApi.setAccountRefreshMinutes(minutes));
      clearError("settings");
    } catch (cause) {
      reportError("settings", cause, "Couldn't save the refresh interval");
    } finally {
      setSettingsBusy(false);
    }
  }, [clearError, reportError]);

  const saveAutomaticUpdatesEnabled = useCallback(async (enabled: boolean) => {
    setSettingsBusy(true);
    try {
      setAppSettings(await bridgeApi.setAutomaticUpdatesEnabled(enabled));
      clearError("settings");
    } catch (cause) {
      reportError("settings", cause, "Couldn't save the automatic updates setting");
    } finally {
      setSettingsBusy(false);
    }
  }, [clearError, reportError]);

  const saveIncludeBetaUpdates = useCallback(async (enabled: boolean) => {
    setSettingsBusy(true);
    try {
      setAppSettings(await bridgeApi.setIncludeBetaUpdates(enabled));
      clearError("settings");
    } catch (cause) {
      reportError("settings", cause, "Couldn't save the beta updates setting");
    } finally {
      setSettingsBusy(false);
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
    settingsBusy,
    reloadFromBackend,
    saveAccountRefreshMinutes,
    saveAutomaticUpdatesEnabled,
    saveIncludeBetaUpdates,
    toggleAutostart,
  };
}

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReportError } from "../../shared/lib/errors";
import { bridgeApi } from "../../shared/lib/api";
import { logIgnored } from "../../shared/lib/log";
import type { AppSettings } from "../../types";

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

  /** A save function for one setting: marks it busy, stores the settings the backend returns, reports a failure. */
  const makeSaver = useCallback(
    <Value,>(busyKey: string, save: (value: Value) => Promise<AppSettings>, errorText: string) =>
      async (value: Value) => {
        setSettingsBusyKey(busyKey);
        try {
          setAppSettings(await save(value));
          clearError("settings");
        } catch (cause) {
          reportError("settings", cause, errorText);
        } finally {
          setSettingsBusyKey(null);
        }
      },
    [clearError, reportError],
  );

  const saveAccountRefreshMinutes = useMemo(
    () => makeSaver("refresh", bridgeApi.setAccountRefreshMinutes, "Couldn't save the refresh interval"),
    [makeSaver],
  );
  const saveAutomaticUpdatesEnabled = useMemo(
    () => makeSaver("automatic", bridgeApi.setAutomaticUpdatesEnabled, "Couldn't save the automatic updates setting"),
    [makeSaver],
  );
  const saveIncludeBetaUpdates = useMemo(
    () => makeSaver("beta", bridgeApi.setIncludeBetaUpdates, "Couldn't save the beta updates setting"),
    [makeSaver],
  );

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

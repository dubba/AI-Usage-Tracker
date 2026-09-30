import { useCallback, useEffect, useRef, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { bridgeApi } from "../api";
import { FALLBACK_APP_VERSION } from "../constants";
import type { AppUpdateProgress, AppUpdateStatus, UpdateBusy } from "../types";
import { useTauriEvent } from "./useTauriEvent";

const UPDATE_CHECK_INTERVAL_MS = 8 * 60 * 60 * 1000; // 8 hours

export function useAppUpdate({ automaticUpdatesEnabled }: { automaticUpdatesEnabled: boolean | undefined }) {
  const [installedVersion, setInstalledVersion] = useState(FALLBACK_APP_VERSION);
  const [appUpdate, setAppUpdate] = useState<AppUpdateStatus | null>(null);
  const [updateBusy, setUpdateBusy] = useState<UpdateBusy>(null);
  const [updateProgress, setUpdateProgress] = useState<AppUpdateProgress | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [updateMessage, setUpdateMessage] = useState<string | null>(null);
  const updateMessageTimerRef = useRef<number | null>(null);

  const showTransientUpdateMessage = useCallback((msg: string | null) => {
    if (updateMessageTimerRef.current) {
      window.clearTimeout(updateMessageTimerRef.current);
      updateMessageTimerRef.current = null;
    }
    setUpdateMessage(msg);
    if (msg) {
      updateMessageTimerRef.current = window.setTimeout(() => {
        setUpdateMessage(null);
        updateMessageTimerRef.current = null;
      }, 5_000);
    }
  }, []);

  useEffect(() => {
    return () => {
      if (updateMessageTimerRef.current) window.clearTimeout(updateMessageTimerRef.current);
    };
  }, []);

  useEffect(() => {
    getVersion()
      .then((ver) => setInstalledVersion(ver || FALLBACK_APP_VERSION))
      .catch(() => setInstalledVersion(FALLBACK_APP_VERSION));
  }, []);

  const checkForUpdate = useCallback(async (showFeedback = false) => {
    setUpdateBusy("checking");
    const minDelayPromise = new Promise((resolve) => setTimeout(resolve, 500));
    if (showFeedback) {
      showTransientUpdateMessage(null);
      setUpdateError(null);
    }
    try {
      const [status] = await Promise.all([
        bridgeApi.checkForUpdate(),
        minDelayPromise,
      ]);
      if (status.error) {
        if (showFeedback) {
          setUpdateError(status.error);
        }
        setAppUpdate((current) => (current?.available && !showFeedback ? current : status));
        return;
      }
      setAppUpdate(status);
      if (showFeedback) {
        if (status.available && status.availableVersion) {
          showTransientUpdateMessage(`Version ${status.availableVersion} is ready to install.`);
        } else {
          showTransientUpdateMessage(`You are on the latest version (v${status.currentVersion || installedVersion}).`);
        }
      }
    } catch (cause) {
      await minDelayPromise;
      if (showFeedback) {
        setUpdateError(String(cause));
      }
    } finally {
      setUpdateBusy(null);
    }
  }, [installedVersion, showTransientUpdateMessage]);

  const installUpdate = useCallback(async () => {
    setUpdateBusy("downloading");
    setUpdateProgress({ phase: "downloading", downloaded: 0, total: null, percent: null });
    setUpdateError(null);
    try {
      await bridgeApi.installUpdate();
      setUpdateBusy(null);
      setUpdateProgress(null);
      showTransientUpdateMessage("The installer should be open. Confirm the update on the next screen.");
    } catch (cause) {
      const message = String(cause);
      setUpdateError(message);
      setUpdateBusy(null);
      setUpdateProgress(null);
    }
  }, [showTransientUpdateMessage]);

  useEffect(() => {
    // Always check once at launch so users are informed about new versions
    // even when automatic checks are disabled in Settings.
    void checkForUpdate(false);
    if (!automaticUpdatesEnabled) return;
    const updateInterval = window.setInterval(() => void checkForUpdate(false), UPDATE_CHECK_INTERVAL_MS);
    return () => window.clearInterval(updateInterval);
  }, [automaticUpdatesEnabled, checkForUpdate]);

  useTauriEvent<AppUpdateProgress>("app-update-progress", (payload) => {
    if (!payload?.phase) return;
    setUpdateBusy(payload.phase);
    setUpdateProgress(payload);
  });

  return {
    installedVersion,
    appUpdate,
    updateBusy,
    updateProgress,
    updateError,
    updateMessage,
    checkForUpdate,
    installUpdate,
  };
}

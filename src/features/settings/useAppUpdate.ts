import { useCallback, useEffect, useRef, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { bridgeApi } from "../../shared/lib/api";
import { FALLBACK_APP_VERSION } from "../../shared/lib/constants";
import { isIOS } from "../../shared/lib/platform";
import { logIgnored } from "../../shared/lib/log";
import type { AppUpdateProgress, AppUpdateStatus, UpdateBusy } from "../../types";
import { useTauriEvent } from "../../shared/hooks/useTauriEvent";

const UPDATE_CHECK_INTERVAL_MS = 8 * 60 * 60 * 1000; // 8 hours

export function useAppUpdate({ automaticUpdatesEnabled }: { automaticUpdatesEnabled: boolean | undefined }) {
  const [installedVersion, setInstalledVersion] = useState(FALLBACK_APP_VERSION);
  const [appUpdate, setAppUpdate] = useState<AppUpdateStatus | null>(null);
  const [updateBusy, setUpdateBusy] = useState<UpdateBusy>(null);
  const [updateProgress, setUpdateProgress] = useState<AppUpdateProgress | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [updateMessage, setUpdateMessage] = useState<string | null>(null);
  const updateMessageTimerRef = useRef<number | null>(null);
  // Progress events can arrive after install_app_update has already returned;
  // without this guard a late one would leave the button stuck on "Downloading…".
  const installInFlightRef = useRef(false);

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
      .catch((cause) => {
        logIgnored("app version", cause);
        setInstalledVersion(FALLBACK_APP_VERSION);
      });
  }, []);

  const checkForUpdate = useCallback(async (showFeedback = false) => {
    // A check would overwrite the busy state of a download in progress.
    if (installInFlightRef.current) return;
    setUpdateBusy("checking");
    const minDelayPromise = new Promise((resolve) => setTimeout(resolve, 500));
    if (showFeedback) {
      showTransientUpdateMessage(null);
      setUpdateError(null);
    }
    try {
      const [status] = await Promise.all([
        // Manual Check Now already shows the result next to the button, so skip
        // the OS / in-app "update available" notification on that path.
        bridgeApi.checkForUpdate(!showFeedback),
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
      if (showFeedback && !(status.available && status.availableVersion)) {
        showTransientUpdateMessage(`You are on the latest version (v${status.currentVersion || installedVersion}).`);
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
    if (installInFlightRef.current) return;
    installInFlightRef.current = true;
    setUpdateBusy("downloading");
    setUpdateProgress({ phase: "downloading", downloaded: 0, total: null, percent: 0 });
    setUpdateError(null);
    try {
      await bridgeApi.installUpdate();
      setUpdateBusy(null);
      setUpdateProgress(null);
      if (isIOS()) {
        showTransientUpdateMessage("Open SideStore to install the latest update.");
      } else {
        showTransientUpdateMessage("The installer should be open. Confirm the update on the next screen.");
      }
    } catch (cause) {
      const message = String(cause);
      setUpdateError(message);
      setUpdateBusy(null);
      setUpdateProgress(null);
    } finally {
      installInFlightRef.current = false;
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
    if (!payload?.phase || !installInFlightRef.current) return;
    setUpdateBusy(payload.phase);
    setUpdateProgress(payload);
  });

  const [updateNotesOpen, setUpdateNotesOpen] = useState(false);
  const [pendingUpdateVersion, setPendingUpdateVersion] = useState<string | null>(null);

  const handleUpdateNotice = useCallback(
    (version: string | null) => {
      if (!version) return;
      setPendingUpdateVersion(version);
      setUpdateNotesOpen(true);
      void checkForUpdate(false);
    },
    [checkForUpdate],
  );

  useEffect(() => {
    bridgeApi
      .getPendingUpdateNotice()
      .then((ver) => {
        if (ver) handleUpdateNotice(ver);
      })
      .catch((cause) => {
        logIgnored("pending update notice", cause);
      });
  }, [handleUpdateNotice]);

  useTauriEvent<string>("open-update-notes", (version) => {
    if (version) handleUpdateNotice(version);
  });

  useEffect(() => {
    const checkPending = () => {
      bridgeApi
        .getPendingUpdateNotice()
        .then((ver) => {
          if (ver) handleUpdateNotice(ver);
        })
        .catch((cause) => {
          logIgnored("pending update notice on focus", cause);
        });
    };
    window.addEventListener("focus", checkPending);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") checkPending();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("focus", checkPending);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [handleUpdateNotice]);

  return {
    installedVersion,
    appUpdate,
    updateBusy,
    updateProgress,
    updateError,
    updateMessage,
    updateNotesOpen,
    setUpdateNotesOpen,
    pendingUpdateVersion,
    checkForUpdate,
    installUpdate,
  };
}

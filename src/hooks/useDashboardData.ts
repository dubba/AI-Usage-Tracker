import { useCallback, useEffect, useRef, useState } from "react";
import { bridgeApi } from "../api";
import { withTimeout } from "../async-utils";
import { DEFAULT_ACCOUNT_REFRESH_MINUTES } from "../constants";
import { isReordering } from "../dashboard-reorder";
import { onDashboardResync } from "../events";
import { publishSnapshot } from "../snapshot-store";
import { accountsNeedScheduledRefresh } from "../usage-logic";
import type { DashboardSnapshot } from "../types";

const DASHBOARD_SYNC_INTERVAL_MS = 30 * 1000;
const STARTUP_REFRESH_DELAY_MS = 3 * 1000;
const LOAD_TIMEOUT_MS = 10_000;

type ReportError = (source: string, cause: unknown, context?: string) => void;

/** Owns the dashboard snapshot: polling, startup refresh, and refresh-when-due on return. */
export function useDashboardData({
  reportError,
  clearError,
  accountRefreshMinutes,
}: {
  reportError: ReportError;
  clearError: (source: string) => void;
  accountRefreshMinutes: number | undefined;
}) {
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null);
  const refreshDueInFlightRef = useRef(false);
  const wasHiddenRef = useRef(false);

  /** The only place the snapshot is fetched. Resolves to the snapshot, or null if it could not be loaded. */
  const load = useCallback(async (): Promise<DashboardSnapshot | null> => {
    if (isReordering()) return null;
    try {
      const next = await withTimeout(
        bridgeApi.snapshot(),
        LOAD_TIMEOUT_MS,
        "Timed out loading accounts from the app backend.",
      );
      setSnapshot(next);
      publishSnapshot(next);
      clearError("load");
      return next;
    } catch (cause) {
      reportError("load", cause);
      return null;
    }
  }, [clearError, reportError]);

  useEffect(() => {
    void load();
    const syncInterval = window.setInterval(() => void load(), DASHBOARD_SYNC_INTERVAL_MS);
    const initialRefreshTimeout = window.setTimeout(() => {
      void bridgeApi.refreshAll().then(() => load()).catch((cause) => reportError("refresh-all", cause, "Couldn't refresh accounts"));
    }, STARTUP_REFRESH_DELAY_MS);
    return () => {
      window.clearInterval(syncInterval);
      window.clearTimeout(initialRefreshTimeout);
    };
  }, [load, reportError]);

  const refreshAccountsIfDue = useCallback(async () => {
    if (refreshDueInFlightRef.current) return;
    refreshDueInFlightRef.current = true;
    try {
      const latest = await load();
      if (!latest) return;
      const minutes = accountRefreshMinutes ?? DEFAULT_ACCOUNT_REFRESH_MINUTES;
      if (!accountsNeedScheduledRefresh(latest.accounts, minutes)) return;
      await bridgeApi.refreshAll();
      await load();
      clearError("refresh-due");
    } catch (cause) {
      reportError("refresh-due", cause, "Couldn't refresh accounts");
    } finally {
      refreshDueInFlightRef.current = false;
    }
  }, [load, accountRefreshMinutes, clearError, reportError]);

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        wasHiddenRef.current = true;
        return;
      }
      if (document.visibilityState === "visible" && wasHiddenRef.current) {
        wasHiddenRef.current = false;
        void refreshAccountsIfDue();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [refreshAccountsIfDue]);

  // Something behind the scenes changed (reorder applied, paired-device layout arrived) or the window regained focus.
  useEffect(() => onDashboardResync(() => void load()), [load]);

  return { snapshot, setSnapshot, load };
}

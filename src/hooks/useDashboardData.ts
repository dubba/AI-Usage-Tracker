import { useCallback, useEffect, useRef, useState } from "react";
import { bridgeApi } from "../api";
import { isReordering } from "../dashboard-reorder";
import { accountsNeedScheduledRefresh } from "../usage-logic";
import type { DashboardSnapshot } from "../types";

const DASHBOARD_SYNC_INTERVAL_MS = 30 * 1000;
const STARTUP_REFRESH_DELAY_MS = 3 * 1000;
const DEFAULT_ACCOUNT_REFRESH_MINUTES = 15;
const RELATIVE_TIME_TICK_MS = 1000;
const LOAD_TIMEOUT_MS = 10_000;

type ReportError = (source: string, cause: unknown, context?: string) => void;

/** Owns the dashboard snapshot: polling, startup refresh, refresh-when-due on return, and the countdown clock. */
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
  const [nowMs, setNowMs] = useState(() => Date.now());
  const refreshMinutesRef = useRef(accountRefreshMinutes);
  refreshMinutesRef.current = accountRefreshMinutes;
  const refreshDueInFlightRef = useRef(false);
  const wasHiddenRef = useRef(false);

  const load = useCallback(async () => {
    if (isReordering()) return;
    let timeout: number | undefined;
    try {
      const next = await Promise.race([
        bridgeApi.snapshot(),
        new Promise<DashboardSnapshot>((_, reject) => {
          timeout = window.setTimeout(
            () => reject(new Error("Timed out loading accounts from the app backend.")),
            LOAD_TIMEOUT_MS,
          );
        }),
      ]);
      setSnapshot(next);
      clearError("load");
    } catch (cause) {
      reportError("load", cause);
    } finally {
      window.clearTimeout(timeout);
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
      const latest = await bridgeApi.snapshot();
      setSnapshot(latest);
      const minutes = refreshMinutesRef.current ?? DEFAULT_ACCOUNT_REFRESH_MINUTES;
      if (!accountsNeedScheduledRefresh(latest.accounts, minutes)) return;
      await bridgeApi.refreshAll();
      await load();
      clearError("refresh-due");
    } catch (cause) {
      reportError("refresh-due", cause, "Couldn't refresh accounts");
    } finally {
      refreshDueInFlightRef.current = false;
    }
  }, [load, clearError, reportError]);

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

  useEffect(() => {
    const tick = window.setInterval(() => {
      if (isReordering()) return;
      setNowMs(Date.now());
    }, RELATIVE_TIME_TICK_MS);
    return () => window.clearInterval(tick);
  }, []);

  return { snapshot, setSnapshot, nowMs, load };
}

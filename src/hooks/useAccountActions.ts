import { useCallback } from "react";
import { bridgeApi } from "../api";
import type { BusyTracker } from "../busy";
import { displayAccountLabel } from "../usage-logic";
import type { Account, BridgeStatus, DashboardSnapshot } from "../types";

type ReportError = (source: string, cause: unknown, context?: string) => void;

/** Per-account and bridge operations. Each one holds its own busy key and error source. */
export function useAccountActions({
  load,
  setSnapshot,
  busy,
  reportError,
  clearError,
}: {
  load: () => Promise<void>;
  setSnapshot: (update: (current: DashboardSnapshot | null) => DashboardSnapshot | null) => void;
  busy: BusyTracker;
  reportError: ReportError;
  clearError: (source: string) => void;
}) {
  const { begin, end, has } = busy;

  const refreshOne = useCallback(async (id: string) => {
    if (has("refresh-all")) return;
    const key = `refresh:${id}`;
    if (!begin(key)) return;
    try {
      await bridgeApi.refreshAccount(id);
      await load();
      clearError(key);
    } catch (cause) {
      reportError(key, cause, "Couldn't refresh account");
    } finally {
      end(key);
    }
  }, [begin, end, has, load, clearError, reportError]);

  const refreshAll = useCallback(async () => {
    if (!begin("refresh-all")) return;
    try {
      await bridgeApi.refreshAll();
      await load();
      clearError("refresh-all");
    } catch (cause) {
      reportError("refresh-all", cause, "Couldn't refresh accounts");
    } finally {
      end("refresh-all");
    }
  }, [begin, end, load, clearError, reportError]);

  // Rename failures are shown inline on the card (the card catches the rethrow).
  const rename = useCallback(async (account: Account, label: string) => {
    const trimmed = label.trim();
    if (!trimmed || trimmed === account.label) return;
    const key = `rename:${account.id}`;
    if (!begin(key)) return;
    try {
      await bridgeApi.renameAccount(account.id, trimmed);
      await load();
    } finally {
      end(key);
    }
  }, [begin, end, load]);

  /** `onStarted` runs once the removal is accepted, e.g. to close dialogs about this account. */
  const remove = useCallback(async (account: Account, onStarted?: () => void) => {
    const key = `remove:${account.id}`;
    if (has(key)) return;
    onStarted?.();
    if (!begin(key)) return;
    try {
      await bridgeApi.removeAccount(account.id);
      await load();
      clearError(key);
    } catch (cause) {
      reportError(key, cause, `Couldn't remove ${displayAccountLabel(account)}`);
    } finally {
      end(key);
    }
  }, [begin, end, has, load, clearError, reportError]);

  const setApiIntegrationEnabled = useCallback(async (enabled: boolean) => {
    if (!begin("toggle-api-integration")) return;
    try {
      const status: BridgeStatus = await bridgeApi.setApiIntegrationEnabled(enabled);
      setSnapshot((current) => current ? { ...current, bridge: status } : null);
      clearError("bridge");
    } catch (cause) {
      reportError("bridge", cause, "Couldn't change the API integration");
    } finally {
      end("toggle-api-integration");
    }
  }, [begin, end, setSnapshot, clearError, reportError]);

  const openApiIntegrationWindow = useCallback(async () => {
    if (!begin("open-api-integration")) return;
    try {
      await bridgeApi.openApiIntegrationWindow();
      clearError("bridge");
    } catch (cause) {
      reportError("bridge", cause, "Couldn't open the API integration window");
    } finally {
      end("open-api-integration");
    }
  }, [begin, end, clearError, reportError]);

  return { refreshOne, refreshAll, rename, remove, setApiIntegrationEnabled, openApiIntegrationWindow };
}

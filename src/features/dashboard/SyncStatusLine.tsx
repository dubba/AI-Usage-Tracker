import { isRefreshKey, REFRESH_ALL_KEY, type BusyKeys } from "../../shared/lib/busy";
import { useClock } from "../../shared/hooks/useClock";
import { computeSyncStatus } from "./sync-status";
import { RefreshIcon } from "../../shared/ui/icons";
import type { Account } from "../../types";

/** When the numbers on screen were last refreshed, flagging accounts that have been left behind. */
export function SyncStatusLine({
  accounts,
  refreshMinutes,
  busy,
  onRefreshAll,
}: {
  accounts: Account[];
  refreshMinutes: number;
  busy: BusyKeys;
  onRefreshAll?: () => void;
}) {
  const isGlobalRefreshing = busy.has(REFRESH_ALL_KEY);
  const syncing = [...busy].some(isRefreshKey);
  const tone = useClock((now) => computeSyncStatus(accounts, now, refreshMinutes).tone);
  const label = useClock((now) => computeSyncStatus(accounts, now, refreshMinutes).label);
  const detail = useClock((now) => computeSyncStatus(accounts, now, refreshMinutes).detail);
  return (
    <div className={`sidebar-sync-status is-${syncing ? "syncing" : tone}`}>
      {onRefreshAll ? (
        <button
          type="button"
          className={`sidebar-refresh-all-btn ${syncing ? "spinning" : ""}`}
          onClick={onRefreshAll}
          disabled={isGlobalRefreshing}
          aria-label={isGlobalRefreshing ? "Refreshing accounts…" : "Refresh all accounts"}
          data-tooltip={isGlobalRefreshing ? "Refreshing…" : "Refresh All"}
        >
          <RefreshIcon />
        </button>
      ) : null}
      <div className="sidebar-sync-status-text" role="status">
        <span className="sidebar-sync-status-label">{syncing ? "Syncing…" : label}</span>
        {!syncing && detail ? <span className="sidebar-sync-status-detail">{detail}</span> : null}
      </div>
    </div>
  );
}

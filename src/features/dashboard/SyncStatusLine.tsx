import { isRefreshKey, type BusyKeys } from "../../shared/lib/busy";
import { useClock } from "../../shared/hooks/useClock";
import { computeSyncStatus, splitSyncLabel } from "./sync-status";
import { RefreshIcon } from "../../shared/ui/icons";
import type { Account } from "../../types";

/**
 * When the numbers on screen were last refreshed, flagging accounts that have been left behind, with
 * the refresh button. (Settings is not here: it is in the sidebar's page links on a wide window and
 * in the bottom bar on a phone.)
 */
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
  const syncing = [...busy].some(isRefreshKey);
  const tone = useClock((now) => computeSyncStatus(accounts, now, refreshMinutes).tone);
  const label = useClock((now) => computeSyncStatus(accounts, now, refreshMinutes).label);
  const detail = useClock((now) => computeSyncStatus(accounts, now, refreshMinutes).detail);
  const { title, elapsed } = splitSyncLabel(label);
  return (
    <div className={`sidebar-sync-status is-${syncing ? "syncing" : tone}`}>
      <div className="sidebar-sync-status-text" role="status">
        <span className="sidebar-sync-status-label">
          <span className="sidebar-sync-status-words">
            <span className="sidebar-sync-status-title">{syncing ? "Syncing…" : title}</span>
            {!syncing && elapsed ? <> <span className="sidebar-sync-status-elapsed">{elapsed}</span></> : null}
          </span>
        </span>
        {!syncing && detail ? <span className="sidebar-sync-status-detail">{detail}</span> : null}
      </div>
      <div className="sidebar-sync-status-actions">
        {onRefreshAll ? (
          <button
            type="button"
            className={`sidebar-settings-btn sidebar-refresh-btn ${syncing ? "spinning" : ""}`}
            onClick={onRefreshAll}
            disabled={syncing}
            aria-label="Refresh all accounts"
            data-tooltip="Refresh all accounts"
          >
            <RefreshIcon />
          </button>
        ) : null}
      </div>
    </div>
  );
}

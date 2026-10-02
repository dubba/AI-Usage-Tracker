import { isRefreshKey, type BusyKeys } from "../../shared/lib/busy";
import { useClock } from "../../shared/hooks/useClock";
import { computeSyncStatus } from "./sync-status";
import { SettingsIcon } from "../../shared/ui/icons";
import type { Account } from "../../types";

/** When the numbers on screen were last refreshed, flagging accounts that have been left behind. */
export function SyncStatusLine({
  accounts,
  refreshMinutes,
  busy,
  onOpenSettings,
  settingsActive,
}: {
  accounts: Account[];
  refreshMinutes: number;
  busy: BusyKeys;
  onOpenSettings?: () => void;
  settingsActive?: boolean;
}) {
  const syncing = [...busy].some(isRefreshKey);
  const tone = useClock((now) => computeSyncStatus(accounts, now, refreshMinutes).tone);
  const label = useClock((now) => computeSyncStatus(accounts, now, refreshMinutes).label);
  const detail = useClock((now) => computeSyncStatus(accounts, now, refreshMinutes).detail);
  return (
    <div className={`sidebar-sync-status is-${syncing ? "syncing" : tone}`}>
      <div className="sidebar-sync-status-text" role="status">
        <span className="sidebar-sync-status-label">{syncing ? "Syncing…" : label}</span>
        {!syncing && detail ? <span className="sidebar-sync-status-detail">{detail}</span> : null}
      </div>
      <div className="sidebar-sync-status-actions">
        {onOpenSettings ? (
          <button
            type="button"
            className={`sidebar-settings-btn ${settingsActive ? "active" : ""}`}
            onClick={onOpenSettings}
            aria-label="Open settings"
            data-tooltip="Settings"
            aria-current={settingsActive ? "page" : undefined}
          >
            <SettingsIcon />
          </button>
        ) : null}
      </div>
    </div>
  );
}

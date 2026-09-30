import type { BusyKeys } from "../busy";
import { useClock } from "../hooks/useClock";
import { computeSyncStatus } from "../sync-status";
import type { Account } from "../types";

/** When the numbers on screen were last refreshed, flagging accounts that have been left behind. */
export function SyncStatusLine({
  accounts,
  refreshMinutes,
  busy,
}: {
  accounts: Account[];
  refreshMinutes: number;
  busy: BusyKeys;
}) {
  const syncing = [...busy].some((key) => key === "refresh-all" || key.startsWith("refresh:"));
  const tone = useClock((now) => computeSyncStatus(accounts, now, refreshMinutes).tone);
  const label = useClock((now) => computeSyncStatus(accounts, now, refreshMinutes).label);
  const detail = useClock((now) => computeSyncStatus(accounts, now, refreshMinutes).detail);
  return (
    <p className={`sidebar-sync-status is-${syncing ? "syncing" : tone}`} role="status">
      <span className="sidebar-sync-status-label">{syncing ? "Syncing…" : label}</span>
      {!syncing && detail ? <span className="sidebar-sync-status-detail">{detail}</span> : null}
    </p>
  );
}

import { formatElapsed } from "../../shared/lib/format";
import { accountAutoRefreshEligible, groupAlert } from "../../shared/lib/usage-logic";
import type { Account } from "../../types";

/**
 * The dot's colour: "sign-in" is red and "stale" is amber, the same two levels the sidebar rows
 * flag, so the dot is never green while a row shows a red or amber dot. "fresh" is green.
 */
export type SyncTone = "none" | "fresh" | "stale" | "sign-in";

export type SyncStatus = {
  tone: SyncTone;
  /** "All accounts updated: 4m ago". Problem accounts only change the dot's colour: the sidebar rows,
   * the Action needed card and each account's chip already say which ones. */
  label: string;
};

const MIN_STALE_MINUTES = 10;

const SYNCED_PREFIX = "All accounts updated:";

/**
 * When the data on screen was last refreshed, and whether any of it has been
 * left behind. The tone is the worst problem among the accounts: one that must
 * sign in again (red), then one that is out of date (amber). An account counts
 * as out of date when the sidebar rows flag it (a failed or stale refresh), or
 * once it is older than twice the refresh interval (and at least ten minutes);
 * that age check skips accounts that are never refreshed automatically
 * (key-only).
 */
export function computeSyncStatus(accounts: Account[], now: number, refreshMinutes: number): SyncStatus {
  const fetchedTimes = accounts.flatMap((account) => {
    const time = Date.parse(account.lastUsage?.fetchedAt ?? "");
    return Number.isFinite(time) ? [{ account, time }] : [];
  });
  if (fetchedTimes.length === 0) return { tone: "none", label: "Not synced yet" };

  // The moment every account had been synced: the oldest sync, not the newest.
  // A refresh of one account does not move it until the rest have caught up.
  const oldest = Math.min(...fetchedTimes.map((entry) => entry.time));
  const staleAfterMs = Math.max(MIN_STALE_MINUTES, refreshMinutes * 2) * 60_000;
  const stale = fetchedTimes.filter(
    (entry) => accountAutoRefreshEligible(entry.account) && now - entry.time >= staleAfterMs,
  ).length;
  const label = `${SYNCED_PREFIX} ${formatElapsed(now - oldest)}`;
  const alert = groupAlert(accounts);
  if (alert?.level === "sign-in") return { tone: "sign-in", label };
  return { tone: alert || stale > 0 ? "stale" : "fresh", label };
}

/**
 * Splits "All accounts updated: 4m ago" into the title and the elapsed time, which the sidebar shows
 * on its own line under the title. Other labels ("Not synced yet") have no elapsed part.
 */
export function splitSyncLabel(label: string): { title: string; elapsed: string | null } {
  if (label.startsWith(`${SYNCED_PREFIX} `)) {
    return { title: SYNCED_PREFIX, elapsed: label.slice(SYNCED_PREFIX.length + 1) };
  }
  return { title: label, elapsed: null };
}

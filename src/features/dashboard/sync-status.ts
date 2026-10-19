import { ACCOUNT_FORMS, formatCount } from "../../shared/lib/format";
import { formatElapsed } from "../../shared/lib/format";
import { accountAutoRefreshEligible } from "../../shared/lib/usage-logic";
import type { Account } from "../../types";

export type SyncTone = "none" | "fresh" | "stale";

export type SyncStatus = {
  tone: SyncTone;
  label: string;
  /** Shown on its own line under the label, e.g. how many accounts are out of date. */
  detail: string | null;
};

const MIN_STALE_MINUTES = 10;

/**
 * When the data on screen was last refreshed, and whether any of it has been
 * left behind. An account counts as out of date once it is older than twice the
 * refresh interval (and at least ten minutes); accounts that are never
 * refreshed automatically (sign-in needed, key-only) are not counted.
 */
export function computeSyncStatus(accounts: Account[], now: number, refreshMinutes: number): SyncStatus {
  const fetchedTimes = accounts.flatMap((account) => {
    const time = Date.parse(account.lastUsage?.fetchedAt ?? "");
    return Number.isFinite(time) ? [{ account, time }] : [];
  });
  if (fetchedTimes.length === 0) return { tone: "none", label: "Not synced yet", detail: null };

  // The moment every account had been synced: the oldest sync, not the newest.
  // A refresh of one account does not move it until the rest have caught up.
  const oldest = Math.min(...fetchedTimes.map((entry) => entry.time));
  const staleAfterMs = Math.max(MIN_STALE_MINUTES, refreshMinutes * 2) * 60_000;
  const stale = fetchedTimes.filter(
    (entry) => accountAutoRefreshEligible(entry.account) && now - entry.time >= staleAfterMs,
  ).length;
  const label = `Accounts synced ${formatElapsed(now - oldest)}`;
  if (stale === 0) return { tone: "fresh", label, detail: null };
  return { tone: "stale", label, detail: `${formatCount(stale, ACCOUNT_FORMS)} out of date` };
}

const SYNCED_PREFIX = "Accounts synced";

/**
 * Splits "Accounts synced 4m ago" into the part that stays whole and the elapsed time, which may
 * wrap to its own line in a narrow sidebar. Other labels ("Not synced yet") have no elapsed part.
 */
export function splitSyncLabel(label: string): { title: string; elapsed: string | null } {
  if (label.startsWith(`${SYNCED_PREFIX} `)) {
    return { title: SYNCED_PREFIX, elapsed: label.slice(SYNCED_PREFIX.length + 1) };
  }
  return { title: label, elapsed: null };
}

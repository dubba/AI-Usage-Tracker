import { formatCount } from "./format";
import { accountAutoRefreshEligible, formatElapsed } from "./usage-logic";
import type { Account } from "./types";

export type SyncTone = "none" | "fresh" | "stale";

export type SyncStatus = {
  tone: SyncTone;
  label: string;
};

const MIN_STALE_MINUTES = 10;
const ACCOUNT_FORMS = { one: "account", other: "accounts" };

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
  if (fetchedTimes.length === 0) return { tone: "none", label: "Not synced yet" };

  const newest = Math.max(...fetchedTimes.map((entry) => entry.time));
  const staleAfterMs = Math.max(MIN_STALE_MINUTES, refreshMinutes * 2) * 60_000;
  const stale = fetchedTimes.filter(
    (entry) => accountAutoRefreshEligible(entry.account) && now - entry.time >= staleAfterMs,
  ).length;
  const synced = `Last synced ${formatElapsed(now - newest)}`;
  if (stale === 0) return { tone: "fresh", label: synced };
  return { tone: "stale", label: `${synced} · ${formatCount(stale, ACCOUNT_FORMS)} out of date` };
}

import { bridgeApi } from "../../shared/lib/api";
import { storePageAccountOrder } from "../dashboard/dashboard-page-state";
import { requestDashboardResync } from "../../shared/lib/events";
import { logIgnored } from "../../shared/lib/log";
import { getLatestSnapshot } from "../dashboard/snapshot-store";
import type { Account, AccountBucket } from "../../types";

/**
 * The full account order implied by a new order of sidebar groups: each group's accounts in
 * turn (a bucket's members, or a provider's accounts not already placed), then any account no
 * group claimed. Every account appears exactly once.
 */
export function accountOrderForGroups(
  orderedGroupIds: string[],
  accounts: Pick<Account, "id" | "provider">[],
  buckets: Pick<AccountBucket, "id" | "accountIds">[],
): string[] {
  const ordered: string[] = [];
  const assigned = new Set<string>();
  const place = (id: string) => {
    if (assigned.has(id)) return;
    assigned.add(id);
    ordered.push(id);
  };

  for (const groupId of orderedGroupIds) {
    if (groupId.startsWith("bucket:")) {
      const bucket = buckets.find((candidate) => candidate.id === groupId.slice(7));
      bucket?.accountIds.forEach(place);
    } else if (groupId.startsWith("provider:")) {
      const provider = groupId.slice(9);
      accounts.filter((account) => account.provider === provider).forEach((account) => place(account.id));
    }
  }
  accounts.forEach((account) => place(account.id));
  return ordered;
}

export async function persistGroupOrder(orderedGroupIds: string[]): Promise<void> {
  try {
    const snapshot = await bridgeApi.snapshot();
    const accounts = snapshot.accounts;
    const orderedAccountIds = accountOrderForGroups(orderedGroupIds, accounts, snapshot.buckets ?? []);
    // A bucket can name an account that no longer exists; only save a complete, exact order.
    if (orderedAccountIds.length === accounts.length) {
      await bridgeApi.reorderAccounts(orderedAccountIds);
    }
  } catch (cause) {
    logIgnored("dashboard-reorder persist", cause);
  }
  // Either way, have the app re-read the saved state so the screen matches it.
  requestDashboardResync();
}

export async function persistVisibleAccountOrder(orderedVisibleIds: string[], groupId: string | null): Promise<void> {
  const pageId = groupId && groupId.length > 0 ? groupId : "all";
  storePageAccountOrder(pageId, orderedVisibleIds);

  try {
    if (pageId === "all") {
      await bridgeApi.reorderAccounts(orderedVisibleIds);
    } else if (pageId.startsWith("bucket:")) {
      const snapshot = getLatestSnapshot() ?? await bridgeApi.snapshot();
      const bucket = (snapshot.buckets ?? []).find((candidate) => candidate.id === pageId.slice(7));
      if (bucket) {
        const visible = new Set(orderedVisibleIds);
        const nextAccountIds = [...orderedVisibleIds, ...bucket.accountIds.filter((id) => !visible.has(id))];
        await bridgeApi.saveBucket(bucket.name, bucket.provider, nextAccountIds, bucket.id);
      }
    }
  } catch (cause) {
    logIgnored("dashboard-reorder persist", cause);
  }
  requestDashboardResync();
}

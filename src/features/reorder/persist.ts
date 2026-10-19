import { bridgeApi } from "../../shared/lib/api";
import { storePageAccountOrder, whileSavingAllOrder } from "../dashboard/dashboard-page-state";
import { bucketIdFromGroup, buildSidebarGroups, groupOrderForAccounts, providerIdFromGroup } from "../dashboard/sidebar-groups";
import { readDashboardProviderOrder, readSidebarGroupOrder, storeSidebarGroupOrder } from "../dashboard/sidebar-order";
import { requestDashboardResync } from "../../shared/lib/events";
import { logIgnored } from "../../shared/lib/log";
import { getLatestSnapshot } from "../dashboard/snapshot-store";
import { arraysEqual } from "./dom";
import type { Account, AccountBucket, DashboardSnapshot } from "../../types";

/**
 * The full account order implied by a new order of sidebar groups: each group's accounts in
 * turn (a bucket's members, or a provider's accounts that are in no bucket, matching what the
 * sidebar lists under it), then any account no group claimed. Every account appears exactly once.
 */
export function accountOrderForGroups(
  orderedGroupIds: string[],
  accounts: Pick<Account, "id" | "provider">[],
  buckets: Pick<AccountBucket, "id" | "accountIds">[],
): string[] {
  const ordered: string[] = [];
  const assigned = new Set<string>();
  const inBucket = new Set(buckets.flatMap((bucket) => bucket.accountIds));
  const place = (id: string) => {
    if (assigned.has(id)) return;
    assigned.add(id);
    ordered.push(id);
  };

  for (const groupId of orderedGroupIds) {
    const bucketId = bucketIdFromGroup(groupId);
    const provider = providerIdFromGroup(groupId);
    if (bucketId !== null) {
      const bucket = buckets.find((candidate) => candidate.id === bucketId);
      bucket?.accountIds.forEach(place);
    } else if (provider !== null) {
      accounts
        .filter((account) => account.provider === provider && !inBucket.has(account.id))
        .forEach((account) => place(account.id));
    }
  }
  accounts.forEach((account) => place(account.id));
  return ordered;
}

/** The account order for `orderedGroupIds`, or null when it would not be complete and exact. */
function completeAccountOrder(
  orderedGroupIds: string[],
  snapshot: Pick<DashboardSnapshot, "accounts" | "buckets">,
): string[] | null {
  const ordered = accountOrderForGroups(orderedGroupIds, snapshot.accounts, snapshot.buckets ?? []);
  // A bucket can name an account that no longer exists.
  return ordered.length === snapshot.accounts.length ? ordered : null;
}

export async function persistGroupOrder(orderedGroupIds: string[]): Promise<void> {
  // Rearrange the All page right away from the snapshot on screen, the way a card drag moves the
  // sidebar, instead of waiting for the save and a reload.
  const shown = getLatestSnapshot();
  const shownOrder = shown ? completeAccountOrder(orderedGroupIds, shown) : null;
  if (shownOrder) storePageAccountOrder("all", shownOrder);

  try {
    await whileSavingAllOrder(async () => {
      // Save from a fresh snapshot so an account added since the last load is not left out.
      const orderedAccountIds = completeAccountOrder(orderedGroupIds, await bridgeApi.snapshot());
      if (orderedAccountIds) await bridgeApi.reorderAccounts(orderedAccountIds);
    });
  } catch (cause) {
    logIgnored("dashboard-reorder persist", cause);
  }
  // Either way, have the app re-read the saved state so the screen matches it.
  requestDashboardResync();
}

/**
 * Moves the sidebar groups to match a new account order on the All page, the way dragging a
 * sidebar group reorders the All page. Without this the sidebar keeps its own saved order and
 * never follows a card drag.
 */
function syncSidebarGroupOrder(
  orderedAccountIds: string[],
  snapshot: Pick<DashboardSnapshot, "accounts" | "buckets">,
): void {
  const groups = buildSidebarGroups(
    snapshot.accounts,
    snapshot.buckets ?? [],
    readDashboardProviderOrder(),
    readSidebarGroupOrder(),
  );
  const next = groupOrderForAccounts(orderedAccountIds, groups);
  if (!arraysEqual(next, groups.map((group) => group.id))) storeSidebarGroupOrder(next);
}

export async function persistVisibleAccountOrder(orderedVisibleIds: string[], groupId: string | null): Promise<void> {
  const pageId = groupId && groupId.length > 0 ? groupId : "all";
  storePageAccountOrder(pageId, orderedVisibleIds);

  try {
    if (pageId === "all") {
      // Update the sidebar right away from the snapshot on screen, like the cards themselves.
      const snapshot = getLatestSnapshot();
      if (snapshot) syncSidebarGroupOrder(orderedVisibleIds, snapshot);
      await whileSavingAllOrder(() => bridgeApi.reorderAccounts(orderedVisibleIds));
    } else if (bucketIdFromGroup(pageId) !== null) {
      const bucketId = bucketIdFromGroup(pageId);
      const snapshot = getLatestSnapshot() ?? await bridgeApi.snapshot();
      const bucket = (snapshot.buckets ?? []).find((candidate) => candidate.id === bucketId);
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

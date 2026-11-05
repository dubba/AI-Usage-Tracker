import { bridgeApi } from "../../shared/lib/api";
import { storePageAccountOrder, whileSavingAllOrder } from "../dashboard/dashboard-page-state";
import {
  bucketIdFromGroup,
  buildSidebarGroups,
  groupOrderForAccounts,
  listAccountsUnderProviders,
  providerIdFromGroup,
} from "../dashboard/sidebar-groups";
import { readDashboardProviderOrder, readSidebarGroupOrder, storeSidebarGroupOrder } from "../dashboard/sidebar-order";
import { requestDashboardResync } from "../../shared/lib/events";
import { logIgnored } from "../../shared/lib/log";
import { getLatestSnapshot } from "../dashboard/snapshot-store";
import { arraysEqual } from "./dom";
import type { Account, AccountBucket, DashboardSnapshot } from "../../types";

/**
 * The full account order implied by a new order of sidebar groups: each provider row's accounts in
 * turn (all of that provider's accounts, including the ones that are also in a custom group, as the
 * sidebar lists them), then any account only a custom group claims. The Accounts list in the
 * sidebar sets the order of the All page; custom groups only add accounts no provider row listed.
 * Every account appears exactly once.
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
    const provider = providerIdFromGroup(groupId);
    if (provider !== null) {
      accounts.filter((account) => account.provider === provider).forEach((account) => place(account.id));
    }
  }
  for (const groupId of orderedGroupIds) {
    const bucketId = bucketIdFromGroup(groupId);
    if (bucketId === null) continue;
    buckets.find((candidate) => candidate.id === bucketId)?.accountIds.forEach(place);
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
  const saved = readSidebarGroupOrder();
  const groups = listAccountsUnderProviders(
    buildSidebarGroups(snapshot.accounts, snapshot.buckets ?? [], readDashboardProviderOrder(), saved),
    snapshot.accounts,
    saved,
  );
  const next = groupOrderForAccounts(orderedAccountIds, groups);
  if (!arraysEqual(next, groups.map((group) => group.id))) storeSidebarGroupOrder(next);
}

export async function persistVisibleAccountOrder(orderedVisibleIds: string[], groupId: string | null): Promise<void> {
  const pageId = groupId && groupId.length > 0 ? groupId : "all";

  try {
    if (pageId === "all") {
      // Update the sidebar right away from the snapshot on screen, like the cards themselves.
      const snapshot = getLatestSnapshot() ?? await bridgeApi.snapshot().catch(() => null);
      const allKnownIds = snapshot?.accounts ? snapshot.accounts.map((a) => a.id) : [];
      const visibleSet = new Set(orderedVisibleIds);
      const fullOrderedIds = [...orderedVisibleIds, ...allKnownIds.filter((id) => !visibleSet.has(id))];
      storePageAccountOrder("all", fullOrderedIds);
      if (snapshot) syncSidebarGroupOrder(fullOrderedIds, snapshot);
      await whileSavingAllOrder(() => bridgeApi.reorderAccounts(fullOrderedIds));
    } else if (bucketIdFromGroup(pageId) !== null) {
      storePageAccountOrder(pageId, orderedVisibleIds);
      const bucketId = bucketIdFromGroup(pageId);
      const snapshot = getLatestSnapshot() ?? await bridgeApi.snapshot();
      const bucket = (snapshot.buckets ?? []).find((candidate) => candidate.id === bucketId);
      if (bucket) {
        const visible = new Set(orderedVisibleIds);
        const nextAccountIds = [...orderedVisibleIds, ...bucket.accountIds.filter((id) => !visible.has(id))];
        await bridgeApi.saveBucket(bucket.name, bucket.provider, nextAccountIds, bucket.id);
      }
    } else {
      storePageAccountOrder(pageId, orderedVisibleIds);
    }
  } catch (cause) {
    logIgnored("dashboard-reorder persist", cause);
  }
  requestDashboardResync();
}

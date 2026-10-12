import { displayProviderGroupTitle } from "../../shared/lib/display";
import type { Account, AccountBucket, Provider } from "../../types";

export const ALL_ACCOUNTS_GROUP_ID = "all";

export type SidebarGroup = {
  id: string;
  type: "all" | "bucket" | "provider";
  title: string;
  provider: Provider | null;
  accounts: Account[];
  bucket?: AccountBucket;
};

export function buildAllAccountsGroup(accounts: Account[]): SidebarGroup {
  return {
    id: ALL_ACCOUNTS_GROUP_ID,
    type: "all",
    title: "All",
    provider: null,
    accounts,
  };
}

/**
 * Custom groups first, then one group per provider for accounts that are not
 * in any custom group, sorted by the user's saved sidebar order.
 */
export function buildSidebarGroups(
  accounts: Account[],
  buckets: AccountBucket[],
  providerOrder: Provider[],
  sidebarGroupOrder: string[],
): SidebarGroup[] {
  const assignedIds = new Set<string>();
  const bucketGroups: SidebarGroup[] = [];

  for (const bucket of buckets) {
    const bucketAccounts = bucket.accountIds
      .map((id) => accounts.find((account) => account.id === id))
      .filter((account): account is Account => Boolean(account));
    bucket.accountIds.forEach((id) => assignedIds.add(id));
    bucketGroups.push({
      id: `bucket:${bucket.id}`,
      type: "bucket",
      title: bucket.name,
      provider: bucket.provider ?? bucketAccounts[0]?.provider ?? null,
      accounts: bucketAccounts,
      bucket,
    });
  }

  const providerGroups: SidebarGroup[] = [];
  const seenProviders = new Set<Provider>();
  const pushProviderGroup = (provider: Provider) => {
    const unassigned = accounts.filter(
      (account) => account.provider === provider && !assignedIds.has(account.id),
    );
    if (unassigned.length === 0) return;
    providerGroups.push({
      id: `provider:${provider}`,
      type: "provider",
      title: displayProviderGroupTitle(provider, unassigned),
      provider,
      accounts: unassigned,
    });
  };
  // Follow dashboard card order (oldest → newest) instead of a fixed provider list.
  for (const account of accounts) {
    if (assignedIds.has(account.id) || seenProviders.has(account.provider)) continue;
    seenProviders.add(account.provider);
    pushProviderGroup(account.provider);
  }
  for (const provider of providerOrder) {
    if (seenProviders.has(provider)) continue;
    seenProviders.add(provider);
    pushProviderGroup(provider);
  }

  const allGroups = [...bucketGroups, ...providerGroups];
  if (sidebarGroupOrder.length === 0) return allGroups;

  return [...allGroups].sort((a, b) => {
    const indexA = sidebarGroupOrder.indexOf(a.id);
    const indexB = sidebarGroupOrder.indexOf(b.id);
    if (indexA !== -1 && indexB !== -1) return indexA - indexB;
    if (indexA !== -1) return -1;
    if (indexB !== -1) return 1;
    return 0;
  });
}

/**
 * The sidebar group order implied by a new account order on the All page: groups sorted by where
 * their first account now sits. The inverse of `accountOrderForGroups`, so dragging a card and
 * dragging a sidebar group both leave the two views matching. A group with no accounts (an empty
 * custom group) keeps its slot.
 */
export function groupOrderForAccounts(
  orderedAccountIds: string[],
  groups: Pick<SidebarGroup, "id" | "accounts">[],
): string[] {
  const position = new Map(orderedAccountIds.map((id, index) => [id, index]));
  const ranked = groups.map((group) => ({
    id: group.id,
    at: Math.min(...group.accounts.map((account) => position.get(account.id) ?? Infinity)),
  }));
  const placed = ranked.filter((group) => Number.isFinite(group.at)).sort((a, b) => a.at - b.at);
  let next = 0;
  return ranked.map((group) => (Number.isFinite(group.at) ? placed[next++].id : group.id));
}

/**
 * The saved sidebar order to keep after the membership changed (accounts added, removed, or
 * re-added, buckets changed), or null when the current order already matches the backend
 * account order. Removing and re-adding an account appends it last on the backend while the
 * saved sidebar order still slots its group in the old place, so without this the sidebar and
 * the All page disagree. Saved entries for groups that no longer exist are dropped.
 */
export function reconciledSidebarGroupOrder(
  orderedAccountIds: string[],
  groups: Pick<SidebarGroup, "id" | "accounts">[],
  savedOrder: string[],
): string[] | null {
  const next = groupOrderForAccounts(orderedAccountIds, groups);
  const current = groups.map((group) => group.id);
  const known = new Set(current);
  const hasGhosts = savedOrder.some((id) => !known.has(id));
  const sameOrder = next.length === current.length && next.every((id, index) => id === current[index]);
  return sameOrder && !hasGhosts ? null : next;
}

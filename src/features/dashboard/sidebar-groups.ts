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

import { displayProviderGroupTitle } from "../../shared/lib/display";
import { moveById } from "../reorder/reorder-utils";
import type { Account, AccountBucket, Provider } from "../../types";

export const ALL_ACCOUNTS_GROUP_ID = "all";

// A sidebar group id is also the id of its dashboard page, and the pairing payload carries both
// ("bucket:<id>" in `payload.rs`), so the format must not change.
const BUCKET_GROUP_PREFIX = "bucket:";
const PROVIDER_GROUP_PREFIX = "provider:";

export const bucketGroupId = (bucketId: string): string => `${BUCKET_GROUP_PREFIX}${bucketId}`;
export const providerGroupId = (provider: Provider): string => `${PROVIDER_GROUP_PREFIX}${provider}`;
export const isBucketGroupId = (groupId: string): boolean => groupId.startsWith(BUCKET_GROUP_PREFIX);
export const isProviderGroupId = (groupId: string): boolean => groupId.startsWith(PROVIDER_GROUP_PREFIX);

/** The bucket id inside a "bucket:<id>" group id, or null for any other group. */
export function bucketIdFromGroup(groupId: string): string | null {
  return isBucketGroupId(groupId) ? groupId.slice(BUCKET_GROUP_PREFIX.length) : null;
}

/** The provider id inside a "provider:<id>" group id, or null for any other group. Not checked against known providers. */
export function providerIdFromGroup(groupId: string): string | null {
  return isProviderGroupId(groupId) ? groupId.slice(PROVIDER_GROUP_PREFIX.length) : null;
}

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
    title: "All Accounts",
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
  providerOrder: readonly Provider[],
  sidebarGroupOrder: readonly string[],
): SidebarGroup[] {
  const assignedIds = new Set<string>();
  const bucketGroups: SidebarGroup[] = [];

  for (const bucket of buckets) {
    const bucketAccounts = bucket.accountIds
      .map((id) => accounts.find((account) => account.id === id))
      .filter((account): account is Account => Boolean(account));
    bucket.accountIds.forEach((id) => assignedIds.add(id));
    bucketGroups.push({
      id: bucketGroupId(bucket.id),
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
      id: providerGroupId(provider),
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

  return sortBySavedOrder([...bucketGroups, ...providerGroups], sidebarGroupOrder);
}

/** Groups in the saved order; any not in it keep their relative order after the saved ones. */
function sortBySavedOrder(groups: SidebarGroup[], savedOrder: readonly string[]): SidebarGroup[] {
  if (savedOrder.length === 0) return groups;
  return [...groups].sort((a, b) => {
    const indexA = savedOrder.indexOf(a.id);
    const indexB = savedOrder.indexOf(b.id);
    if (indexA !== -1 && indexB !== -1) return indexA - indexB;
    if (indexA !== -1) return -1;
    if (indexB !== -1) return 1;
    return 0;
  });
}

/**
 * The full account order implied by a sidebar group order: each provider row's accounts in turn
 * (all of that provider's accounts, including ones that are also in a custom group), then any
 * account only a custom group claims. The Accounts list sets the All page's order; custom groups
 * only add accounts no provider row listed. Every account appears exactly once.
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

function providerRowOrder(ids: readonly string[]): string[] {
  return ids.filter((id) => isProviderGroupId(id));
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

/** Accounts in `ids` order; ids that are not on the page are skipped, and any leftover accounts stay at the end. */
function orderAccountsByIds<T extends { id: string }>(accounts: T[], ids: readonly string[]): T[] {
  if (sameIds(ids, accounts.map((account) => account.id))) return accounts;
  const remaining = new Map(accounts.map((account) => [account.id, account]));
  const ordered: T[] = [];
  for (const id of ids) {
    const account = remaining.get(id);
    if (!account) continue;
    ordered.push(account);
    remaining.delete(id);
  }
  for (const account of accounts) {
    if (remaining.has(account.id)) ordered.push(account);
  }
  return ordered;
}

/**
 * The All page (and the Usage page, which follows it) once the sidebar order and the account
 * order disagree. Dragging a provider row should move that provider's accounts in the same
 * paint as the row. An order the sidebar already agrees with — including cards interleaved by
 * a drag on the page — is returned unchanged, and moving a custom group does not move accounts.
 * `groups` is the sidebar list (`listAccountsUnderProviders`).
 */
export function allPageAccountsForSidebar<T extends Pick<Account, "id" | "provider">>(
  pageAccounts: T[],
  groups: Pick<SidebarGroup, "id" | "accounts">[],
  buckets: Pick<AccountBucket, "id" | "accountIds">[],
): T[] {
  if (pageAccounts.length < 2 || groups.length === 0) return pageAccounts;
  const shownIds = groups.map((group) => group.id);
  const implied = groupOrderForAccounts(pageAccounts.map((account) => account.id), groups);
  if (sameIds(providerRowOrder(implied), providerRowOrder(shownIds))) return pageAccounts;
  return orderAccountsByIds(pageAccounts, accountOrderForGroups(shownIds, pageAccounts, buckets));
}

/**
 * The sidebar group order implied by a new account order on the All page: provider rows sorted by
 * where their first account now sits. The inverse of `accountOrderForGroups`, so dragging a card
 * and dragging a sidebar row both leave the two views matching. Custom groups do not take part:
 * the Accounts list sets the All page's order, so a group keeps its own place (and its place
 * relative to the other groups), as does a provider row with no accounts. `groups` should be the
 * list as the sidebar shows it (`listAccountsUnderProviders`), so every provider row holds all of
 * its provider's accounts.
 */
export function groupOrderForAccounts(
  orderedAccountIds: string[],
  groups: Pick<SidebarGroup, "id" | "accounts">[],
): string[] {
  const position = new Map(orderedAccountIds.map((id, index) => [id, index]));
  const ranked = groups.map((group) => ({
    id: group.id,
    at: isBucketGroupId(group.id)
      ? Infinity
      : Math.min(...group.accounts.map((account) => position.get(account.id) ?? Infinity)),
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

/** The sidebar lists custom groups apart from the provider rows; this is the section a row sits in. */
export const isBucketGroup = (group: Pick<SidebarGroup, "type">): boolean => group.type === "bucket";

/**
 * Moves a group one place up or down among the groups in its own sidebar section (custom groups or
 * provider rows), leaving every group of the other kind where it is in the saved order. `to` and
 * `total` are the new position and the size of that section, for the screen-reader announcement.
 * Null when the id is missing or the group is already at that end of its section.
 */
export function moveGroupWithinSection(
  groups: Pick<SidebarGroup, "id" | "type">[],
  id: string,
  delta: -1 | 1,
): { ids: string[]; to: number; total: number } | null {
  const moving = groups.find((group) => group.id === id);
  if (!moving) return null;
  const section = groups.filter((group) => isBucketGroup(group) === isBucketGroup(moving));
  const from = section.findIndex((group) => group.id === id);
  const neighbor = section[from + delta];
  if (!neighbor) return null;
  const ids = groups.map((group) => group.id);
  const move = moveById(ids, id, ids.indexOf(neighbor.id) - ids.indexOf(id));
  return move ? { ids: move.ids, to: from + delta, total: section.length } : null;
}

/**
 * The groups as the sidebar lists them: every provider row holds all of that provider's accounts,
 * including the ones that are also in a custom group. A provider whose accounts are all in custom
 * groups still gets a row, after the others unless the saved order says otherwise.
 *
 * `buildSidebarGroups` keeps each account in one group on purpose: the sidebar order and the
 * All page's card order are derived from each other through it (see `groupOrderForAccounts`), so
 * the order logic must keep using that list. Only what the sidebar and a provider's page show uses
 * this one.
 */
export function listAccountsUnderProviders(
  groups: SidebarGroup[],
  accounts: Account[],
  savedOrder: readonly string[] = [],
): SidebarGroup[] {
  const shown = new Set<Provider>();
  const withAll = groups.map((group) => {
    if (group.type !== "provider" || !group.provider) return group;
    shown.add(group.provider);
    const provider = group.provider;
    return { ...group, accounts: accounts.filter((account) => account.provider === provider) };
  });
  const missing: SidebarGroup[] = [];
  for (const account of accounts) {
    if (shown.has(account.provider)) continue;
    shown.add(account.provider);
    const providerAccounts = accounts.filter((candidate) => candidate.provider === account.provider);
    missing.push({
      id: providerGroupId(account.provider),
      type: "provider",
      title: displayProviderGroupTitle(account.provider, providerAccounts),
      provider: account.provider,
      accounts: providerAccounts,
    });
  }
  // The rows added above follow the saved order too, so dragging one holds at once instead of
  // snapping back until the accounts' own order catches up.
  return sortBySavedOrder([...withAll, ...missing], savedOrder);
}

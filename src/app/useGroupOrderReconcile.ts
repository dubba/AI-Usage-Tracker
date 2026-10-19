import { useEffect, useMemo, useRef } from "react";
import { readDashboardProviderOrder, readSidebarGroupOrder, storeSidebarGroupOrder } from "../features/dashboard/sidebar-order";
import { buildSidebarGroups, reconciledSidebarGroupOrder } from "../features/dashboard/sidebar-groups";
import type { Account, AccountBucket, DashboardSnapshot } from "../types";

/**
 * Removing and re-adding an account appends it last in the backend order while the saved sidebar
 * order still slots its group in the old place, so the sidebar and the All page disagree. This
 * re-derives the group order from the backend order whenever the membership changes; it does
 * nothing otherwise, so card and group drags (which keep both sides in step themselves) are never
 * disturbed.
 */
export function useGroupOrderReconcile({
  snapshot,
  accounts,
  buckets,
}: {
  snapshot: DashboardSnapshot | null;
  accounts: Account[];
  buckets: AccountBucket[];
}) {
  const membershipKey = useMemo(
    () => [accounts.map((account) => account.id).join(" "), buckets.map((bucket) => bucket.id).join(" ")].join("\n"),
    [accounts, buckets],
  );
  const reconciledMembershipRef = useRef<string | null>(null);
  useEffect(() => {
    if (!snapshot || reconciledMembershipRef.current === membershipKey) return;
    reconciledMembershipRef.current = membershipKey;
    const saved = readSidebarGroupOrder();
    const next = reconciledSidebarGroupOrder(
      accounts.map((account) => account.id),
      buildSidebarGroups(accounts, buckets, readDashboardProviderOrder(), saved),
      saved,
    );
    if (next) storeSidebarGroupOrder(next);
  }, [snapshot, membershipKey, accounts, buckets]);
}

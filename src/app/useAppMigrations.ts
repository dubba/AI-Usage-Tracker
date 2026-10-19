import { useEffect, useRef } from "react";
import { bridgeApi } from "../shared/lib/api";
import { requestDashboardResync } from "../shared/lib/events";
import { logIgnored } from "../shared/lib/log";
import { migrateLegacyAllPageOrder, migrateLegacyCollapsedCards } from "../features/dashboard/dashboard-page-state";
import type { DashboardSnapshot } from "../types";

/**
 * One-time upgrades of what older versions saved in the browser. Each runs once per launch.
 *
 * - Collapsed cards were saved without a page; they are now saved per page.
 * - The "all" page used to keep an order of its own. Once the accounts are known, it is folded into
 *   the backend order (which that page now follows) so the page looks the same.
 */
export function useAppMigrations(snapshot: DashboardSnapshot | null) {
  useEffect(() => {
    migrateLegacyCollapsedCards();
  }, []);

  const legacyAllOrderHandledRef = useRef(false);
  useEffect(() => {
    if (!snapshot || legacyAllOrderHandledRef.current) return;
    legacyAllOrderHandledRef.current = true;
    const next = migrateLegacyAllPageOrder(snapshot.accounts.map((account) => account.id));
    if (!next) return;
    void bridgeApi
      .reorderAccounts(next)
      .catch((cause) => logIgnored("legacy all-page order", cause))
      .finally(requestDashboardResync);
  }, [snapshot]);
}

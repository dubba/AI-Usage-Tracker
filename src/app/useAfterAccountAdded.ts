import { useCallback } from "react";
import { bridgeApi } from "../shared/lib/api";
import { busyKey } from "../shared/lib/busy";
import type { ReportError } from "../shared/lib/errors";
import { displayAccountLabel } from "../shared/lib/usage-logic";
import { ALL_ACCOUNTS_GROUP_ID, providerGroupId } from "../features/sidebar/sidebar-groups";
import { setCardCollapsedOnPage } from "../features/layout/dashboard-page-state";
import type { Account, DashboardSnapshot } from "../types";

/**
 * What happens once the Add Account dialog has connected an account: give a new card an
 * uncollapsed initial state (regular on mobile, following Compact View on desktop), close the
 * dialog, show the provider's page, load the new account, and make sure it has usage to show. A
 * first refresh is done only when the load found none; if that refresh fails the account is kept
 * (with its cached state) and the error says the first refresh did not work. A Google AI Studio
 * account that has no quota windows yet goes straight on to the Cloud connection dialog.
 */
export function useAfterAccountAdded({
  closeAddDialog,
  selectGroup,
  load,
  reportError,
  openGoogleUsage,
  reconnect,
}: {
  closeAddDialog: () => void;
  selectGroup: (groupId: string) => void;
  load: () => Promise<DashboardSnapshot | null>;
  reportError: ReportError;
  openGoogleUsage: (account: Account) => void;
  /** Reconnecting must not reset an existing card's manual collapse choice. */
  reconnect: boolean;
}) {
  return useCallback(
    async (account: Account) => {
      const pageId = providerGroupId(account.provider);
      if (!reconnect) {
        setCardCollapsedOnPage(pageId, account.id, false);
        setCardCollapsedOnPage(ALL_ACCOUNTS_GROUP_ID, account.id, false);
      }
      closeAddDialog();
      selectGroup(pageId);
      let nextAccount = account;
      const currentSnapshot = await load();
      const stored = currentSnapshot?.accounts.find((item) => item.id === account.id);
      if (stored?.lastUsage) {
        nextAccount = stored;
      } else if (!nextAccount.lastUsage) {
        try {
          nextAccount = await bridgeApi.refreshAccount(account.id);
          await load();
        } catch (cause) {
          // The account is saved and stays available with cached state; say that the first refresh failed.
          reportError(
            busyKey("refresh", account.id),
            cause,
            `Added ${displayAccountLabel(account)}, but couldn't refresh it yet`,
            "Added an account, but couldn't refresh it yet",
          );
        }
      }
      // A Google AI Studio account without quota windows yet: offer to connect Cloud usage.
      if (nextAccount.googleSetup != null && nextAccount.googleSetup !== "ready") {
        openGoogleUsage(nextAccount);
      }
    },
    [closeAddDialog, selectGroup, load, reportError, openGoogleUsage, reconnect],
  );
}

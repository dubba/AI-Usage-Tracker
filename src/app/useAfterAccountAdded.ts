import { useCallback } from "react";
import { bridgeApi } from "../shared/lib/api";
import { busyKey } from "../shared/lib/busy";
import type { ReportError } from "../shared/lib/errors";
import { displayAccountLabel, googleAiStudioHasQuotaWindows } from "../shared/lib/usage-logic";
import { providerGroupId } from "../features/dashboard/sidebar-groups";
import type { Account, DashboardSnapshot } from "../types";

/**
 * What happens once the Add Account dialog has connected an account: close the dialog, show the
 * provider's page, load the new account, and make sure it has usage to show. A first refresh is
 * done only when the load found none; if that refresh fails the account is kept (with its cached
 * state) and the error says the first refresh did not work. A Google AI Studio account that has no
 * quota windows yet goes straight on to the Cloud connection dialog.
 */
export function useAfterAccountAdded({
  closeAddDialog,
  selectGroup,
  load,
  reportError,
  openGoogleUsage,
}: {
  closeAddDialog: () => void;
  selectGroup: (groupId: string) => void;
  load: () => Promise<DashboardSnapshot | null>;
  reportError: ReportError;
  openGoogleUsage: (account: Account) => void;
}) {
  return useCallback(
    async (account: Account) => {
      closeAddDialog();
      selectGroup(providerGroupId(account.provider));
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
          reportError(busyKey("refresh", account.id), cause, `Added ${displayAccountLabel(account)}, but couldn't refresh it yet`);
        }
      }
      if (nextAccount.provider === "google_ai_studio" && !googleAiStudioHasQuotaWindows(nextAccount)) {
        openGoogleUsage(nextAccount);
      }
    },
    [closeAddDialog, selectGroup, load, reportError, openGoogleUsage],
  );
}

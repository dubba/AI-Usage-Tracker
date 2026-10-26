import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import { modalReducer } from "./modal-state";
import { openSafeUrl } from "../shared/lib/safeUrl";
import { useBusyKeys } from "../shared/lib/busy";
import { useAppErrors } from "../shared/lib/errors";
import { resumeLoginAttemptWatch, subscribeLoginStatus } from "../shared/lib/login-status";
import { AccountsView } from "../features/accounts/AccountsView";
import { ActivityView } from "../features/activity/ActivityView";
import { useUnprotectedSignIns } from "../features/accounts/useUnprotectedSignIns";
import { ErrorBanner } from "../shared/ui/ErrorBanner";
import { SettingsView } from "../features/settings/SettingsView";
import { useLayout } from "../features/dashboard/layout-store";
import { AppSettingsContext, AppUpdateContext } from "../features/settings/settings-context";
import { GROUP_REORDER_HINT_ID } from "../features/dashboard/SidebarGroupRow";
import { UsageAlertToasts } from "../features/alerts/UsageAlertToasts";
import "../features/pairing/pairing.css";
import { persistGroupOrder } from "../features/reorder";
import { storeSidebarGroupOrder } from "../features/dashboard/sidebar-order";
import { applyPageAccountOrder } from "../features/dashboard/dashboard-page-state";
import { DEFAULT_ACCOUNT_REFRESH_MINUTES } from "../shared/lib/constants";
import { useAccountActions } from "../features/accounts/useAccountActions";
import { useAppSettings } from "../features/settings/useAppSettings";
import { useAppUpdate } from "../features/settings/useAppUpdate";
import { useKeyboardShortcuts } from "../features/shortcuts/useKeyboardShortcuts";
import { isMobileDevice } from "../shared/lib/platform";
import { useDashboardData } from "../features/dashboard/useDashboardData";
import { useDragReorder } from "../features/reorder/useDragReorder";
import { usePairingEvents } from "../features/pairing/hooks/usePairingEvents";
import { useSidebarOverlay } from "../features/dashboard/useSidebarOverlay";
import { useTouchTooltips } from "../shared/hooks/useTouchTooltips";
import { useUsageAlerts } from "../features/alerts/useUsageAlerts";
import {
  ALL_ACCOUNTS_GROUP_ID,
  bucketGroupId,
  buildAllAccountsGroup,
  buildSidebarGroups,
  type SidebarGroup,
} from "../features/dashboard/sidebar-groups";
import { moveAnnouncement, moveById } from "../features/reorder/reorder-utils";
import { requestDashboardResync } from "../shared/lib/events";
import { bridgeApi } from "../shared/lib/api";
import { clearAppStorage } from "../shared/lib/storage";
import type { Account, AccountBucket, Provider } from "../types";
import { AppModals } from "./AppModals";
import { BottomNav } from "./BottomNav";
import { Sidebar } from "./Sidebar";
import { useAfterAccountAdded } from "./useAfterAccountAdded";
import { useAppMigrations } from "./useAppMigrations";
import { useBottomNavVisible } from "./useBottomNavVisible";
import { useGroupOrderReconcile } from "./useGroupOrderReconcile";
import { watchPageScrollRestore } from "./page-scroll";
import { useSidebarNavigation } from "./useSidebarNavigation";

// One shared empty list, so the "not loaded yet" value is the same object on every render.
const NO_ACCOUNTS: Account[] = [];
const NO_BUCKETS: AccountBucket[] = [];

export type { SidebarGroup };

/** The app shell: the sidebar, the page beside it, and the dialogs; the work is in the hooks and components it composes. */
export default function App() {
  const [modal, dispatchModal] = useReducer(modalReducer, null);
  const googleUsageAccount = modal?.kind === "googleUsage" ? modal.account : null;
  const setGoogleUsageAccount = useCallback(
    (account: Account | null) =>
      dispatchModal(account ? { type: "open", modal: { kind: "googleUsage", account } } : { type: "close", kind: "googleUsage" }),
    [],
  );
  const nav = useSidebarNavigation();
  const { selectedGroupId, section, sidebarOpen } = nav;
  const { providerOrder, groupOrder: sidebarGroupOrder, pageOrderVersion } = useLayout();
  const [groupAnnouncement, setGroupAnnouncement] = useState("");
  useTouchTooltips();
  useDragReorder();
  const shellRef = useRef<HTMLDivElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const { overlay: sidebarIsOverlay } = useSidebarOverlay(sidebarRef, sidebarOpen, nav.closeSidebar);
  // As an off-canvas overlay the sidebar is a modal dialog while open and unreachable while closed.
  const sidebarModal = sidebarIsOverlay && sidebarOpen;
  const sidebarHidden = sidebarIsOverlay && !sidebarOpen;
  // The same overlay layout gets a bottom bar instead of the sidebar's Usage, Accounts and Settings links.
  const bottomNavVisible = useBottomNavVisible(sidebarIsOverlay);

  const busyKeys = useBusyKeys();
  const { busy } = busyKeys;
  const { errors, report: reportError, clear: clearError } = useAppErrors();
  // The Settings page reads these two from context (settings-context.tsx); they run here because
  // the dashboard, the pairing dialog and the update-notes dialog need them on every page.
  const settings = useAppSettings({ reportError, clearError });
  const { appSettings, reloadFromBackend } = settings;
  const { snapshot, setSnapshot, load } = useDashboardData({
    reportError,
    clearError,
    accountRefreshMinutes: appSettings?.accountRefreshMinutes,
  });
  const update = useAppUpdate({ automaticUpdatesEnabled: appSettings?.automaticUpdatesEnabled });
  const { alerts: inAppAlerts, dismiss: dismissAlert } = useUsageAlerts();
  const { pairingOpen, setPairingOpen, pairingInitialUri, closePairing } = usePairingEvents();
  const {
    refreshOne,
    refreshAll,
    rename,
    remove,
    setApiIntegrationEnabled,
    openApiIntegrationWindow,
  } = useAccountActions({ load, setSnapshot, busy: busyKeys, reportError, clearError });
  const unprotectedSignIns = useUnprotectedSignIns({ snapshot, load, modal, dispatchModal, reportError, clearError });
  useAppMigrations(snapshot);

  const openAdd = useCallback((account?: Account, provider?: Provider) => {
    dispatchModal({ type: "open", modal: { kind: "add", label: account?.label ?? "", provider: account?.provider ?? provider, reconnectAccountId: account?.id } });
  }, []);

  const openNewBucket = useCallback((provider?: Provider | null) => {
    dispatchModal({ type: "open", modal: { kind: "bucket", bucket: null, provider: provider ?? null, confirmDelete: false } });
  }, []);

  const openEditBucket = useCallback((bucket: AccountBucket) => {
    dispatchModal({ type: "open", modal: { kind: "bucket", bucket, provider: bucket.provider, confirmDelete: false } });
  }, []);

  const openDeleteBucket = useCallback((bucket: AccountBucket) => {
    dispatchModal({ type: "open", modal: { kind: "bucket", bucket, provider: bucket.provider, confirmDelete: true } });
  }, []);

  const openLink = useCallback((url: string) => {
    void openSafeUrl(url)
      .then(() => clearError("open-link"))
      .catch((cause) => reportError("open-link", cause, "Couldn't open the link"));
  }, [clearError, reportError]);

  const handlePairingCompleted = useCallback(async () => {
    await load();
    await reloadFromBackend();
    // Have the dashboard re-apply any transferred UI state
    requestDashboardResync();
  }, [load, reloadFromBackend]);

  // A sign-in failure is reported here only when no dialog that shows it inline is open,
  // so the subscription is renewed whenever one of those dialogs opens or closes.
  const addOpen = modal?.kind === "add";
  const googleUsageOpen = googleUsageAccount != null;
  useEffect(() => {
    return subscribeLoginStatus((status) => {
      if (status.status === "complete") {
        clearError("login");
        void load();
        return;
      }
      if (status.status === "failed") {
        if (status.message && !addOpen && !googleUsageOpen) {
          reportError("login", status.message, "Sign-in failed");
        }
        return;
      }
      if ((status.status === "choose_project" || status.status === "monitoring_disabled") && status.account) {
        setGoogleUsageAccount(status.account);
      }
    });
  }, [load, clearError, reportError, addOpen, googleUsageOpen, setGoogleUsageAccount]);

  useEffect(() => {
    void resumeLoginAttemptWatch();
  }, []);

  const accounts = snapshot?.accounts ?? NO_ACCOUNTS;
  const buckets = snapshot?.buckets ?? NO_BUCKETS;

  const sidebarGroups = useMemo<SidebarGroup[]>(
    () => buildSidebarGroups(accounts, buckets, providerOrder, sidebarGroupOrder),
    [accounts, buckets, providerOrder, sidebarGroupOrder],
  );

  const allAccountsGroup = useMemo<SidebarGroup>(() => buildAllAccountsGroup(accounts), [accounts]);

  useEffect(() => {
    if (selectedGroupId === ALL_ACCOUNTS_GROUP_ID) return;
    if (!sidebarGroups.some((group) => group.id === selectedGroupId)) {
      nav.resetGroup();
    }
  }, [selectedGroupId, sidebarGroups, nav]);

  const selectedGroup = useMemo<SidebarGroup>(() => {
    if (selectedGroupId === ALL_ACCOUNTS_GROUP_ID) return allAccountsGroup;
    return sidebarGroups.find((group) => group.id === selectedGroupId) ?? allAccountsGroup;
  }, [selectedGroupId, sidebarGroups, allAccountsGroup]);

  useGroupOrderReconcile({ snapshot, accounts, buckets });

  // The page order lives in storage, not in state; the layout store's version says it was saved
  // again and must be re-read.
  const visibleAccounts = useMemo(
    () => applyPageAccountOrder(selectedGroup.accounts, selectedGroup.id),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selectedGroup, pageOrderVersion],
  );
  // The Usage page lists accounts in the order of the All accounts page.
  const activityAccounts = useMemo(
    () => applyPageAccountOrder(allAccountsGroup.accounts, ALL_ACCOUNTS_GROUP_ID),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [allAccountsGroup, pageOrderVersion],
  );

  const loadError = errors.find((entry) => entry.source === "load");

  useKeyboardShortcuts(!isMobileDevice(), {
    refreshAll: () => void refreshAll(),
    openSettings: nav.toggleSettings,
    showActivity: nav.showActivity,
    showAccounts: nav.showAccounts,
    addAccount: () => {
      openAdd(undefined, selectedGroup.provider ?? undefined);
    },
    addGroup: () => {
      openNewBucket(selectedGroup.provider);
    },
  });

  const isInitialMount = useRef(true);
  const activeViewKey = `${section}:${selectedGroupId}`;
  useEffect(() => {
    if (isInitialMount.current) {
      isInitialMount.current = false;
      return;
    }
    // After view changes, move focus to the new view's primary heading so screen readers announce it.
    // preventScroll keeps that move from jumping the page back to the top.
    window.setTimeout(() => {
      const heading = document.querySelector<HTMLElement>(".main-stage .kept-page:not([hidden]) h1.eyebrow");
      heading?.focus({ preventScroll: true });
    }, 0);
  }, [activeViewKey]);

  // Usage, Accounts, and Settings stay mounted. Putting the saved position back covers a browser
  // that clears scrollTop while a page is hidden.
  useLayoutEffect(() => watchPageScrollRestore(section), [section]);

  const moveGroup = (group: SidebarGroup, delta: -1 | 1) => {
    const move = moveById(sidebarGroups.map((candidate) => candidate.id), group.id, delta);
    if (!move) return;
    storeSidebarGroupOrder(move.ids);
    void persistGroupOrder(move.ids);
    setGroupAnnouncement(moveAnnouncement(group.title, move.to, move.ids.length));
    // React moves the row's DOM node, which drops focus; put it back once the move has rendered.
    window.setTimeout(() => {
      document.querySelector<HTMLElement>(`.provider-summary-row[data-group-id="${CSS.escape(group.id)}"]`)?.focus();
    }, 0);
  };

  // What the dialogs do when they are done.
  const handleAccountAdded = useAfterAccountAdded({
    closeAddDialog: useCallback(() => dispatchModal({ type: "close", kind: "add" }), []),
    selectGroup: nav.selectGroup,
    load,
    reportError,
    openGoogleUsage: setGoogleUsageAccount,
  });
  const handleBucketSaved = useCallback(
    async (saved: AccountBucket) => {
      dispatchModal({ type: "close", kind: "bucket" });
      nav.selectGroup(bucketGroupId(saved.id));
      await load();
    },
    [nav, load],
  );
  const handleBucketDeleted = useCallback(
    async (deletedId: string) => {
      dispatchModal({ type: "close", kind: "bucket" });
      if (selectedGroupId === bucketGroupId(deletedId)) nav.resetGroup();
      await load();
    },
    [nav, load, selectedGroupId],
  );
  const handleGoogleUsageConnected = useCallback(async () => {
    setGoogleUsageAccount(null);
    await load();
  }, [setGoogleUsageAccount, load]);
  const handleUsageCleared = useCallback(async () => {
    // Show the accounts without usage first, then fill them in again.
    await load();
    await refreshAll();
  }, [load, refreshAll]);
  const handleRefreshUsage = useCallback(async () => {
    try {
      await bridgeApi.clearCachedUsage();
      await handleUsageCleared();
      clearError("refresh-usage");
    } catch (cause) {
      reportError("refresh-usage", cause, "Couldn't refresh usage");
    }
  }, [handleUsageCleared, clearError, reportError]);
  // Everything the backend kept is gone; the saved layout goes too, and the reload makes every
  // screen and in-memory store start over instead of showing removed accounts.
  const handleAllDataDeleted = useCallback(() => {
    clearAppStorage();
    window.location.reload();
  }, []);
  const handleAlertSaved = useCallback(async () => {
    dispatchModal({ type: "close", kind: "alert" });
    await load();
  }, [load]);

  const renderContent = () => (
    <>
      <div className="kept-page" data-page="activity" hidden={section !== "activity"} inert={section !== "activity"}>
        <ActivityView
          accounts={activityAccounts}
          onToggleSidebar={nav.toggleSidebar}
          sidebarOpen={sidebarOpen}
          onAddAccount={() => openAdd()}
          onReconnect={(account) => account.provider === "google_ai_studio" ? setGoogleUsageAccount(account) : openAdd(account)}
          onRefresh={accounts.length === 0 ? undefined : handleRefreshUsage}
        />
      </div>
      <div className="kept-page" data-page="accounts" hidden={section !== "accounts"} inert={section !== "accounts"}>
        <AccountsView
          allAccounts={accounts}
          accounts={visibleAccounts}
          selectedGroup={selectedGroup}
          refreshMinutes={appSettings?.accountRefreshMinutes ?? DEFAULT_ACCOUNT_REFRESH_MINUTES}
          onToggleSidebar={nav.toggleSidebar}
          sidebarOpen={sidebarOpen}
          onAdd={(provider) => openAdd(undefined, provider ?? selectedGroup.provider ?? undefined)}
          onOpenPairing={() => setPairingOpen(true)}
          onRefreshAll={refreshAll}
          onEditBucket={openEditBucket}
          onDeleteBucket={openDeleteBucket}
          onRefresh={(account) => void refreshOne(account.id)}
          onReconnect={(account) => account.provider === "google_ai_studio" ? setGoogleUsageAccount(account) : openAdd(account)}
          onConnectGoogleUsage={setGoogleUsageAccount}
          onRename={(account, label) => rename(account, label)}
          onRemove={(account) => dispatchModal({ type: "open", modal: { kind: "remove", account } })}
          onNotifications={(account) => dispatchModal({ type: "open", modal: { kind: "alert", account } })}
          busy={busy}
          unprotectedAccountIds={snapshot?.unprotectedAccountIds}
        />
      </div>
      <div className="kept-page" data-page="settings" hidden={section !== "settings"} inert={section !== "settings"}>
        <AppSettingsContext.Provider value={settings}>
          <AppUpdateContext.Provider value={update}>
            <SettingsView
              onToggleSidebar={nav.toggleSidebar}
              sidebarOpen={sidebarOpen}
              onOpenPairing={() => setPairingOpen(true)}
              onOpenLink={openLink}
              bridge={snapshot?.bridge ?? null}
              bridgeBusy={busy.has("toggle-api-integration")}
              integrationWindowBusy={busy.has("open-api-integration")}
              onToggleBridge={(enabled) => void setApiIntegrationEnabled(enabled)}
              onViewBridgeWindow={() => void openApiIntegrationWindow()}
              onOpenUpdateNotes={() => update.setUpdateNotesOpen(true)}
              onUsageCleared={handleUsageCleared}
              onAllDataDeleted={handleAllDataDeleted}
            />
          </AppUpdateContext.Provider>
        </AppSettingsContext.Provider>
      </div>
    </>
  );

  return (
    <div ref={shellRef} className={`app-shell obsidian-shell${bottomNavVisible ? " has-bottom-nav" : ""}`}>
      <div
        className={`sidebar-backdrop ${sidebarOpen ? "active" : ""}`}
        onClick={nav.closeSidebar}
        role="presentation"
        aria-hidden="true"
      />
      <Sidebar
        sidebarRef={sidebarRef}
        shellRef={shellRef}
        open={sidebarOpen}
        hidden={sidebarHidden}
        modal={sidebarModal}
        section={section}
        selectedGroupId={selectedGroup.id}
        allAccountsGroup={allAccountsGroup}
        groups={sidebarGroups}
        accounts={accounts}
        refreshMinutes={appSettings?.accountRefreshMinutes ?? DEFAULT_ACCOUNT_REFRESH_MINUTES}
        busy={busy}
        showMainNav={!sidebarIsOverlay}
        onClose={nav.closeSidebar}
        onAddAccount={() => {
          openAdd(undefined, selectedGroup.provider ?? undefined);
          nav.closeSidebar();
        }}
        onAddGroup={() => {
          openNewBucket(selectedGroup.provider);
          nav.closeSidebar();
        }}
        onSelectGroup={(groupId) => nav.selectGroup(groupId, { closeSidebar: true })}
        onMoveGroup={moveGroup}
        onRefreshAll={() => void refreshAll()}
        onOpenSettings={nav.showSettings}
        onOpenActivity={nav.showActivity}
        onOpenAccounts={nav.showAccounts}
      />

      <main className="main-stage" inert={sidebarModal}>
        {snapshot ? renderContent() : (
          <div className="loading-screen" aria-busy="true" aria-live="polite">
            {loadError ? (
              <div className="loading-error" role="alert">
                <div className="error-panel" role="alert">{loadError.message}</div>
                <button className="button" type="button" autoFocus onClick={() => { clearError("load"); void load(); }}>
                  Retry
                </button>
              </div>
            ) : (
              <div className="skeleton-grid" aria-label="Loading accounts">
                <div className="skeleton-card" aria-hidden="true"><span className="skeleton-line" /><span className="skeleton-line short" /></div>
                <div className="skeleton-card" aria-hidden="true"><span className="skeleton-line" /><span className="skeleton-line short" /></div>
                <div className="skeleton-card" aria-hidden="true"><span className="skeleton-line" /><span className="skeleton-line short" /></div>
                <span className="sr-only">Loading accounts…</span>
              </div>
            )}
          </div>
        )}
      </main>

      {bottomNavVisible ? (
        <BottomNav
          section={section}
          inert={sidebarModal}
          onSelect={(target) => {
            if (target === "activity") nav.showActivity();
            else if (target === "accounts") nav.showAccounts();
            else nav.showSettings();
          }}
        />
      ) : null}

      <AppModals
        modal={modal}
        dispatchModal={dispatchModal}
        accounts={accounts}
        busy={busy}
        openLink={openLink}
        onAccountAdded={handleAccountAdded}
        onBucketSaved={handleBucketSaved}
        onBucketDeleted={handleBucketDeleted}
        googleUsageAccount={googleUsageAccount}
        onGoogleUsageClose={() => setGoogleUsageAccount(null)}
        onGoogleUsageConnected={handleGoogleUsageConnected}
        onAlertSaved={handleAlertSaved}
        onRemoveAccount={(account, onStarted) => void remove(account, onStarted)}
        unprotectedSignIns={unprotectedSignIns}
        pairing={{ open: pairingOpen, initialUri: pairingInitialUri, onClose: closePairing, onCompleted: handlePairingCompleted }}
        update={update}
        onCloseUpdateNotes={() => update.setUpdateNotesOpen(false)}
      />
      <ErrorBanner
        errors={snapshot ? errors : errors.filter((entry) => entry.source !== "load")}
        onDismiss={clearError}
      />
      <UsageAlertToasts alerts={inAppAlerts} onDismiss={dismissAlert} />
      <p id={GROUP_REORDER_HINT_ID} className="sr-only">Press Alt with the up or down arrow key to move this group.</p>
      <div className="sr-only" role="status" aria-live="polite">{groupAnnouncement}</div>
    </div>
  );
}

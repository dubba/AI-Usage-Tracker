import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { bridgeApi } from "./api";
import { logIgnored } from "./log";
import { modalReducer } from "./modal-state";
import { openSafeUrl } from "./utils/safeUrl";
import { busyKey, useBusyKeys } from "./busy";
import { useAppErrors } from "./errors";
import { resumeLoginAttemptWatch, subscribeLoginStatus } from "./login-status";
import { AccountAlertModal } from "./components/AccountAlertModal";
import { AccountsView } from "./components/AccountsView";
import { SyncStatusLine } from "./components/SyncStatusLine";
import { RemoveAccountModal } from "./components/RemoveAccountModal";
import { AddAccountModal } from "./components/AddAccountModal";
import { BucketModal } from "./components/BucketModal";
import { ErrorBanner } from "./components/ErrorBanner";
import { GoogleAiStudioUsageModal } from "./components/GoogleAiStudioUsageModal";
import { PairingModal } from "./components/PairingModal";
import { SettingsView } from "./components/SettingsView";
import { GROUP_REORDER_HINT_ID, SidebarGroupRow } from "./components/SidebarGroupRow";
import { SidebarResizeHandle } from "./components/SidebarResizeHandle";
import { UsageAlertToasts } from "./components/UsageAlertToasts";
import "./pairing.css";
import { persistGroupOrder } from "./reorder";
import {
  DASHBOARD_GROUP_ORDER_EVENT,
  DASHBOARD_PROVIDER_ORDER_EVENT,
  readDashboardProviderOrder,
  readSidebarGroupOrder,
  storeSidebarGroupOrder,
} from "./sidebar-order";
import {
  applyPageAccountOrder,
  DASHBOARD_PAGE_ORDER_EVENT,
  migrateLegacyAllPageOrder,
  migrateLegacyCollapsedCards,
} from "./dashboard-page-state";
import { DEFAULT_ACCOUNT_REFRESH_MINUTES } from "./constants";
import { useAccountActions } from "./hooks/useAccountActions";
import { useAppSettings } from "./hooks/useAppSettings";
import { useAppUpdate } from "./hooks/useAppUpdate";
import { useDashboardData } from "./hooks/useDashboardData";
import { useDragReorder } from "./hooks/useDragReorder";
import { usePairingEvents } from "./hooks/usePairingEvents";
import { useSidebarOverlay } from "./hooks/useSidebarOverlay";
import { useTouchTooltips } from "./hooks/useTouchTooltips";
import { useUsageAlerts } from "./hooks/useUsageAlerts";
import {
  CloseIcon,
  GaugeIcon,
  PlusIcon,
  SettingsIcon,
} from "./icons";
import {
  ALL_ACCOUNTS_GROUP_ID,
  buildAllAccountsGroup,
  buildSidebarGroups,
  type SidebarGroup,
} from "./sidebar-groups";
import { moveAnnouncement, moveById } from "./reorder/reorder-utils";
import { requestDashboardResync } from "./events";
import { accountNeedsAttention, displayAccountLabel, googleAiStudioHasQuotaWindows } from "./usage-logic";
import type { Account, AccountBucket, Provider } from "./types";

export type { SidebarGroup };

type Section = "accounts" | "settings";

export default function App() {
  const [selectedGroupId, setSelectedGroupId] = useState(ALL_ACCOUNTS_GROUP_ID);
  const [providerOrder, setProviderOrder] = useState<Provider[]>(readDashboardProviderOrder);
  const [sidebarGroupOrder, setSidebarGroupOrder] = useState<string[]>(readSidebarGroupOrder);
  const [pageOrderTick, setPageOrderTick] = useState(0);
  const [section, setSection] = useState<Section>("accounts");
  const [modal, dispatchModal] = useReducer(modalReducer, null);
  const addModal = modal?.kind === "add" ? modal : null;
  const addOpen = addModal != null;
  const bucketModal = modal?.kind === "bucket" ? modal : null;
  const alertAccount = modal?.kind === "alert" ? modal.account : null;
  const accountToRemove = modal?.kind === "remove" ? modal.account : null;
  const googleUsageAccount = modal?.kind === "googleUsage" ? modal.account : null;
  const setGoogleUsageAccount = useCallback(
    (account: Account | null) =>
      dispatchModal(account ? { type: "open", modal: { kind: "googleUsage", account } } : { type: "close", kind: "googleUsage" }),
    [],
  );
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [groupAnnouncement, setGroupAnnouncement] = useState("");
  useTouchTooltips();
  useDragReorder();
  const shellRef = useRef<HTMLDivElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const { overlay: sidebarIsOverlay } = useSidebarOverlay(sidebarRef, sidebarOpen, () => setSidebarOpen(false));
  // As an off-canvas overlay the sidebar is a modal dialog while open and unreachable while closed.
  const sidebarModal = sidebarIsOverlay && sidebarOpen;
  const sidebarHidden = sidebarIsOverlay && !sidebarOpen;

  const busyKeys = useBusyKeys();
  const { busy } = busyKeys;
  const { errors, report: reportError, clear: clearError } = useAppErrors();
  const {
    appSettings,
    autostart,
    settingsBusy,
    reloadFromBackend,
    saveAccountRefreshMinutes,
    saveAutomaticUpdatesEnabled,
    saveIncludeBetaUpdates,
    toggleAutostart,
  } = useAppSettings({ reportError, clearError });
  const { snapshot, setSnapshot, load } = useDashboardData({
    reportError,
    clearError,
    accountRefreshMinutes: appSettings?.accountRefreshMinutes,
  });
  const {
    installedVersion,
    appUpdate,
    updateBusy,
    updateProgress,
    updateError,
    updateMessage,
    checkForUpdate,
    installUpdate,
  } = useAppUpdate({ automaticUpdatesEnabled: appSettings?.automaticUpdatesEnabled });
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

  const openAdd = useCallback((account?: Account, provider?: Provider) => {
    dispatchModal({ type: "open", modal: { kind: "add", label: account?.label ?? "", provider: account?.provider ?? provider } });
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

  useEffect(() => {
    migrateLegacyCollapsedCards();
    const onPageOrder = () => setPageOrderTick((tick) => tick + 1);
    window.addEventListener(DASHBOARD_PAGE_ORDER_EVENT, onPageOrder);
    return () => window.removeEventListener(DASHBOARD_PAGE_ORDER_EVENT, onPageOrder);
  }, []);

  // Older versions kept a separate saved order for the "all" page. Once the accounts are known,
  // fold it into the backend order (which that page now follows) so the page looks the same.
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

  // A sign-in failure is reported here only when no dialog that shows it inline is open,
  // so the subscription is renewed whenever one of those dialogs opens or closes.
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

  useEffect(() => {
    const handleOrderChange = () => {
      setProviderOrder(readDashboardProviderOrder());
      setSidebarGroupOrder(readSidebarGroupOrder());
    };
    window.addEventListener(DASHBOARD_GROUP_ORDER_EVENT, handleOrderChange);
    window.addEventListener(DASHBOARD_PROVIDER_ORDER_EVENT, handleOrderChange);
    return () => {
      window.removeEventListener(DASHBOARD_GROUP_ORDER_EVENT, handleOrderChange);
      window.removeEventListener(DASHBOARD_PROVIDER_ORDER_EVENT, handleOrderChange);
    };
  }, []);

  const accounts = snapshot?.accounts ?? [];
  const buckets = snapshot?.buckets ?? [];

  const sidebarGroups = useMemo<SidebarGroup[]>(
    () => buildSidebarGroups(accounts, buckets, providerOrder, sidebarGroupOrder),
    [accounts, buckets, providerOrder, sidebarGroupOrder],
  );

  const allAccountsGroup = useMemo<SidebarGroup>(() => buildAllAccountsGroup(accounts), [accounts]);

  useEffect(() => {
    if (selectedGroupId === ALL_ACCOUNTS_GROUP_ID) return;
    if (!sidebarGroups.some((group) => group.id === selectedGroupId)) {
      setSelectedGroupId(ALL_ACCOUNTS_GROUP_ID);
    }
  }, [selectedGroupId, sidebarGroups]);

  const selectedGroup = useMemo<SidebarGroup>(() => {
    if (selectedGroupId === ALL_ACCOUNTS_GROUP_ID) return allAccountsGroup;
    return sidebarGroups.find((group) => group.id === selectedGroupId) ?? allAccountsGroup;
  }, [selectedGroupId, sidebarGroups, allAccountsGroup]);

  const visibleAccounts = useMemo(
    () => applyPageAccountOrder(selectedGroup.accounts, selectedGroup.id),
    [selectedGroup, pageOrderTick],
  );
  const needsAttention = visibleAccounts.filter(accountNeedsAttention).length;

  const loadError = errors.find((entry) => entry.source === "load");

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

  const renderContent = () => {
    if (section === "settings") {
      return (
        <SettingsView
          autostart={autostart}
          onToggleAutostart={toggleAutostart}
          appSettings={appSettings}
          settingsBusy={settingsBusy}
          onAccountRefreshMinutesChange={(minutes) => void saveAccountRefreshMinutes(minutes)}
          onAutomaticUpdatesChange={(enabled) => void saveAutomaticUpdatesEnabled(enabled)}
          onIncludeBetaUpdatesChange={(enabled) => void saveIncludeBetaUpdates(enabled)}
          installedVersion={installedVersion}
          update={appUpdate}
          updateBusy={updateBusy}
          updateProgress={updateProgress}
          updateError={updateError}
          updateMessage={updateMessage}
          onCheckForUpdate={() => void checkForUpdate(true)}
          onInstallUpdate={() => void installUpdate()}
          onToggleSidebar={() => setSidebarOpen((prev) => !prev)}
          onOpenPairing={() => setPairingOpen(true)}
          onOpenLink={openLink}
          bridge={snapshot?.bridge ?? null}
          bridgeBusy={busy.has("toggle-api-integration") || busy.has("open-api-integration")}
          onToggleBridge={(enabled) => void setApiIntegrationEnabled(enabled)}
          onViewBridgeWindow={() => void openApiIntegrationWindow()}
        />
      );
    }
    return (
      <AccountsView
        allAccounts={accounts}
        accounts={visibleAccounts}
        selectedGroup={selectedGroup}
        needsAttention={needsAttention}
        refreshMinutes={appSettings?.accountRefreshMinutes ?? DEFAULT_ACCOUNT_REFRESH_MINUTES}
        onToggleSidebar={() => setSidebarOpen((prev) => !prev)}
        onAdd={() => openAdd(undefined, selectedGroup.provider ?? undefined)}
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
      />
    );
  };

  return (
    <div ref={shellRef} className="app-shell obsidian-shell">
      <div
        className={`sidebar-backdrop ${sidebarOpen ? "active" : ""}`}
        onClick={() => setSidebarOpen(false)}
        aria-hidden="true"
      />
      <aside
        ref={sidebarRef}
        className={`sidebar ${sidebarOpen ? "mobile-open" : ""}`}
        inert={sidebarHidden}
        role={sidebarModal ? "dialog" : undefined}
        aria-modal={sidebarModal ? true : undefined}
        aria-label={sidebarModal ? "Navigation menu" : undefined}
      >
        <div className="sidebar-mobile-header">
          <button
            type="button"
            className="mobile-sidebar-toggle-btn mobile-sidebar-close-btn"
            onClick={() => setSidebarOpen(false)}
            aria-label="Close navigation menu"
            data-tooltip="Close navigation menu"
          >
            <CloseIcon />
          </button>
          <span className="eyebrow sidebar-title">AI Usage Tracker</span>
        </div>
        <div className="brand">
          <span className="brand-mark"><GaugeIcon /></span>
          <strong>AI Usage Tracker</strong>
        </div>

        <div className="provider-sidebar-heading">
          <span>Accounts</span>
          <div className="provider-sidebar-heading-actions">
            <button
              type="button"
              className="button primary compact-button add-bucket-header-button"
              data-tooltip="Create a custom group"
              aria-label="Create a custom group"
              onClick={() => { openNewBucket(selectedGroup.provider); setSidebarOpen(false); }}
            >
              <PlusIcon />Group
            </button>
          </div>
        </div>

        <div className="provider-list">
          <SidebarGroupRow
            group={allAccountsGroup}
            selected={section === "accounts" && selectedGroup.id === ALL_ACCOUNTS_GROUP_ID}
            onSelect={() => {
              setSelectedGroupId(ALL_ACCOUNTS_GROUP_ID);
              setSection("accounts");
              setSidebarOpen(false);
            }}
          />
          {sidebarGroups.map((group, index) => (
            <SidebarGroupRow
              key={group.id}
              group={group}
              onMove={
                (delta) => {
                  const target = index + delta;
                  if (target >= 0 && target < sidebarGroups.length) moveGroup(group, delta);
                }
              }
              selected={section === "accounts" && selectedGroup.id === group.id}
              onSelect={() => {
                setSelectedGroupId(group.id);
                setSection("accounts");
                setSidebarOpen(false);
              }}
            />
          ))}
          {accounts.length === 0 && buckets.length === 0 ? (
            <button className="empty-account provider-empty" onClick={() => { openAdd(); setSidebarOpen(false); }}>
              <PlusIcon /><span>Add your first account</span>
            </button>
          ) : null}
        </div>

        <SyncStatusLine
          accounts={accounts}
          refreshMinutes={appSettings?.accountRefreshMinutes ?? DEFAULT_ACCOUNT_REFRESH_MINUTES}
          busy={busy}
        />
        <button
          type="button"
          className={`sidebar-footer${section === "settings" ? " active" : ""}`}
          aria-current={section === "settings" ? "page" : undefined}
          onClick={() => {
            setSection("settings");
            setSidebarOpen(false);
          }}
          aria-label="Open settings"
        >
          <SettingsIcon />
          <span>Settings</span>
        </button>
        <SidebarResizeHandle shellRef={shellRef} sidebarRef={sidebarRef} />
      </aside>

      <main className="main-stage" inert={sidebarModal}>
        {snapshot ? renderContent() : (
          <div className="loading-screen" aria-busy="true" aria-live="polite">
            {loadError ? (
              <div className="loading-error" role="alert">
                <div className="error-panel">{loadError.message}</div>
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

      <AddAccountModal
        open={addOpen}
        initialLabel={addModal?.label ?? ""}
        initialProvider={addModal?.provider}
        onClose={() => dispatchModal({ type: "close", kind: "add" })}
        onAdded={async (account) => {
          dispatchModal({ type: "close", kind: "add" });
          setSelectedGroupId(`provider:${account.provider}`);
          setSection("accounts");
          let nextAccount = account;
          try {
            nextAccount = await bridgeApi.refreshAccount(account.id);
          } catch (cause) {
            // The account is saved and stays available with cached state; say that the first refresh failed.
            reportError(busyKey("refresh", account.id), cause, `Added ${displayAccountLabel(account)}, but couldn't refresh it yet`);
          }
          await load();
          if (nextAccount.provider === "google_ai_studio" && !googleAiStudioHasQuotaWindows(nextAccount)) {
            setGoogleUsageAccount(nextAccount);
          }
        }}
      />
      <BucketModal
        open={bucketModal != null}
        bucket={bucketModal?.bucket ?? null}
        initialProvider={bucketModal?.provider ?? null}
        accounts={accounts}
        initialConfirmDelete={bucketModal?.confirmDelete ?? false}
        onClose={() => dispatchModal({ type: "close", kind: "bucket" })}
        onSaved={async (saved) => {
          dispatchModal({ type: "close", kind: "bucket" });
          setSelectedGroupId(`bucket:${saved.id}`);
          await load();
        }}
        onDeleted={async (deletedId) => {
          dispatchModal({ type: "close", kind: "bucket" });
          if (selectedGroupId === `bucket:${deletedId}`) {
            setSelectedGroupId(ALL_ACCOUNTS_GROUP_ID);
          }
          await load();
        }}
      />
      <GoogleAiStudioUsageModal
        account={googleUsageAccount}
        onClose={() => setGoogleUsageAccount(null)}
        onConnected={async () => {
          setGoogleUsageAccount(null);
          await load();
        }}
      />
      <AccountAlertModal
        account={alertAccount}
        onClose={() => dispatchModal({ type: "close", kind: "alert" })}
        onSaved={async () => {
          dispatchModal({ type: "close", kind: "alert" });
          await load();
        }}
      />
      <RemoveAccountModal
        account={accountToRemove}
        busy={Boolean(accountToRemove && busy.has(busyKey("remove", accountToRemove.id)))}
        onClose={() => dispatchModal({ type: "close", kind: "remove" })}
        onConfirm={() => {
          if (accountToRemove) void remove(accountToRemove);
        }}
      />
      <PairingModal
        open={pairingOpen}
        initialJoinUri={pairingInitialUri}
        onClose={closePairing}
        onCompleted={handlePairingCompleted}
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










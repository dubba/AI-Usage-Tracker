import { useCallback, useEffect, useMemo, useState } from "react";
import { disable, enable, isEnabled } from "@tauri-apps/plugin-autostart";
import { bridgeApi } from "./api";
import { AccountAlertModal } from "./components/AccountAlertModal";
import { AddAccountModal } from "./components/AddAccountModal";
import { GoogleAiStudioUsageModal } from "./components/GoogleAiStudioUsageModal";
import { ProviderIcon } from "./components/ProviderIcon";
import {
  DASHBOARD_PROVIDER_ORDER_EVENT,
  readDashboardProviderOrder,
} from "./dashboard-reorder";
import {
  BellIcon,
  CheckCircleIcon,
  ClockIcon,
  CloseIcon,
  EditIcon,
  GaugeIcon,
  LinkIcon,
  PlusIcon,
  RefreshIcon,
  SettingsIcon,
  UsersIcon,
} from "./icons";
import { APP_UPDATE_STATUS_EVENT, publishAppUpdateStatus } from "./sidebar-update-control";
import type {
  Account,
  AppSettings,
  AppUpdateStatus,
  BridgeInfo,
  DashboardSnapshot,
  Provider,
  UsageWindow,
} from "./types";

type Section = "accounts" | "integration" | "settings";
type UpdateBusy = "checking" | "installing" | null;
type SidebarWindow = "five_hour" | "weekly";

type ProviderGroup = {
  provider: Provider;
  accounts: Account[];
};

type NextResetSummary = {
  account: string | null;
  value: string;
  resetsAt: string | null;
};

const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;
const DASHBOARD_SYNC_INTERVAL_MS = 30 * 1000;
const STARTUP_REFRESH_DELAY_MS = 3 * 1000;
const ACCOUNT_REFRESH_OPTIONS = Array.from({ length: 12 }, (_, index) => (index + 1) * 5);
const SIDEBAR_WINDOW_KEY = "ai-subscription-tracker:provider-average-window";

function providerName(provider: Provider): string {
  switch (provider) {
    case "openai": return "OpenAI Codex";
    case "anthropic": return "Anthropic Claude";
    case "antigravity": return "Google Antigravity";
    case "google_ai_studio": return "Google AI Studio";
    case "grok": return "Grok / SuperGrok";
    case "opencode_go": return "OpenCode Go";
  }
}

function formatTime(value: string | null | undefined): string {
  if (!value) return "Reset time unavailable";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Reset time unavailable";
  return date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

function isGoogleAiStudioSetupSource(account: Account): boolean {
  return account.provider === "google_ai_studio"
    && (account.lastUsage?.source === "google_ai_studio_model_access"
      || account.lastUsage?.source === "google_ai_studio_monitoring_waiting");
}

function accountNeedsAttention(account: Account): boolean {
  if (!account.authRequired && !account.lastError && isGoogleAiStudioSetupSource(account)) return false;
  return Boolean(
    account.authRequired
    || account.lastError
    || !account.lastUsage
    || account.lastUsage.freshness !== "live",
  );
}

function accountStatus(account: Account): { label: string; className: string } {
  if (account.authRequired || account.lastUsage?.freshness === "auth_required") {
    return { label: "AUTH NEEDED", className: "danger" };
  }
  if (account.lastError || account.lastUsage?.freshness === "stale") {
    return { label: "ATTENTION", className: "warning" };
  }
  if (account.provider === "google_ai_studio" && account.lastUsage?.source === "google_ai_studio_model_access") {
    return { label: "CONNECTED", className: "success" };
  }
  if (account.provider === "google_ai_studio" && account.lastUsage?.source === "google_ai_studio_monitoring_waiting") {
    return { label: "WAITING", className: "neutral" };
  }
  if (!account.lastUsage || account.lastUsage.freshness === "unavailable") {
    return { label: "INACTIVE", className: "neutral" };
  }
  return { label: "LIVE", className: "success" };
}

function canonicalWindow(window: UsageWindow, target: SidebarWindow): boolean {
  const id = window.id.toLowerCase().replaceAll("-", "_");
  const label = window.label.toLowerCase();
  if (target === "five_hour") {
    return id === "five_hour"
      || id === "rolling"
      || window.windowSeconds === 18_000
      || label.includes("5 hour")
      || label.includes("five hour");
  }
  return id === "weekly"
    || window.windowSeconds === 604_800
    || label.includes("weekly")
    || label.includes("7 day")
    || label.includes("seven day");
}

function accountWindowRemaining(account: Account, target: SidebarWindow): number | null {
  const window = account.lastUsage?.windows.find((candidate) => canonicalWindow(candidate, target));
  return window?.remainingPercent ?? null;
}

function providerAverage(accounts: Account[], target: SidebarWindow): number | null {
  const values = accounts
    .map((account) => accountWindowRemaining(account, target))
    .filter((value): value is number => value != null && Number.isFinite(value));
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function nextResetSummary(accounts: Account[]): NextResetSummary {
  const now = Date.now();
  const candidates = accounts.flatMap((account) =>
    (account.lastUsage?.windows ?? []).flatMap((window) => {
      if (!window.resetsAt) return [];
      const resetAt = new Date(window.resetsAt).getTime();
      if (!Number.isFinite(resetAt) || resetAt <= now) return [];
      return [{ resetAt, account: account.label, resetsAt: window.resetsAt }];
    }),
  );

  if (!candidates.length) {
    return { account: null, value: "—", resetsAt: null };
  }

  candidates.sort((left, right) => left.resetAt - right.resetAt);
  const next = candidates[0];
  const remainingMinutes = Math.max(1, Math.ceil((next.resetAt - now) / 60_000));
  const value = remainingMinutes < 60
    ? `${remainingMinutes}m`
    : remainingMinutes < 24 * 60
      ? `${Math.ceil(remainingMinutes / 60)}h`
      : `${Math.ceil(remainingMinutes / (24 * 60))}d`;

  return { account: next.account, value, resetsAt: next.resetsAt };
}

function readSidebarWindow(): SidebarWindow {
  try {
    return window.localStorage.getItem(SIDEBAR_WINDOW_KEY) === "five_hour" ? "five_hour" : "weekly";
  } catch {
    return "weekly";
  }
}

function storeSidebarWindow(value: SidebarWindow): void {
  try {
    window.localStorage.setItem(SIDEBAR_WINDOW_KEY, value);
  } catch {
    // The toggle remains usable if WebView storage is unavailable.
  }
}

function usageTone(remaining: number | null): string {
  if (remaining == null) return "neutral";
  if (remaining <= 10) return "critical";
  if (remaining <= 30) return "warning";
  return "healthy";
}

function orderedWindows(windows: UsageWindow[]): UsageWindow[] {
  const weight = (window: UsageWindow) => {
    if (canonicalWindow(window, "five_hour")) return 0;
    if (canonicalWindow(window, "weekly")) return 1;
    if (window.id.toLowerCase().includes("monthly") || window.label.toLowerCase().includes("monthly")) return 2;
    return 3;
  };
  return [...windows].sort((left, right) => weight(left) - weight(right));
}

function windowLength(window: UsageWindow): string | null {
  if (!window.windowSeconds) return null;
  const hours = Math.round(window.windowSeconds / 3600);
  if (hours >= 24 && hours % 24 === 0) return `${hours / 24}d window`;
  return `${hours}h window`;
}

function displayPlan(account: Account): string | null {
  const plan = account.plan?.trim();
  if (!plan) return null;
  return plan.replaceAll("_", " ").toUpperCase();
}

export default function App() {
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null);
  const [selectedProvider, setSelectedProvider] = useState<Provider | null>(null);
  const [providerOrder, setProviderOrder] = useState<Provider[]>(readDashboardProviderOrder);
  const [sidebarWindow, setSidebarWindow] = useState<SidebarWindow>(readSidebarWindow);
  const [section, setSection] = useState<Section>("accounts");
  const [addOpen, setAddOpen] = useState(false);
  const [alertAccount, setAlertAccount] = useState<Account | null>(null);
  const [googleUsageAccount, setGoogleUsageAccount] = useState<Account | null>(null);
  const [loginLabel, setLoginLabel] = useState("");
  const [loginProvider, setLoginProvider] = useState<Provider | undefined>(undefined);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [autostart, setAutostart] = useState(false);
  const [appSettings, setAppSettings] = useState<AppSettings | null>(null);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [appUpdate, setAppUpdate] = useState<AppUpdateStatus | null>(null);
  const [updateBusy, setUpdateBusy] = useState<UpdateBusy>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);

  const openAdd = useCallback((account?: Account, provider?: Provider) => {
    setLoginLabel(account?.label ?? "");
    setLoginProvider(account?.provider ?? provider);
    setAddOpen(true);
  }, []);

  const load = useCallback(async () => {
    try {
      const next = await bridgeApi.snapshot();
      setSnapshot(next);
      setSelectedProvider((current) => {
        if (current && next.accounts.some((account) => account.provider === current)) return current;
        return readDashboardProviderOrder().find((provider) => next.accounts.some((account) => account.provider === provider)) ?? null;
      });
      setError(null);
    } catch (cause) {
      setError(String(cause));
    }
  }, []);

  const checkForUpdate = useCallback(async (showError = false) => {
    setUpdateBusy("checking");
    try {
      const status = await bridgeApi.checkForUpdate();
      setAppUpdate(status);
      publishAppUpdateStatus(status);
      setUpdateError(null);
    } catch (cause) {
      const message = String(cause);
      setUpdateError(message);
      if (showError) setError(message);
    } finally {
      setUpdateBusy(null);
    }
  }, []);

  const installUpdate = useCallback(async () => {
    setUpdateBusy("installing");
    setUpdateError(null);
    try {
      await bridgeApi.installUpdate();
    } catch (cause) {
      const message = String(cause);
      setUpdateError(message);
      setError(message);
      setUpdateBusy(null);
    }
  }, []);

  const saveAccountRefreshMinutes = useCallback(async (minutes: number) => {
    setSettingsBusy(true);
    try {
      const saved = await bridgeApi.setAccountRefreshMinutes(minutes);
      setAppSettings(saved);
      setError(null);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setSettingsBusy(false);
    }
  }, []);

  const setPaseoBridgeEnabled = useCallback(async (enabled: boolean) => {
    setBusy("toggle-paseo-bridge");
    try {
      const bridge = await bridgeApi.setPaseoBridgeEnabled(enabled);
      setSnapshot((current) => current ? { ...current, bridge } : current);
      setAppSettings((current) => current ? { ...current, paseoBridgeEnabled: enabled } : current);
      setError(null);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(null);
    }
  }, []);

  const openPaseoBridgeWindow = useCallback(async () => {
    setBusy("open-paseo-bridge");
    try {
      await bridgeApi.openPaseoBridgeWindow();
      setError(null);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(null);
    }
  }, []);

  useEffect(() => {
    void load();
    void isEnabled().then(setAutostart).catch(() => setAutostart(false));
    void bridgeApi.getAppSettings().then(setAppSettings).catch((cause) => setError(String(cause)));
    void checkForUpdate(false);

    const startupRefresh = window.setTimeout(() => void load(), STARTUP_REFRESH_DELAY_MS);
    const dashboardInterval = window.setInterval(() => void load(), DASHBOARD_SYNC_INTERVAL_MS);
    const updateInterval = window.setInterval(() => void checkForUpdate(false), UPDATE_CHECK_INTERVAL_MS);
    const refreshVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    const syncUpdateStatus = (event: Event) => {
      const status = (event as CustomEvent<AppUpdateStatus>).detail;
      if (status) setAppUpdate(status);
    };
    const syncProviderOrder = (event: Event) => {
      const order = (event as CustomEvent<Provider[]>).detail;
      setProviderOrder(order?.length ? order : readDashboardProviderOrder());
    };

    window.addEventListener("focus", refreshVisible);
    window.addEventListener(APP_UPDATE_STATUS_EVENT, syncUpdateStatus);
    window.addEventListener(DASHBOARD_PROVIDER_ORDER_EVENT, syncProviderOrder);
    document.addEventListener("visibilitychange", refreshVisible);

    return () => {
      window.clearTimeout(startupRefresh);
      window.clearInterval(dashboardInterval);
      window.clearInterval(updateInterval);
      window.removeEventListener("focus", refreshVisible);
      window.removeEventListener(APP_UPDATE_STATUS_EVENT, syncUpdateStatus);
      window.removeEventListener(DASHBOARD_PROVIDER_ORDER_EVENT, syncProviderOrder);
      document.removeEventListener("visibilitychange", refreshVisible);
    };
  }, [load, checkForUpdate]);

  const accounts = snapshot?.accounts ?? [];
  const providerGroups = useMemo<ProviderGroup[]>(
    () => providerOrder.flatMap((provider) => {
      const providerAccounts = accounts.filter((account) => account.provider === provider);
      return providerAccounts.length ? [{ provider, accounts: providerAccounts }] : [];
    }),
    [accounts, providerOrder],
  );
  const visibleAccounts = selectedProvider
    ? accounts.filter((account) => account.provider === selectedProvider)
    : [];
  const needsAttention = accounts.filter(accountNeedsAttention).length;
  const nextReset = nextResetSummary(accounts);

  const refreshOne = async (id: string) => {
    setBusy(`refresh:${id}`);
    try {
      await bridgeApi.refreshAccount(id);
      await load();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(null);
    }
  };

  const refreshAll = async () => {
    setBusy("refresh-all");
    try {
      await bridgeApi.refreshAll();
      await load();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(null);
    }
  };

  const rename = async (account: Account, label: string) => {
    const trimmed = label.trim();
    if (!trimmed || trimmed === account.label) return;
    setBusy(`rename:${account.id}`);
    try {
      await bridgeApi.renameAccount(account.id, trimmed);
      await load();
    } catch (cause) {
      setError(String(cause));
      throw cause;
    } finally {
      setBusy(null);
    }
  };

  const remove = async (account: Account) => {
    if (!window.confirm(`Remove ${account.label}? This deletes its stored provider credentials from this computer.`)) return;
    setBusy(`remove:${account.id}`);
    try {
      await bridgeApi.removeAccount(account.id);
      if (alertAccount?.id === account.id) setAlertAccount(null);
      await load();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(null);
    }
  };

  const toggleAutostart = async () => {
    try {
      if (autostart) await disable();
      else await enable();
      setAutostart(await isEnabled());
    } catch (cause) {
      setError(String(cause));
    }
  };

  const changeSidebarWindow = (value: SidebarWindow) => {
    setSidebarWindow(value);
    storeSidebarWindow(value);
  };

  const content = useMemo(() => {
    if (section === "integration") {
      return <IntegrationView
        bridge={snapshot?.bridge ?? null}
        busy={busy === "toggle-paseo-bridge" || busy === "open-paseo-bridge"}
        onToggle={(enabled) => void setPaseoBridgeEnabled(enabled)}
        onView={() => void openPaseoBridgeWindow()}
      />;
    }
    if (section === "settings") {
      return <SettingsView
        autostart={autostart}
        onToggleAutostart={toggleAutostart}
        appSettings={appSettings}
        settingsBusy={settingsBusy}
        onAccountRefreshMinutesChange={(minutes) => void saveAccountRefreshMinutes(minutes)}
        update={appUpdate}
        updateBusy={updateBusy}
        updateError={updateError}
        onCheckForUpdate={() => void checkForUpdate(true)}
        onInstallUpdate={() => void installUpdate()}
      />;
    }
    return (
      <AccountsView
        allAccounts={accounts}
        accounts={visibleAccounts}
        selectedProvider={selectedProvider}
        needsAttention={needsAttention}
        nextReset={nextReset}
        onAdd={() => openAdd(undefined, selectedProvider ?? undefined)}
        onRefreshAll={refreshAll}
        onRefresh={(account) => void refreshOne(account.id)}
        onReconnect={(account) => account.provider === "google_ai_studio" ? setGoogleUsageAccount(account) : openAdd(account)}
        onConnectGoogleUsage={setGoogleUsageAccount}
        onRename={(account, label) => rename(account, label)}
        onRemove={(account) => void remove(account)}
        onNotifications={setAlertAccount}
        busy={busy}
      />
    );
  }, [
    section,
    snapshot?.bridge,
    busy,
    autostart,
    appSettings,
    settingsBusy,
    accounts,
    visibleAccounts,
    selectedProvider,
    needsAttention,
    nextReset.account,
    nextReset.value,
    nextReset.resetsAt,
    appUpdate,
    updateBusy,
    updateError,
    checkForUpdate,
    installUpdate,
    openAdd,
    saveAccountRefreshMinutes,
    setPaseoBridgeEnabled,
    openPaseoBridgeWindow,
  ]);

  return (
    <div className="app-shell obsidian-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark"><GaugeIcon /></span>
          <strong>AI Subscriptions</strong>
        </div>

        <nav className="primary-nav">
          <button className={section === "accounts" ? "active" : ""} onClick={() => setSection("accounts")}><UsersIcon />Accounts</button>
          <button className={section === "integration" ? "active" : ""} onClick={() => setSection("integration")}><LinkIcon />Integrations</button>
          <button className={section === "settings" ? "active" : ""} onClick={() => setSection("settings")}><SettingsIcon />Settings</button>
        </nav>

        <div className="provider-sidebar-heading">
          <span>Usage accounts</span>
          <div className="provider-window-toggle" aria-label="Provider average usage window">
            <button
              type="button"
              className={sidebarWindow === "five_hour" ? "active" : ""}
              aria-pressed={sidebarWindow === "five_hour"}
              title="Show average 5-hour remaining usage"
              onClick={() => changeSidebarWindow("five_hour")}
            >H</button>
            <button
              type="button"
              className={sidebarWindow === "weekly" ? "active" : ""}
              aria-pressed={sidebarWindow === "weekly"}
              title="Show average weekly remaining usage"
              onClick={() => changeSidebarWindow("weekly")}
            >W</button>
          </div>
        </div>

        <div className="provider-list">
          {providerGroups.length ? providerGroups.map((group) => (
            <ProviderSidebarRow
              key={group.provider}
              group={group}
              window={sidebarWindow}
              selected={section === "accounts" && selectedProvider === group.provider}
              onSelect={() => {
                setSelectedProvider(group.provider);
                setSection("accounts");
              }}
            />
          )) : (
            <button className="empty-account provider-empty" onClick={() => openAdd()}>
              <PlusIcon /><span>Add your first account</span>
            </button>
          )}
        </div>

        <div className="sidebar-footer"><RefreshIcon /><span>Check for App Updates</span></div>
      </aside>

      <main className="main-stage">
        {error ? <div className="global-error"><span>{error}</span><button onClick={() => setError(null)}>Dismiss</button></div> : null}
        {snapshot ? content : <div className="loading-screen"><span className="spinner" />Loading accounts…</div>}
      </main>

      <AddAccountModal
        open={addOpen}
        initialLabel={loginLabel}
        initialProvider={loginProvider}
        onClose={() => setAddOpen(false)}
        onAdded={async (account) => {
          setAddOpen(false);
          setSelectedProvider(account.provider);
          setSection("accounts");
          try { await bridgeApi.refreshAccount(account.id); } catch { /* The account remains available with cached state. */ }
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
        onClose={() => setAlertAccount(null)}
        onSaved={async () => {
          setAlertAccount(null);
          await load();
        }}
      />
    </div>
  );
}

function ProviderSidebarRow({
  group,
  window,
  selected,
  onSelect,
}: {
  group: ProviderGroup;
  window: SidebarWindow;
  selected: boolean;
  onSelect: () => void;
}) {
  const average = providerAverage(group.accounts, window);
  const width = average == null ? 0 : Math.min(100, Math.max(0, average));
  const tone = usageTone(average);
  return (
    <button
      type="button"
      className={`provider-summary-row ${selected ? "selected" : ""}`}
      onClick={onSelect}
      aria-label={`${providerName(group.provider)}, ${group.accounts.length} accounts, ${average == null ? "usage unavailable" : `${Math.round(average)} percent average remaining`}`}
    >
      <span className={`provider-summary-icon provider-${group.provider}`}><ProviderIcon provider={group.provider} /></span>
      <span className="provider-summary-content">
        <span className="provider-summary-topline">
          <strong>{providerName(group.provider)}</strong>
          <span className={`provider-average tone-${tone}`}>{average == null ? "—" : `${Math.round(average)}%`}</span>
        </span>
        <span className="provider-summary-track"><span className={`tone-${tone}`} style={{ width: `${width}%` }} /></span>
      </span>
    </button>
  );
}

function AccountsView(props: {
  allAccounts: Account[];
  accounts: Account[];
  selectedProvider: Provider | null;
  needsAttention: number;
  nextReset: NextResetSummary;
  onAdd: () => void;
  onRefreshAll: () => void;
  onRefresh: (account: Account) => void;
  onReconnect: (account: Account) => void;
  onConnectGoogleUsage: (account: Account) => void;
  onRename: (account: Account, label: string) => Promise<void>;
  onRemove: (account: Account) => void;
  onNotifications: (account: Account) => void;
  busy: string | null;
}) {
  return (
    <div className="content-scroll dashboard-content">
      <header className="dashboard-header">
        <div>
          <h1>Usage Dashboard</h1>
          {props.selectedProvider ? <p>{providerName(props.selectedProvider)} accounts</p> : null}
        </div>
        <div className="header-actions">
          <button className="button ghost" onClick={props.onRefreshAll} disabled={props.busy === "refresh-all"}>
            <RefreshIcon />{props.busy === "refresh-all" ? "Refreshing…" : "Refresh All"}
          </button>
          <button className="button primary" onClick={props.onAdd}><PlusIcon />Add Account</button>
        </div>
      </header>

      <section className="summary-grid mockup-summary-grid">
        <div className="mockup-summary-card total-card">
          <div><span className="summary-label">Total accounts</span><strong className="summary-helper">Active</strong></div>
          <div className="summary-value-cluster"><strong>{props.allAccounts.length}</strong><UsersIcon /></div>
        </div>
        <div className={`mockup-summary-card attention-card ${props.needsAttention ? "has-attention" : ""}`}>
          <div>
            <span className="summary-label">Needs attention</span>
            <strong className="summary-helper"><CheckCircleIcon />{props.needsAttention ? `${props.needsAttention} account${props.needsAttention === 1 ? "" : "s"}` : "All good"}</strong>
          </div>
          <div className="summary-value-cluster"><strong>{props.needsAttention}</strong><span className="summary-info">!</span></div>
        </div>
        <div className="mockup-summary-card next-reset-card">
          <div>
            <span className="summary-label">Next reset</span>
            <strong className="next-reset-account">{props.nextReset.account ?? "No upcoming reset"}</strong>
          </div>
          <div className="next-reset-actions">
            <span className="next-reset-pill">{props.nextReset.value === "—" ? "—" : `${props.nextReset.value} remaining`}</span>
            <ClockIcon />
          </div>
        </div>
      </section>

      <section className="provider-account-cards">
        {props.accounts.length ? props.accounts.map((account) => (
          <AccountDashboardCard
            key={account.id}
            account={account}
            busy={props.busy}
            onRefresh={() => props.onRefresh(account)}
            onReconnect={() => props.onReconnect(account)}
            onConnectGoogleUsage={() => props.onConnectGoogleUsage(account)}
            onRename={(label) => props.onRename(account, label)}
            onRemove={() => props.onRemove(account)}
            onNotifications={() => props.onNotifications(account)}
          />
        )) : (
          <section className="welcome-panel mockup-empty-panel">
            <UsersIcon />
            <h2>{props.selectedProvider ? `No ${providerName(props.selectedProvider)} accounts` : "Connect a provider account"}</h2>
            <p>Add an account to begin monitoring its limits.</p>
            <button className="button primary" onClick={props.onAdd}><PlusIcon />Add Account</button>
          </section>
        )}
      </section>
    </div>
  );
}

function AccountDashboardCard({
  account,
  busy,
  onRefresh,
  onReconnect,
  onConnectGoogleUsage,
  onRename,
  onRemove,
  onNotifications,
}: {
  account: Account;
  busy: string | null;
  onRefresh: () => void;
  onReconnect: () => void;
  onConnectGoogleUsage: () => void;
  onRename: (label: string) => Promise<void>;
  onRemove: () => void;
  onNotifications: () => void;
}) {
  const status = accountStatus(account);
  const needsAttention = accountNeedsAttention(account);
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(account.label);
  const [renameError, setRenameError] = useState<string | null>(null);
  const isRefreshing = busy === `refresh:${account.id}`;
  const isRenaming = busy === `rename:${account.id}`;
  const isRemoving = busy === `remove:${account.id}`;
  const windows = orderedWindows(account.lastUsage?.windows ?? []);
  const modelsOnly = account.provider === "google_ai_studio" && account.lastUsage?.source === "google_ai_studio_model_access";
  const waitingForMetrics = account.provider === "google_ai_studio" && account.lastUsage?.source === "google_ai_studio_monitoring_waiting";
  const googleUnavailableLabel = modelsOnly ? "Model connected" : waitingForMetrics ? "Waiting for metrics" : "Unavailable";

  useEffect(() => {
    if (!editing) setLabel(account.label);
  }, [account.label, editing]);

  const commitRename = async () => {
    const next = label.trim();
    if (!next) {
      setRenameError("Account name is required.");
      return;
    }
    if (next === account.label) {
      setEditing(false);
      setRenameError(null);
      return;
    }
    try {
      await onRename(next);
      setEditing(false);
      setRenameError(null);
    } catch {
      setRenameError("Unable to rename this account.");
    }
  };

  return (
    <article className={`provider-account-card ${needsAttention ? "needs-attention" : ""}`}>
      <header className="provider-account-card-header">
        <span className={`account-card-provider-icon provider-${account.provider}`}><ProviderIcon provider={account.provider} /></span>
        <div className="account-card-identity">
          <div className="account-card-name-row">
            {editing ? (
              <input
                className="account-card-name-input"
                value={label}
                maxLength={80}
                disabled={isRenaming}
                autoFocus
                aria-label={`Rename ${account.label}`}
                onChange={(event) => {
                  setLabel(event.target.value);
                  setRenameError(null);
                }}
                onBlur={() => void commitRename()}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    event.currentTarget.blur();
                  } else if (event.key === "Escape") {
                    event.preventDefault();
                    setLabel(account.label);
                    setRenameError(null);
                    setEditing(false);
                  }
                }}
              />
            ) : <h2>{account.label}</h2>}
            {!editing ? (
              <button type="button" className="account-name-edit" title="Edit account name" aria-label={`Edit ${account.label}`} onClick={() => setEditing(true)}>
                <EditIcon />
              </button>
            ) : null}
            <span className={`account-status-badge ${status.className}`}>{status.label}</span>
            <div className="account-card-name-actions">
              <button
                type="button"
                className="account-card-action"
                title="Usage notifications"
                aria-label={`Configure usage notifications for ${account.label}`}
                disabled={Boolean(busy)}
                onClick={onNotifications}
              ><BellIcon /></button>
              <button
                type="button"
                className="account-card-action remove-action"
                title="Remove this account"
                aria-label={`Remove ${account.label}`}
                disabled={Boolean(busy)}
                onClick={onRemove}
              >{isRemoving ? <span className="mini-spinner" /> : <CloseIcon />}</button>
              <button
                type="button"
                className={`account-card-action ${isRefreshing ? "spinning" : ""}`}
                title="Refresh this account"
                aria-label={`Refresh ${account.label}`}
                disabled={Boolean(busy)}
                onClick={onRefresh}
              ><RefreshIcon /></button>
            </div>
          </div>
          <p>{account.email ?? providerName(account.provider)}</p>
          {renameError ? <small className="account-card-inline-error">{renameError}</small> : null}
        </div>
        <div className={`account-card-header-actions ${account.provider === "google_ai_studio" ? "has-google-action" : "plan-only-actions"}`}>
          {displayPlan(account) ? <span className="account-plan-badge">{displayPlan(account)}</span> : null}
          {account.provider === "google_ai_studio" ? (
            <button type="button" className="button ghost compact-button google-cloud-connect-action" disabled={Boolean(busy)} onClick={onConnectGoogleUsage}>
              {modelsOnly ? "Connect Cloud Usage" : "Change Cloud Project"}
            </button>
          ) : null}



        </div>
      </header>

      {account.lastError ? (
        <div className="account-card-error">
          <span>{account.lastError}</span>
          {account.authRequired ? <button className="button ghost compact-button" onClick={onReconnect}>{account.provider === "google_ai_studio" ? "Reconnect Cloud Usage" : "Reconnect"}</button> : null}
        </div>
      ) : null}

      <div className={`account-card-metrics ${windows.length > 2 ? "multi-row-metrics" : ""}`}>
        {windows.length ? windows.map((window) => <AccountUsageMetric key={window.id} window={window} unavailableLabel={googleUnavailableLabel} />) : (
          <div className="account-usage-metric unavailable-metric">
            <span className="metric-label">Usage</span>
            <strong>Unavailable</strong>
            <span className="metric-reset">Refresh this account to retrieve its limits.</span>
          </div>
        )}
        <div className="account-credit-metric">
          <span className="metric-label">Credits</span>
          <strong>
            {account.lastUsage?.unlimitedCredits
              ? "Unlimited"
              : account.lastUsage?.creditsUsd != null
                ? `$${account.lastUsage.creditsUsd.toFixed(2)}`
                : "—"}
          </strong>
          <span>{account.lastUsage?.creditsUsd != null || account.lastUsage?.unlimitedCredits ? "Provider-reported remaining credit balance" : "Not reported by this provider"}</span>
        </div>
      </div>
    </article>
  );
}

function AccountUsageMetric({ window, unavailableLabel = "Unavailable" }: { window: UsageWindow; unavailableLabel?: string }) {
  const remaining = window.remainingPercent;
  const width = remaining == null ? 0 : Math.min(100, Math.max(0, remaining));
  const tone = usageTone(remaining);
  return (
    <div className="account-usage-metric">
      <div className="metric-heading">
        <span className="metric-label">{window.label}</span>
        {windowLength(window) ? <span className="metric-window-pill">{windowLength(window)}</span> : null}
      </div>
      <strong className="metric-full-value">{remaining == null ? unavailableLabel : `${Math.round(remaining)}% remaining`}</strong>
      <span className="metric-compact-value">{remaining == null ? unavailableLabel : `${Math.round(remaining)}%`}</span>
      <span className="account-metric-track"><span className={`tone-${tone}`} style={{ width: `${width}%` }} /></span>
      <span className="metric-reset">{window.resetsAt ? `Resets ${formatTime(window.resetsAt)}` : remaining == null ? "This provider has not reported a quota value yet" : "Rolling window"}</span>
    </div>
  );
}

function IntegrationView({ bridge, onToggle, onView, busy }: {
  bridge: BridgeInfo | null;
  onToggle: (enabled: boolean) => void;
  onView: () => void;
  busy: boolean;
}) {
  const enabled = bridge?.enabled ?? false;
  const status = !enabled
    ? { label: "Off", className: "off" }
    : bridge?.running
      ? { label: "On · Running locally", className: "running" }
      : bridge?.error
        ? { label: "On · Needs attention", className: "error" }
        : { label: "On · Starting", className: "starting" };

  return (
    <div className="content-scroll narrow-content settings-style-content">
      <header className="page-header"><div><span className="eyebrow">Optional integration</span><h1>Integrations</h1><p>Connect AI Subscription Tracker to other local tools only when you need them.</p></div></header>
      <section className="settings-card paseo-integration-card">
        <div className={`settings-row paseo-integration-row ${busy ? "busy" : ""}`}>
          <div>
            <strong>Paseo Bridge</strong>
            <small>Expose sanitized usage data to Paseo over an authenticated localhost endpoint. Disabled by default.</small>
            <span className={`paseo-bridge-inline-status ${status.className}`}>{status.label}</span>
          </div>
          <div className="paseo-integration-actions">
            {enabled ? <button type="button" className="paseo-view-link" disabled={busy} onClick={onView}>View</button> : null}
            <button type="button" className={`toggle ${enabled ? "on" : ""}`} disabled={busy || !bridge} aria-label={enabled ? "Disable Paseo Bridge" : "Enable Paseo Bridge"} aria-pressed={enabled} onClick={() => onToggle(!enabled)}><span /></button>
          </div>
        </div>
      </section>
      {bridge?.error ? <div className="error-panel paseo-integration-error">{bridge.error}</div> : null}
    </div>
  );
}

function SettingsView({
  autostart,
  onToggleAutostart,
  appSettings,
  settingsBusy,
  onAccountRefreshMinutesChange,
  update,
  updateBusy,
  updateError,
  onCheckForUpdate,
  onInstallUpdate,
}: {
  autostart: boolean;
  onToggleAutostart: () => void;
  appSettings: AppSettings | null;
  settingsBusy: boolean;
  onAccountRefreshMinutesChange: (minutes: number) => void;
  update: AppUpdateStatus | null;
  updateBusy: UpdateBusy;
  updateError: string | null;
  onCheckForUpdate: () => void;
  onInstallUpdate: () => void;
}) {
  return (
    <div className="content-scroll narrow-content settings-style-content">
      <header className="page-header"><div><span className="eyebrow">Application</span><h1>Settings</h1><p>Control how AI Subscription Tracker behaves on this computer.</p></div></header>
      <section className="settings-card">
        <div className="settings-row"><div><strong>Start at login</strong><small>Keep account usage available after signing in.</small></div><button className={`toggle ${autostart ? "on" : ""}`} onClick={onToggleAutostart} aria-pressed={autostart}><span /></button></div>
        <div className="settings-row"><div><strong>Automatic updates</strong><small>Checks GitHub Releases at startup and every hour.</small></div>{update?.available ? <button className="button primary" disabled={updateBusy !== null} onClick={onInstallUpdate}>{updateBusy === "installing" ? "Installing…" : `Update to v${update.availableVersion}`}</button> : <button className="button ghost" disabled={updateBusy !== null} onClick={onCheckForUpdate}>{updateBusy === "checking" ? "Checking…" : "Check for App Updates"}</button>}</div>
        <div className="settings-row"><div><strong>Installed version</strong><small>{update?.available ? `Version ${update.availableVersion} is available.` : "The app installs only signed update packages."}</small></div><span className="setting-value mono">v{update?.currentVersion ?? "0.2.28"}</span></div>
        <div className="settings-row"><div><strong>Account Updates</strong><small>The selected number of minutes controls how often the app checks your AI usage percentages.</small></div><select className="account-update-select" aria-label="Account update interval" value={appSettings?.accountRefreshMinutes ?? 5} disabled={!appSettings || settingsBusy} onChange={(event) => onAccountRefreshMinutesChange(Number(event.target.value))}>{ACCOUNT_REFRESH_OPTIONS.map((minutes) => <option key={minutes} value={minutes}>{minutes} minutes</option>)}</select></div>
      </section>
      {update?.available && update.body ? <section className="update-notes"><strong>What changed in v{update.availableVersion}</strong><p>{update.body}</p>{update.date ? <small>Published {formatTime(update.date)}</small> : null}</section> : null}
      {updateError ? <div className="error-panel settings-update-error">{updateError}</div> : null}
    </div>
  );
}

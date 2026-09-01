import { useCallback, useEffect, useMemo, useState } from "react";
import { disable, enable, isEnabled } from "@tauri-apps/plugin-autostart";
import { getVersion } from "@tauri-apps/api/app";
import { bridgeApi, clearLoginAttempt, readLoginAttempt } from "./api";
import { AccountAlertModal } from "./components/AccountAlertModal";
import { RemoveAccountModal } from "./components/RemoveAccountModal";
import { AddAccountModal } from "./components/AddAccountModal";
import { BucketModal } from "./components/BucketModal";
import { GoogleAiStudioUsageModal } from "./components/GoogleAiStudioUsageModal";
import { ProviderIcon } from "./components/ProviderIcon";
import {
  DASHBOARD_GROUP_ORDER_EVENT,
  DASHBOARD_PROVIDER_ORDER_EVENT,
  isReordering,
  readDashboardProviderOrder,
  readSidebarGroupOrder,
} from "./dashboard-reorder";
import {
  BellIcon,
  CheckCircleIcon,
  ClockIcon,
  CloseIcon,
  EditIcon,
  GaugeIcon,
  LinkIcon,
  MenuIcon,
  PlusIcon,
  RefreshIcon,
  SettingsIcon,
  UsersIcon,
} from "./icons";
import { APP_UPDATE_STATUS_EVENT, publishAppUpdateStatus } from "./sidebar-update-control";
import type {
  Account,
  AccountBucket,
  AppSettings,
  AppUpdateStatus,
  BridgeStatus,
  DashboardSnapshot,
  Provider,
  UsageWindow,
} from "./types";

type Section = "accounts" | "integration" | "settings";
type UpdateBusy = "checking" | "installing" | null;
type SidebarWindow = "five_hour" | "weekly";

export type SidebarGroup = {
  id: string;
  type: "bucket" | "provider";
  title: string;
  provider: Provider;
  accounts: Account[];
  bucket?: AccountBucket;
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
    case "openai": return "Codex/GPT";
    case "anthropic": return "Claude";
    case "antigravity": return "Antigravity";
    case "google_ai_studio": return "AI Studio";
    case "grok": return "Grok";
    case "opencode_go": return "OpenCode Go";
  }
}

function displayAccountLabel(label: string): string {
  if (label === "Google Antigravity" || label === "Antigravity") return "Antigravity";
  if (label === "Grok / SuperGrok" || label === "Grok") return "Grok";
  if (label === "OpenAI Codex" || label === "OpenAI" || label === "Codex/GPT") return "Codex/GPT";
  if (label === "Anthropic Claude" || label === "Anthropic" || label === "Claude") return "Claude";
  if (label === "Google AI Studio" || label === "AI Studio") return "AI Studio";
  return label;
}

function displayAccountSubtitle(account: Account): string {
  if (account.email && account.email.trim()) {
    return account.email.trim();
  }
  const label = displayAccountLabel(account.label);
  const pName = providerName(account.provider);
  if (label.trim().toLowerCase() === pName.trim().toLowerCase()) {
    return "Connected account";
  }
  return pName;
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

function groupAverage(accounts: Account[], target: SidebarWindow): number | null {
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
      return [{ resetAt, account: displayAccountLabel(account.label), resetsAt: window.resetsAt }];
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
  const groupOrder: string[] = [];
  for (const w of windows) {
    const group = w.label.includes(" · ") ? w.label.split(" · ")[0] : "";
    if (!groupOrder.includes(group)) {
      groupOrder.push(group);
    }
  }

  const windowWeight = (window: UsageWindow) => {
    if (canonicalWindow(window, "five_hour")) return 0;
    if (canonicalWindow(window, "weekly")) return 1;
    if (window.id.toLowerCase().includes("monthly") || window.label.toLowerCase().includes("monthly")) return 2;
    return 3;
  };

  return [...windows].sort((left, right) => {
    const groupLeft = left.label.includes(" · ") ? left.label.split(" · ")[0] : "";
    const groupRight = right.label.includes(" · ") ? right.label.split(" · ")[0] : "";
    const idxLeft = groupOrder.indexOf(groupLeft);
    const idxRight = groupOrder.indexOf(groupRight);
    if (idxLeft !== idxRight) {
      return idxLeft - idxRight;
    }
    return windowWeight(left) - windowWeight(right);
  });
}

function windowLength(window: UsageWindow): string | null {
  const id = window.id.toLowerCase().replaceAll("-", "_");
  const label = window.label.toLowerCase();
  if (id.includes("monthly") || label.includes("monthly")) return "Monthly";
  if (!window.windowSeconds) return null;
  const hours = Math.round(window.windowSeconds / 3600);
  if (hours >= 24 && hours % 24 === 0) return `${hours / 24}d window`;
  return `${hours}h window`;
}

function cleanModelPrefix(prefix: string): string {
  return prefix
    .replace(/\bclaude\s+and\s+gpt\b/i, "Claude & GPT")
    .replace(/\s+models$/i, "")
    .replace(/\s+model$/i, "")
    .trim();
}

function displayMetricLabel(window: UsageWindow): string {
  const label = window.label.trim();
  const lower = label.toLowerCase();

  // Model-grouped windows, e.g. "Gemini models · 5 hour", "Claude & GPT models · 5 hour"
  if (label.includes(" · ")) {
    const parts = label.split(" · ");
    const prefix = cleanModelPrefix(parts.slice(0, -1).join(" · "));
    const last = parts[parts.length - 1].trim().toLowerCase();
    if (
      last === "5 hour" ||
      last === "5-hour" ||
      last === "five hour" ||
      last === "weekly" ||
      last === "rolling" ||
      last.includes("limit")
    ) {
      return `${prefix} · Remaining Limit`;
    }
    return `${prefix} · ${parts[parts.length - 1].trim()}`;
  }

  // Model-specific suffixes like "Sonnet weekly" -> "Sonnet · Remaining Limit"
  if (lower.endsWith(" weekly") && lower !== "weekly") {
    const base = cleanModelPrefix(label.slice(0, -7).trim());
    return `${base} · Remaining Limit`;
  }
  if ((lower.endsWith(" 5 hour") || lower.endsWith(" 5-hour")) && lower !== "5 hour" && lower !== "5-hour") {
    const base = cleanModelPrefix(label.slice(0, -7).trim());
    return `${base} · Remaining Limit`;
  }
  if (lower.endsWith(" five hour") && lower !== "five hour") {
    const base = cleanModelPrefix(label.slice(0, -10).trim());
    return `${base} · Remaining Limit`;
  }

  // Pure standalone window labels
  if (
    lower === "weekly" ||
    lower === "5 hour" ||
    lower === "5-hour" ||
    lower === "five hour" ||
    lower === "five_hour" ||
    lower === "rolling" ||
    lower === "five hour limit remaining" ||
    lower === "weekly limit remaining" ||
    lower === "5 hour limit remaining" ||
    lower === "5-hour limit remaining" ||
    lower === "limit remaining" ||
    lower === "usage"
  ) {
    return "Remaining Limit";
  }

  return cleanModelPrefix(label);
}

function windowPillClass(window: UsageWindow): string {
  if (canonicalWindow(window, "five_hour")) return "window-pill-5h";
  if (canonicalWindow(window, "weekly")) return "window-pill-7d";
  const id = window.id.toLowerCase();
  const label = window.label.toLowerCase();
  if (id.includes("monthly") || label.includes("monthly")) return "window-pill-monthly";
  return "window-pill-default";
}

function displayPlan(account: Account): string | null {
  const plan = account.plan?.trim();
  if (!plan) return null;
  if (plan.toLowerCase() === "grok / supergrok" || plan.toLowerCase() === "grok") return "GROK";
  if (plan.toLowerCase() === "google antigravity") return "ANTIGRAVITY";
  return plan.replaceAll("_", " ").toUpperCase();
}

export default function App() {
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [providerOrder, setProviderOrder] = useState<Provider[]>(readDashboardProviderOrder);
  const [sidebarGroupOrder, setSidebarGroupOrder] = useState<string[]>(readSidebarGroupOrder);
  const [sidebarWindow, setSidebarWindow] = useState<SidebarWindow>(readSidebarWindow);
  const [section, setSection] = useState<Section>("accounts");
  const [addOpen, setAddOpen] = useState(false);
  const [bucketModalOpen, setBucketModalOpen] = useState(false);
  const [bucketToEdit, setBucketToEdit] = useState<AccountBucket | null>(null);
  const [bucketInitialProvider, setBucketInitialProvider] = useState<Provider | null>(null);
  const [alertAccount, setAlertAccount] = useState<Account | null>(null);
  const [accountToRemove, setAccountToRemove] = useState<Account | null>(null);
  const [googleUsageAccount, setGoogleUsageAccount] = useState<Account | null>(null);
  const [loginLabel, setLoginLabel] = useState("");
  const [loginProvider, setLoginProvider] = useState<Provider | undefined>(undefined);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [autostart, setAutostart] = useState(false);
  const [appSettings, setAppSettings] = useState<AppSettings | null>(null);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [installedVersion, setInstalledVersion] = useState("0.3.2");
  const [appUpdate, setAppUpdate] = useState<AppUpdateStatus | null>(null);
  const [updateBusy, setUpdateBusy] = useState<UpdateBusy>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);

  const openAdd = useCallback((account?: Account, provider?: Provider) => {
    setLoginLabel(account?.label ?? "");
    setLoginProvider(account?.provider ?? provider);
    setAddOpen(true);
  }, []);

  const openNewBucket = useCallback((provider?: Provider | null) => {
    setBucketToEdit(null);
    setBucketInitialProvider(provider ?? null);
    setBucketModalOpen(true);
  }, []);

  const openEditBucket = useCallback((bucket: AccountBucket) => {
    setBucketToEdit(bucket);
    setBucketInitialProvider(bucket.provider);
    setBucketModalOpen(true);
  }, []);

  const load = useCallback(async () => {
    try {
      const next = await Promise.race([
        bridgeApi.snapshot(),
        new Promise<DashboardSnapshot>((_, reject) => {
          window.setTimeout(
            () => reject(new Error("Timed out loading accounts from the app backend.")),
            10_000,
          );
        }),
      ]);
      setSnapshot(next);
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
      let message = String(cause);
      if (message.includes("Could not fetch a valid release JSON")) {
        message = "No published update manifest (latest.json) found on GitHub Releases yet.";
      }
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

  const saveAutomaticUpdatesEnabled = useCallback(async (enabled: boolean) => {
    setSettingsBusy(true);
    try {
      const saved = await bridgeApi.setAutomaticUpdatesEnabled(enabled);
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
      const status = await bridgeApi.setPaseoBridgeEnabled(enabled);
      setSnapshot((current) => current ? { ...current, bridge: status } : null);
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
    getVersion().then(setInstalledVersion).catch(() => setInstalledVersion("0.3.2"));
    bridgeApi.getAppSettings().then(setAppSettings).catch((cause) => setError(String(cause)));
    isEnabled().then(setAutostart).catch(() => setAutostart(false));
    const syncInterval = window.setInterval(() => void load(), DASHBOARD_SYNC_INTERVAL_MS);
    const initialRefreshTimeout = window.setTimeout(() => void bridgeApi.refreshAll().then(() => load()), STARTUP_REFRESH_DELAY_MS);
    return () => {
      window.clearInterval(syncInterval);
      window.clearTimeout(initialRefreshTimeout);
    };
  }, [load]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const attemptId = readLoginAttempt();
      try {
        const status = attemptId
          ? await bridgeApi.loginStatus(attemptId)
          : await bridgeApi.currentLoginStatus();
        if (cancelled || !status) return;
        if (status.status === "complete") {
          clearLoginAttempt();
          await load();
          return;
        }
        if (status.status === "failed") {
          clearLoginAttempt();
          if (status.message) setError(status.message);
          return;
        }
        if ((status.status === "choose_project" || status.status === "monitoring_disabled") && status.account) {
          setGoogleUsageAccount(status.account);
        }
      } catch {
        clearLoginAttempt();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [load]);

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

  useEffect(() => {
    const handleUpdateEvent = (event: Event) => {
      const custom = event as CustomEvent<AppUpdateStatus | null>;
      if (custom.detail) setAppUpdate(custom.detail);
    };
    window.addEventListener(APP_UPDATE_STATUS_EVENT, handleUpdateEvent);
    return () => window.removeEventListener(APP_UPDATE_STATUS_EVENT, handleUpdateEvent);
  }, []);

  useEffect(() => {
    if (!appSettings?.automaticUpdatesEnabled) return;
    void checkForUpdate(false);
    const updateInterval = window.setInterval(() => void checkForUpdate(false), UPDATE_CHECK_INTERVAL_MS);
    return () => window.clearInterval(updateInterval);
  }, [appSettings?.automaticUpdatesEnabled, checkForUpdate]);

  const accounts = snapshot?.accounts ?? [];
  const buckets = snapshot?.buckets ?? [];

  const sidebarGroups = useMemo<SidebarGroup[]>(() => {
    const assignedIds = new Set<string>();
    const bucketGroups: SidebarGroup[] = [];

    for (const bucket of buckets) {
      const bucketAccounts = accounts.filter((a) => bucket.accountIds.includes(a.id));
      if (bucketAccounts.length > 0) {
        bucket.accountIds.forEach((id) => assignedIds.add(id));
        const provider = bucket.provider ?? bucketAccounts[0]?.provider ?? "antigravity";
        bucketGroups.push({
          id: `bucket:${bucket.id}`,
          type: "bucket",
          title: bucket.name,
          provider,
          accounts: bucketAccounts,
          bucket,
        });
      }
    }

    const providerGroups: SidebarGroup[] = [];
    const seenProviders = new Set<Provider>();
    for (const provider of providerOrder) {
      if (seenProviders.has(provider)) continue;
      seenProviders.add(provider);
      const unassigned = accounts.filter(
        (a) => a.provider === provider && !assignedIds.has(a.id),
      );
      if (unassigned.length > 0) {
        providerGroups.push({
          id: `provider:${provider}`,
          type: "provider",
          title: providerName(provider),
          provider,
          accounts: unassigned,
        });
      }
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
  }, [accounts, buckets, providerOrder, sidebarGroupOrder]);

  useEffect(() => {
    if (!selectedGroupId && sidebarGroups.length > 0) {
      setSelectedGroupId(sidebarGroups[0].id);
    }
  }, [selectedGroupId, sidebarGroups]);

  const selectedGroup = useMemo<SidebarGroup | null>(() => {
    if (selectedGroupId) {
      const found = sidebarGroups.find((g) => g.id === selectedGroupId);
      if (found) return found;
    }
    return sidebarGroups[0] ?? null;
  }, [selectedGroupId, sidebarGroups]);

  const visibleAccounts = selectedGroup?.accounts ?? [];
  const needsAttention = accounts.filter(accountNeedsAttention).length;
  const nextReset = nextResetSummary(visibleAccounts.length ? visibleAccounts : accounts);

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
    setBusy(`remove:${account.id}`);
    try {
      await bridgeApi.removeAccount(account.id);
      if (alertAccount?.id === account.id) setAlertAccount(null);
      if (accountToRemove?.id === account.id) setAccountToRemove(null);
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
        onToggleSidebar={() => setSidebarOpen((prev) => !prev)}
      />;
    }
    if (section === "settings") {
      return <SettingsView
        autostart={autostart}
        onToggleAutostart={toggleAutostart}
        appSettings={appSettings}
        settingsBusy={settingsBusy}
        onAccountRefreshMinutesChange={(minutes) => void saveAccountRefreshMinutes(minutes)}
        onAutomaticUpdatesChange={(enabled) => void saveAutomaticUpdatesEnabled(enabled)}
        installedVersion={installedVersion}
        update={appUpdate}
        updateBusy={updateBusy}
        updateError={updateError}
        onCheckForUpdate={() => void checkForUpdate(true)}
        onInstallUpdate={() => void installUpdate()}
        onToggleSidebar={() => setSidebarOpen((prev) => !prev)}
      />;
    }
    return (
      <AccountsView
        allAccounts={accounts}
        accounts={visibleAccounts}
        selectedGroup={selectedGroup}
        needsAttention={needsAttention}
        nextReset={nextReset}
        onToggleSidebar={() => setSidebarOpen((prev) => !prev)}
        onAdd={() => openAdd(undefined, selectedGroup?.provider ?? undefined)}
        onRefreshAll={refreshAll}
        onEditBucket={openEditBucket}
        onRefresh={(account) => void refreshOne(account.id)}
        onReconnect={(account) => account.provider === "google_ai_studio" ? setGoogleUsageAccount(account) : openAdd(account)}
        onConnectGoogleUsage={setGoogleUsageAccount}
        onRename={(account, label) => rename(account, label)}
        onRemove={setAccountToRemove}
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
    selectedGroup,
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
    openEditBucket,
    saveAccountRefreshMinutes,
    saveAutomaticUpdatesEnabled,
    setPaseoBridgeEnabled,
    openPaseoBridgeWindow,
  ]);

  return (
    <div className="app-shell obsidian-shell">
      <div
        className={`sidebar-backdrop ${sidebarOpen ? "active" : ""}`}
        onClick={() => setSidebarOpen(false)}
        aria-hidden="true"
      />
      <aside className={`sidebar ${sidebarOpen ? "mobile-open" : ""}`}>
        <div className="brand">
          <span className="brand-mark"><GaugeIcon /></span>
          <strong>AI Usage Tracker</strong>
          <button
            type="button"
            className="sidebar-mobile-close-btn"
            onClick={() => setSidebarOpen(false)}
            aria-label="Close navigation"
          >
            <CloseIcon />
          </button>
        </div>

        <nav className="primary-nav">
          <button className={section === "accounts" ? "active" : ""} onClick={() => { setSection("accounts"); setSidebarOpen(false); }}><UsersIcon />Accounts</button>
          <button className={section === "integration" ? "active" : ""} onClick={() => { setSection("integration"); setSidebarOpen(false); }}><LinkIcon />Integrations</button>
          <button className={section === "settings" ? "active" : ""} onClick={() => { setSection("settings"); setSidebarOpen(false); }}><SettingsIcon />Settings</button>
        </nav>

        <div className="provider-sidebar-heading">
          <span>Usage accounts</span>
          <div className="provider-sidebar-heading-actions">
            <button
              type="button"
              className="button ghost compact-button add-bucket-header-button"
              title="Create a custom bucket group"
              onClick={() => { openNewBucket(selectedGroup?.provider); setSidebarOpen(false); }}
            >
              <PlusIcon />Group
            </button>
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
        </div>

        <div className="provider-list">
          {sidebarGroups.length ? sidebarGroups.map((group) => (
            <SidebarGroupRow
              key={group.id}
              group={group}
              window={sidebarWindow}
              selected={section === "accounts" && selectedGroup?.id === group.id}
              onSelect={() => {
                setSelectedGroupId(group.id);
                setSection("accounts");
                setSidebarOpen(false);
              }}
            />
          )) : (
            <button className="empty-account provider-empty" onClick={() => { openAdd(); setSidebarOpen(false); }}>
              <PlusIcon /><span>Add your first account</span>
            </button>
          )}
        </div>

        <div className="sidebar-footer"><RefreshIcon /><span>Check for Updates</span></div>
      </aside>

      <main className="main-stage">
        {error ? <div className="global-error"><span>{error}</span><button onClick={() => setError(null)}>Dismiss</button></div> : null}
        {snapshot ? content : (
          <div className="loading-screen">
            {error ? (
              <div className="loading-error">
                <div className="error-panel">{error}</div>
                <button className="button" type="button" onClick={() => { setError(null); void load(); }}>
                  Retry
                </button>
              </div>
            ) : (
              <><span className="spinner" />Loading accounts…</>
            )}
          </div>
        )}
      </main>

      <AddAccountModal
        open={addOpen}
        initialLabel={loginLabel}
        initialProvider={loginProvider}
        onClose={() => setAddOpen(false)}
        onAdded={async (account) => {
          setAddOpen(false);
          setSelectedGroupId(`provider:${account.provider}`);
          setSection("accounts");
          try { await bridgeApi.refreshAccount(account.id); } catch { /* The account remains available with cached state. */ }
          await load();
        }}
      />
      <BucketModal
        open={bucketModalOpen}
        bucket={bucketToEdit}
        initialProvider={bucketInitialProvider}
        accounts={accounts}
        onClose={() => setBucketModalOpen(false)}
        onSaved={async (saved) => {
          setBucketModalOpen(false);
          setSelectedGroupId(`bucket:${saved.id}`);
          await load();
        }}
        onDeleted={async (deletedId) => {
          setBucketModalOpen(false);
          if (selectedGroupId === `bucket:${deletedId}`) {
            setSelectedGroupId(null);
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
        onClose={() => setAlertAccount(null)}
        onSaved={async () => {
          setAlertAccount(null);
          await load();
        }}
      />
      <RemoveAccountModal
        account={accountToRemove}
        busy={Boolean(accountToRemove && busy === `remove:${accountToRemove.id}`)}
        onClose={() => setAccountToRemove(null)}
        onConfirm={() => {
          if (accountToRemove) void remove(accountToRemove);
        }}
      />
    </div>
  );
}

function SidebarGroupRow({
  group,
  window,
  selected,
  onSelect,
}: {
  group: SidebarGroup;
  window: SidebarWindow;
  selected: boolean;
  onSelect: () => void;
}) {
  const average = groupAverage(group.accounts, window);
  const width = average == null ? 0 : Math.min(100, Math.max(0, average));
  const tone = usageTone(average);
  return (
    <button
      type="button"
      className={`provider-summary-row ${group.type === "bucket" ? "is-bucket-row" : ""} ${selected ? "selected" : ""}`}
      onClick={(e) => {
        if (isReordering()) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        onSelect();
      }}
      data-provider={group.provider}
      data-reorder-provider={group.provider}
      data-group-id={group.id}
      data-reorder-enabled="true"
      aria-label={`${group.title}, ${group.accounts.length} accounts, ${average == null ? "usage unavailable" : `${Math.round(average)} percent average remaining`}`}
    >
      <span className={`provider-summary-icon provider-${group.provider}`}><ProviderIcon provider={group.provider} /></span>
      <span className="provider-summary-content">
        <span className="provider-summary-topline">
          <strong className="sidebar-group-title">
            <span className="sidebar-group-name">{group.title}</span>
            <span className="sidebar-group-count">({group.accounts.length})</span>
            {group.type === "bucket" ? <span className="bucket-mini-badge">Group</span> : null}
          </strong>
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
  selectedGroup: SidebarGroup | null;
  needsAttention: number;
  nextReset: NextResetSummary;
  onToggleSidebar?: () => void;
  onAdd: () => void;
  onRefreshAll: () => void;
  onEditBucket?: (bucket: AccountBucket) => void;
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
          <div className="dashboard-title-row">
            {props.onToggleSidebar ? (
              <button
                type="button"
                className="mobile-sidebar-toggle-btn"
                onClick={props.onToggleSidebar}
                aria-label="Toggle navigation menu"
                title="Toggle navigation menu"
              >
                <MenuIcon />
              </button>
            ) : null}
            <h1>{props.selectedGroup ? props.selectedGroup.title : "Usage Dashboard"}</h1>
            {props.selectedGroup?.type === "bucket" ? (
              <span className="dashboard-bucket-pill">Custom Group</span>
            ) : null}
          </div>
          {props.selectedGroup ? (
            <p>{props.selectedGroup.accounts.length} {props.selectedGroup.accounts.length === 1 ? "account" : "accounts"}</p>
          ) : null}
        </div>
        <div className="header-actions">
          {props.selectedGroup?.type === "bucket" && props.selectedGroup.bucket ? (
            <button
              type="button"
              className="button ghost edit-bucket-header-btn"
              onClick={() => props.onEditBucket?.(props.selectedGroup!.bucket!)}
            >
              <EditIcon />Edit Group
            </button>
          ) : null}
          <button className="button ghost" onClick={props.onRefreshAll} disabled={props.busy === "refresh-all"}>
            <RefreshIcon />{props.busy === "refresh-all" ? "Refreshing…" : "Refresh All"}
          </button>
          <button className="button primary" onClick={props.onAdd}><PlusIcon />Add Account</button>
        </div>
      </header>

      <section className="summary-grid mockup-summary-grid">
        <div className="mockup-summary-card total-card">
          <div><span className="summary-label">{props.selectedGroup ? `${props.selectedGroup.title} Accounts` : "Total accounts"}</span><strong className="summary-helper">Active</strong></div>
          <div className="summary-value-cluster"><strong>{props.accounts.length}</strong><UsersIcon /></div>
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
            <h2>{props.selectedGroup ? `No accounts in ${props.selectedGroup.title}` : "Connect a provider account"}</h2>
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
  const creditLabel = account.provider !== "openai"
    ? null
    : account.lastUsage?.unlimitedCredits
      ? "Credits: Unlimited"
      : account.lastUsage?.creditsUsd != null
        ? `Credits: $${account.lastUsage.creditsUsd.toFixed(2)}`
        : null;

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
            ) : <h2>{displayAccountLabel(account.label)}</h2>}
            {!editing ? (
              <button type="button" className="account-name-edit" data-tooltip="Edit account name" aria-label={`Edit ${account.label}`} onClick={() => setEditing(true)}>
                <EditIcon />
              </button>
            ) : null}
          </div>
          <p className="account-card-email">{displayAccountSubtitle(account)}</p>
          {renameError ? <small className="account-card-inline-error">{renameError}</small> : null}
        </div>
        <div className={`account-card-header-actions ${account.provider === "google_ai_studio" ? "has-google-action" : ""}`}>
          <div className="account-card-header-meta">
            <span className={`account-status-badge ${status.className}`}>{status.label}</span>
            {displayPlan(account) ? <span className="account-plan-badge">{displayPlan(account)}</span> : null}
            {account.provider === "google_ai_studio" ? (
              <button type="button" className="button ghost compact-button google-cloud-connect-action" disabled={Boolean(busy)} onClick={onConnectGoogleUsage}>
                {modelsOnly ? "Connect Cloud Usage" : "Change Cloud Project"}
              </button>
            ) : null}
          </div>
          <div className="account-card-name-actions">
            <button
              type="button"
              className="account-card-action remove-action"
              data-tooltip="Remove this account"
              aria-label={`Remove ${account.label}`}
              disabled={Boolean(busy)}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={onRemove}
            >{isRemoving ? <span className="mini-spinner" /> : <CloseIcon />}</button>
            <button
              type="button"
              className="account-card-action notify-action"
              data-tooltip="Usage notifications"
              aria-label={`Configure usage notifications for ${account.label}`}
              disabled={Boolean(busy)}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={onNotifications}
            ><BellIcon /></button>
            <button
              type="button"
              className={`account-card-action refresh-action ${isRefreshing ? "spinning" : ""}`}
              data-tooltip="Refresh this account"
              aria-label={`Refresh ${account.label}`}
              disabled={Boolean(busy) && !isRefreshing}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={onRefresh}
            ><RefreshIcon /></button>
          </div>
        </div>
      </header>

      {account.lastError ? (
        <div className="account-card-error">
          <span>{account.lastError}</span>
          {account.authRequired ? <button className="button ghost compact-button" onClick={onReconnect}>{account.provider === "google_ai_studio" ? "Reconnect Cloud Usage" : "Reconnect"}</button> : null}
        </div>
      ) : null}

      <div className={`account-card-metrics${windows.length > 1 ? " two-column-metrics" : ""}${windows.length > 2 ? " multi-row-metrics" : ""}`}>
        {windows.length ? windows.map((window, index) => (
          <AccountUsageMetric
            key={window.id}
            window={window}
            unavailableLabel={googleUnavailableLabel}
            creditLabel={index === 0 ? creditLabel : null}
          />
        )) : (
          <div className="account-usage-metric unavailable-metric">
            <span className="metric-label">Usage</span>
            <div className="metric-value-row">
              <strong className="metric-full-value">Unavailable</strong>
              <span className="account-metric-track"><span className="tone-neutral" style={{ width: "0%" }} /></span>
              {creditLabel ? <span className="metric-inline-credit">{creditLabel}</span> : null}
            </div>
            <span className="metric-reset">Refresh this account to retrieve its limits.</span>
          </div>
        )}
      </div>
    </article>
  );
}

function AccountUsageMetric({
  window,
  unavailableLabel = "Unavailable",
  creditLabel = null,
}: {
  window: UsageWindow;
  unavailableLabel?: string;
  creditLabel?: string | null;
}) {
  const remaining = window.remainingPercent;
  const width = remaining == null ? 0 : Math.min(100, Math.max(0, remaining));
  const tone = usageTone(remaining);
  return (
    <div className="account-usage-metric">
      <div className="metric-heading">
        <span className="metric-label">{displayMetricLabel(window)}</span>
        {windowLength(window) ? (
          <span className={`metric-window-pill ${windowPillClass(window)}`}>
            {windowLength(window)}
          </span>
        ) : null}
      </div>
      <div className="metric-value-row">
        <strong className="metric-full-value">{remaining == null ? unavailableLabel : `${Math.round(remaining)}%`}</strong>
        <span className="account-metric-track"><span className={`tone-${tone}`} style={{ width: `${width}%` }} /></span>
        {creditLabel ? <span className="metric-inline-credit">{creditLabel}</span> : null}
      </div>
      <span className="metric-reset">{window.resetsAt ? `Resets ${formatTime(window.resetsAt)}` : remaining == null ? "This provider has not reported a quota value yet" : "Rolling window"}</span>
    </div>
  );
}

function IntegrationView({
  bridge,
  busy,
  onToggle,
  onView,
  onToggleSidebar,
}: {
  bridge: BridgeStatus | null;
  busy: boolean;
  onToggle: (enabled: boolean) => void;
  onView: () => void;
  onToggleSidebar?: () => void;
}) {
  return (
    <div className="content-scroll narrow-content settings-style-content">
      <header className="page-header">
        <div>
          <div className="dashboard-title-row">
            {onToggleSidebar ? (
              <button
                type="button"
                className="mobile-sidebar-toggle-btn"
                onClick={onToggleSidebar}
                aria-label="Toggle navigation menu"
                title="Toggle navigation menu"
              >
                <MenuIcon />
              </button>
            ) : null}
            <span className="eyebrow">Local API</span>
          </div>
          <h1>Paseo Integration</h1>
          <p>Expose a read-only localhost API for Paseo and other status tools.</p>
        </div>
      </header>
      <section className="settings-card">
        <div className="settings-row">
          <div>
            <strong>Enable Paseo bridge</strong>
            <small>Allows local HTTP tools to read quota usage and notification state.</small>
          </div>
          <button
            type="button"
            className={`toggle ${bridge?.enabled ? "on" : ""}`}
            disabled={busy}
            aria-label={bridge?.enabled ? "Disable Paseo bridge" : "Enable Paseo bridge"}
            aria-pressed={Boolean(bridge?.enabled)}
            onClick={() => onToggle(!bridge?.enabled)}
          >
            <span />
          </button>
        </div>
        <div className="settings-row">
          <div>
            <strong>Integration window</strong>
            <small>Inspect the local bridge status, auth tokens, and connection URL.</small>
          </div>
          <button
            type="button"
            className="button ghost"
            disabled={busy}
            onClick={onView}
          >
            Open Window
          </button>
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
  onAutomaticUpdatesChange,
  installedVersion,
  update,
  updateBusy,
  updateError,
  onCheckForUpdate,
  onInstallUpdate,
  onToggleSidebar,
}: {
  autostart: boolean;
  onToggleAutostart: () => void;
  appSettings: AppSettings | null;
  settingsBusy: boolean;
  onAccountRefreshMinutesChange: (minutes: number) => void;
  onAutomaticUpdatesChange: (enabled: boolean) => void;
  installedVersion: string;
  update: AppUpdateStatus | null;
  updateBusy: UpdateBusy;
  updateError: string | null;
  onCheckForUpdate: () => void;
  onInstallUpdate: () => void;
  onToggleSidebar?: () => void;
}) {
  const automaticUpdates = appSettings?.automaticUpdatesEnabled ?? true;
  return (
    <div className="content-scroll narrow-content settings-style-content">
      <header className="page-header">
        <div>
          <div className="dashboard-title-row">
            {onToggleSidebar ? (
              <button
                type="button"
                className="mobile-sidebar-toggle-btn"
                onClick={onToggleSidebar}
                aria-label="Toggle navigation menu"
                title="Toggle navigation menu"
              >
                <MenuIcon />
              </button>
            ) : null}
            <span className="eyebrow">Application</span>
          </div>
          <h1>Settings</h1>
          <p>Control how AI Usage Tracker behaves on this computer.</p>
        </div>
      </header>
      <section className="settings-card">
        <div className="settings-row"><div><strong>Start at login</strong><small>Keep account usage available after signing in.</small></div><button className={`toggle ${autostart ? "on" : ""}`} onClick={onToggleAutostart} aria-pressed={autostart}><span /></button></div>
        <div className="settings-row"><div><strong>Automatic updates</strong><small>When on, the app checks GitHub Releases at startup and every hour, and can notify you when a signed update is ready.</small></div><button type="button" className={`toggle ${automaticUpdates ? "on" : ""}`} disabled={!appSettings || settingsBusy} aria-label={automaticUpdates ? "Disable automatic updates" : "Enable automatic updates"} aria-pressed={automaticUpdates} onClick={() => onAutomaticUpdatesChange(!automaticUpdates)}><span /></button></div>
        <div className="settings-row"><div><strong>App updates</strong><small>Checks GitHub Releases for a signed installer. Automatic checks stay off when the toggle above is off.</small></div>{update?.available ? <button className="button primary" disabled={updateBusy !== null} onClick={onInstallUpdate}>{updateBusy === "installing" ? "Installing…" : `Update to v${update.availableVersion}`}</button> : <button className="button ghost" disabled={updateBusy !== null} onClick={onCheckForUpdate}>{updateBusy === "checking" ? "Checking…" : "Check for Updates"}</button>}</div>
        <div className="settings-row"><div><strong>Installed version</strong><small>{update?.available ? `Version ${update.availableVersion} is available.` : "The app installs only signed update packages."}</small></div><span className="setting-value mono">{`v${update?.currentVersion || installedVersion}`}</span></div>
        <div className="settings-row"><div><strong>Account Updates</strong><small>The selected number of minutes controls how often the app checks your AI usage percentages.</small></div><select className="account-update-select" aria-label="Account update interval" value={appSettings?.accountRefreshMinutes ?? 5} disabled={!appSettings || settingsBusy} onChange={(event) => onAccountRefreshMinutesChange(Number(event.target.value))}>{ACCOUNT_REFRESH_OPTIONS.map((minutes) => <option key={minutes} value={minutes}>{minutes} minutes</option>)}</select></div>
      </section>
      {update?.available && update.body ? <section className="update-notes"><strong>What changed in v{update.availableVersion}</strong><p>{update.body}</p>{update.date ? <small>Published {formatTime(update.date)}</small> : null}</section> : null}
      {updateError ? <div className="error-panel settings-update-error">{updateError}</div> : null}
    </div>
  );
}

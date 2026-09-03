import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { bridgeApi } from "./api";
import { resumeLoginAttemptWatch, subscribeLoginStatus } from "./login-status";
import { AccountAlertModal } from "./components/AccountAlertModal";
import { RemoveAccountModal } from "./components/RemoveAccountModal";
import { AddAccountModal } from "./components/AddAccountModal";
import { BucketModal } from "./components/BucketModal";
import { CustomDropdown } from "./components/CustomDropdown";
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
  ExternalLinkIcon,
  GaugeIcon,
  LinkIcon,
  MenuIcon,
  PlusIcon,
  RefreshIcon,
  SettingsIcon,
  TrashIcon,
  UsersIcon,
} from "./icons";
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
  type: "all" | "bucket" | "provider";
  title: string;
  provider: Provider | null;
  accounts: Account[];
  bucket?: AccountBucket;
};

type NextResetSummary = {
  account: string | null;
  value: string;
  resetsAt: string | null;
};

const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;
// Shown only until getVersion() resolves; getVersion() is the single source of truth.
const FALLBACK_APP_VERSION = "0.3.4";
const DASHBOARD_SYNC_INTERVAL_MS = 30 * 1000;
const STARTUP_REFRESH_DELAY_MS = 3 * 1000;
const GOOGLE_AI_STUDIO_MODELS_ONLY_SOURCE = "google_ai_studio_model_access";
const DEFAULT_ACCOUNT_REFRESH_MINUTES = 15;
const SIDEBAR_UPDATE_FEEDBACK_MS = 3_000;
const ACCOUNT_REFRESH_OPTIONS = [5, 10, 15, 30, 45, 60] as const;
const SIDEBAR_WINDOW_KEY = "ai-subscription-tracker:provider-average-window";
const ALL_ACCOUNTS_GROUP_ID = "all";
const RELATIVE_TIME_TICK_MS = 30 * 1000;
const CHANGELOG_URL = "https://github.com/dubba/AI-Usage-Tracker/blob/main/CHANGELOG.md";

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

// Legacy accounts were auto-labelled with an older provider display name
// (e.g. "Google Antigravity"). Collapse only those legacy labels and only for
// the matching provider; a user who renames an account keeps their exact name.
const LEGACY_DEFAULT_LABELS: Partial<Record<Provider, string[]>> = {
  antigravity: ["Google Antigravity"],
  grok: ["Grok / SuperGrok"],
  openai: ["OpenAI Codex", "OpenAI", "Codex"],
  anthropic: ["Anthropic Claude", "Anthropic"],
  google_ai_studio: ["Google AI Studio"],
};

function displayAccountLabel(account: Account): string {
  const legacy = LEGACY_DEFAULT_LABELS[account.provider] ?? [];
  if (legacy.includes(account.label)) return providerName(account.provider);
  return account.label;
}

function displayAccountSubtitle(account: Account): string {
  if (account.email && account.email.trim()) {
    return account.email.trim();
  }
  const label = displayAccountLabel(account);
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

function googleAiStudioHasQuotaWindows(account: Account): boolean {
  return account.provider === "google_ai_studio"
    && account.lastUsage?.source === "google_ai_studio_cloud_monitoring"
    && (account.lastUsage.windows ?? []).some((window) => window.remainingPercent != null);
}

function accountNeedsAttention(account: Account): boolean {
  if (account.provider === "google_ai_studio" && !googleAiStudioHasQuotaWindows(account)) {
    return true;
  }
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
    return { label: "KEY ONLY", className: "warning" };
  }
  if (account.provider === "google_ai_studio" && !googleAiStudioHasQuotaWindows(account)) {
    return { label: "SETUP", className: "warning" };
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
      return [{ resetAt, account: displayAccountLabel(account), resetsAt: window.resetsAt }];
    }),
  );

  if (!candidates.length) {
    return { account: null, value: "—", resetsAt: null };
  }

  candidates.sort((left, right) => left.resetAt - right.resetAt);
  const next = candidates[0];
  return {
    account: next.account,
    value: formatRemainingDuration(next.resetAt - now) ?? "—",
    resetsAt: next.resetsAt,
  };
}

function formatHoursAndDays(totalHours: number): string {
  if (totalHours < 24) return `${totalHours}h`;
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  return hours === 0 ? `${days}d` : `${days}d ${hours}h`;
}

function formatRemainingDuration(remainingMs: number): string | null {
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return null;
  const remainingMinutes = Math.max(1, Math.ceil(remainingMs / 60_000));
  if (remainingMinutes < 60) return `${remainingMinutes}m`;
  return formatHoursAndDays(Math.max(1, Math.ceil(remainingMs / 3_600_000)));
}

function accountAutoRefreshEligible(account: Account): boolean {
  if (account.authRequired) return false;
  if (account.provider === "google_ai_studio" && account.lastUsage?.source === GOOGLE_AI_STUDIO_MODELS_ONLY_SOURCE) {
    return false;
  }
  return true;
}

function accountsNeedScheduledRefresh(accounts: Account[], minutes: number, now = Date.now()): boolean {
  const maxAgeMs = minutes * 60_000;
  return accounts.some((account) => {
    if (!accountAutoRefreshEligible(account)) return false;
    const fetchedAt = account.lastUsage?.fetchedAt;
    if (!fetchedAt) return true;
    const then = Date.parse(fetchedAt);
    if (!Number.isFinite(then)) return true;
    return now - then >= maxAgeMs;
  });
}

function formatUpdatedAt(value: string | null | undefined, now = Date.now()): string | null {
  if (!value) return null;
  const then = new Date(value).getTime();
  if (!Number.isFinite(then)) return null;
  const elapsed = Math.max(0, now - then);
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "Updated just now";
  if (minutes < 60) return `Updated ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Updated ${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `Updated ${days}d ago`;
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

function resetCountdownLabel(value: string | null | undefined): string | null {
  if (!value) return null;
  const resetAt = new Date(value).getTime();
  if (!Number.isFinite(resetAt)) return null;
  const remaining = formatRemainingDuration(resetAt - Date.now());
  return remaining ? `Resets in: ${remaining}` : null;
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
  const [selectedGroupId, setSelectedGroupId] = useState(ALL_ACCOUNTS_GROUP_ID);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [providerOrder, setProviderOrder] = useState<Provider[]>(readDashboardProviderOrder);
  const [sidebarGroupOrder, setSidebarGroupOrder] = useState<string[]>(readSidebarGroupOrder);
  const [sidebarWindow, setSidebarWindow] = useState<SidebarWindow>(readSidebarWindow);
  const [section, setSection] = useState<Section>("accounts");
  const [addOpen, setAddOpen] = useState(false);
  const [bucketModalOpen, setBucketModalOpen] = useState(false);
  const [bucketToEdit, setBucketToEdit] = useState<AccountBucket | null>(null);
  const [bucketInitialProvider, setBucketInitialProvider] = useState<Provider | null>(null);
  const [bucketConfirmDelete, setBucketConfirmDelete] = useState(false);
  const [alertAccount, setAlertAccount] = useState<Account | null>(null);
  const [accountToRemove, setAccountToRemove] = useState<Account | null>(null);
  const [googleUsageAccount, setGoogleUsageAccount] = useState<Account | null>(null);
  const addOpenRef = useRef(addOpen);
  const googleUsageAccountRef = useRef(googleUsageAccount);
  addOpenRef.current = addOpen;
  googleUsageAccountRef.current = googleUsageAccount;
  const [loginLabel, setLoginLabel] = useState("");
  const [loginProvider, setLoginProvider] = useState<Provider | undefined>(undefined);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [autostart, setAutostart] = useState(false);
  const [appSettings, setAppSettings] = useState<AppSettings | null>(null);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [installedVersion, setInstalledVersion] = useState(FALLBACK_APP_VERSION);
  const [appUpdate, setAppUpdate] = useState<AppUpdateStatus | null>(null);
  const [updateBusy, setUpdateBusy] = useState<UpdateBusy>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [updateMessage, setUpdateMessage] = useState<string | null>(null);
  const updateMessageTimerRef = useRef<number | null>(null);
  const updateErrorTimerRef = useRef<number | null>(null);
  const appSettingsRef = useRef(appSettings);
  const refreshDueInFlightRef = useRef(false);
  const wasHiddenRef = useRef(false);
  appSettingsRef.current = appSettings;

  const showTransientUpdateMessage = useCallback((msg: string | null) => {
    if (updateMessageTimerRef.current) {
      window.clearTimeout(updateMessageTimerRef.current);
      updateMessageTimerRef.current = null;
    }
    setUpdateMessage(msg);
    if (msg) {
      updateMessageTimerRef.current = window.setTimeout(() => {
        setUpdateMessage(null);
        updateMessageTimerRef.current = null;
      }, 5_000);
    }
  }, []);

  const showTransientUpdateError = useCallback((err: string | null) => {
    if (updateErrorTimerRef.current) {
      window.clearTimeout(updateErrorTimerRef.current);
      updateErrorTimerRef.current = null;
    }
    setUpdateError(err);
    if (err) {
      updateErrorTimerRef.current = window.setTimeout(() => {
        setUpdateError(null);
        updateErrorTimerRef.current = null;
      }, 5_000);
    }
  }, []);

  useEffect(() => {
    if (!error) return;
    const timer = window.setTimeout(() => {
      setError(null);
    }, 5_000);
    return () => window.clearTimeout(timer);
  }, [error]);

  useEffect(() => {
    return () => {
      if (updateMessageTimerRef.current) window.clearTimeout(updateMessageTimerRef.current);
      if (updateErrorTimerRef.current) window.clearTimeout(updateErrorTimerRef.current);
    };
  }, []);

  const openAdd = useCallback((account?: Account, provider?: Provider) => {
    setLoginLabel(account?.label ?? "");
    setLoginProvider(account?.provider ?? provider);
    setAddOpen(true);
  }, []);

  const openNewBucket = useCallback((provider?: Provider | null) => {
    setBucketToEdit(null);
    setBucketInitialProvider(provider ?? null);
    setBucketConfirmDelete(false);
    setBucketModalOpen(true);
  }, []);

  const openEditBucket = useCallback((bucket: AccountBucket) => {
    setBucketToEdit(bucket);
    setBucketInitialProvider(bucket.provider);
    setBucketConfirmDelete(false);
    setBucketModalOpen(true);
  }, []);

  const openDeleteBucket = useCallback((bucket: AccountBucket) => {
    setBucketToEdit(bucket);
    setBucketInitialProvider(bucket.provider);
    setBucketConfirmDelete(true);
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

  const checkForUpdate = useCallback(async (showFeedback = false) => {
    setUpdateBusy("checking");
    if (showFeedback) {
      showTransientUpdateMessage(null);
      showTransientUpdateError(null);
    }
    try {
      const status = await bridgeApi.checkForUpdate();
      if (status.error) {
        if (showFeedback) {
          showTransientUpdateError(status.error);
        }
        setAppUpdate((current) => (current?.available && !showFeedback ? current : status));
        return;
      }
      setAppUpdate(status);
      if (showFeedback) {
        if (status.available && status.availableVersion) {
          showTransientUpdateMessage(`Version ${status.availableVersion} is ready to install.`);
        } else {
          showTransientUpdateMessage(`You are on the latest version (v${status.currentVersion || installedVersion}).`);
        }
      }
    } catch (cause) {
      if (showFeedback) {
        showTransientUpdateError(String(cause));
      }
    } finally {
      setUpdateBusy(null);
    }
  }, [installedVersion, showTransientUpdateMessage, showTransientUpdateError]);

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

  const setApiIntegrationEnabled = useCallback(async (enabled: boolean) => {
    setBusy("toggle-api-integration");
    try {
      const status = await bridgeApi.setApiIntegrationEnabled(enabled);
      setSnapshot((current) => current ? { ...current, bridge: status } : null);
      setError(null);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(null);
    }
  }, []);

  const openApiIntegrationWindow = useCallback(async () => {
    setBusy("open-api-integration");
    try {
      await bridgeApi.openApiIntegrationWindow();
      setError(null);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(null);
    }
  }, []);

  useEffect(() => {
    void load();
    getVersion().then(setInstalledVersion).catch(() => setInstalledVersion(FALLBACK_APP_VERSION));
    bridgeApi.getAppSettings().then(setAppSettings).catch((cause) => setError(String(cause)));
    bridgeApi.getAutostart().then(setAutostart).catch(() => setAutostart(false));
    const syncInterval = window.setInterval(() => void load(), DASHBOARD_SYNC_INTERVAL_MS);
    const initialRefreshTimeout = window.setTimeout(() => void bridgeApi.refreshAll().then(() => load()), STARTUP_REFRESH_DELAY_MS);
    return () => {
      window.clearInterval(syncInterval);
      window.clearTimeout(initialRefreshTimeout);
    };
  }, [load]);

  const refreshAccountsIfDue = useCallback(async () => {
    if (refreshDueInFlightRef.current) return;
    refreshDueInFlightRef.current = true;
    try {
      const latest = await bridgeApi.snapshot();
      setSnapshot(latest);
      const minutes = appSettingsRef.current?.accountRefreshMinutes ?? DEFAULT_ACCOUNT_REFRESH_MINUTES;
      if (!accountsNeedScheduledRefresh(latest.accounts, minutes)) return;
      await bridgeApi.refreshAll();
      await load();
    } catch (cause) {
      setError(String(cause));
    } finally {
      refreshDueInFlightRef.current = false;
    }
  }, [load]);

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        wasHiddenRef.current = true;
        return;
      }
      if (document.visibilityState === "visible" && wasHiddenRef.current) {
        wasHiddenRef.current = false;
        void refreshAccountsIfDue();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [refreshAccountsIfDue]);

  useEffect(() => {
    void resumeLoginAttemptWatch();
    return subscribeLoginStatus((status) => {
      if (status.status === "complete") {
        void load();
        return;
      }
      if (status.status === "failed") {
        if (status.message && !addOpenRef.current && googleUsageAccountRef.current == null) {
          setError(status.message);
        }
        return;
      }
      if ((status.status === "choose_project" || status.status === "monitoring_disabled") && status.account) {
        setGoogleUsageAccount(status.account);
      }
    });
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
    if (!appSettings?.automaticUpdatesEnabled) return;
    void checkForUpdate(false);
    const updateInterval = window.setInterval(() => void checkForUpdate(false), UPDATE_CHECK_INTERVAL_MS);
    return () => window.clearInterval(updateInterval);
  }, [appSettings?.automaticUpdatesEnabled, checkForUpdate]);

  useEffect(() => {
    const tick = window.setInterval(() => setNowMs(Date.now()), RELATIVE_TIME_TICK_MS);
    return () => window.clearInterval(tick);
  }, []);

  const accounts = snapshot?.accounts ?? [];
  const buckets = snapshot?.buckets ?? [];

  const sidebarGroups = useMemo<SidebarGroup[]>(() => {
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

  const allAccountsGroup = useMemo<SidebarGroup>(() => ({
    id: ALL_ACCOUNTS_GROUP_ID,
    type: "all",
    title: "All",
    provider: null,
    accounts,
  }), [accounts]);

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

  const visibleAccounts = selectedGroup.accounts;
  const needsAttention = visibleAccounts.filter(accountNeedsAttention).length;
  const nextReset = nextResetSummary(visibleAccounts);

  const refreshOne = async (id: string) => {
    if (busy === `refresh:${id}` || busy === "refresh-all") return;
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
    if (busy === `remove:${account.id}`) return;
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
      const next = !autostart;
      const updated = await bridgeApi.setAutostart(next);
      setAutostart(updated);
    } catch (cause) {
      setError(String(cause));
    }
  };

  const changeSidebarWindow = (value: SidebarWindow) => {
    setSidebarWindow(value);
    storeSidebarWindow(value);
  };

  const renderContent = () => {
    if (section === "integration") {
      return (
        <IntegrationView
          bridge={snapshot?.bridge ?? null}
          busy={busy === "toggle-api-integration" || busy === "open-api-integration"}
          onToggle={(enabled) => void setApiIntegrationEnabled(enabled)}
          onView={() => void openApiIntegrationWindow()}
          onToggleSidebar={() => setSidebarOpen((prev) => !prev)}
          error={error}
        />
      );
    }
    if (section === "settings") {
      return (
        <SettingsView
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
          updateMessage={updateMessage}
          error={error}
          onCheckForUpdate={() => void checkForUpdate(true)}
          onInstallUpdate={() => void installUpdate()}
          onToggleSidebar={() => setSidebarOpen((prev) => !prev)}
        />
      );
    }
    return (
      <AccountsView
        allAccounts={accounts}
        accounts={visibleAccounts}
        selectedGroup={selectedGroup}
        needsAttention={needsAttention}
        nextReset={nextReset}
        onToggleSidebar={() => setSidebarOpen((prev) => !prev)}
        onAdd={() => openAdd(undefined, selectedGroup.provider ?? undefined)}
        onRefreshAll={refreshAll}
        onEditBucket={openEditBucket}
        onDeleteBucket={openDeleteBucket}
        nowMs={nowMs}
        onRefresh={(account) => void refreshOne(account.id)}
        onReconnect={(account) => account.provider === "google_ai_studio" ? setGoogleUsageAccount(account) : openAdd(account)}
        onConnectGoogleUsage={setGoogleUsageAccount}
        onRename={(account, label) => rename(account, label)}
        onRemove={setAccountToRemove}
        onNotifications={setAlertAccount}
        busy={busy}
        error={error}
      />
    );
  };

  return (
    <div className="app-shell obsidian-shell">
      <div
        className={`sidebar-backdrop ${sidebarOpen ? "active" : ""}`}
        onClick={() => setSidebarOpen(false)}
        aria-hidden="true"
      />
      <aside className={`sidebar ${sidebarOpen ? "mobile-open" : ""}`}>
        <div className="sidebar-mobile-header">
          <button
            type="button"
            className="mobile-sidebar-toggle-btn mobile-sidebar-close-btn"
            onClick={() => setSidebarOpen(false)}
            aria-label="Close navigation menu"
            title="Close navigation menu"
          >
            <CloseIcon />
          </button>
          <span className="eyebrow sidebar-title">AI Usage Tracker</span>
        </div>
        <div className="brand">
          <span className="brand-mark"><GaugeIcon /></span>
          <strong>AI Usage Tracker</strong>
        </div>

        <nav className="primary-nav">
          <button className={section === "accounts" ? "active" : ""} onClick={() => { setSection("accounts"); setSidebarOpen(false); }}><UsersIcon />Dashboard</button>
          <button className={section === "integration" ? "active" : ""} onClick={() => { setSection("integration"); setSidebarOpen(false); }}><LinkIcon />Integrations</button>
          <button className={section === "settings" ? "active" : ""} onClick={() => { setSection("settings"); setSidebarOpen(false); }}><SettingsIcon />Settings</button>
        </nav>

        <div className="provider-sidebar-heading">
          <span>Accounts</span>
          <div className="provider-sidebar-heading-actions">
            <button
              type="button"
              className="button primary compact-button add-bucket-header-button"
              title="Create a custom bucket group"
              onClick={() => { openNewBucket(selectedGroup.provider); setSidebarOpen(false); }}
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
          <SidebarGroupRow
            group={allAccountsGroup}
            window={sidebarWindow}
            selected={section === "accounts" && selectedGroup.id === ALL_ACCOUNTS_GROUP_ID}
            onSelect={() => {
              setSelectedGroupId(ALL_ACCOUNTS_GROUP_ID);
              setSection("accounts");
              setSidebarOpen(false);
            }}
          />
          {sidebarGroups.map((group) => (
            <SidebarGroupRow
              key={group.id}
              group={group}
              window={sidebarWindow}
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

        <SidebarUpdateButton
          update={appUpdate}
          updateBusy={updateBusy}
          updateError={updateError}
          onCheck={() => void checkForUpdate(true)}
          onInstall={() => void installUpdate()}
        />
      </aside>

      <main className="main-stage">
        {snapshot ? renderContent() : (
          <div className="loading-screen" aria-busy="true" aria-live="polite">
            {error ? (
              <div className="loading-error" role="alert">
                <div className="error-panel">{error}</div>
                <button className="button" type="button" autoFocus onClick={() => { setError(null); void load(); }}>
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
        initialLabel={loginLabel}
        initialProvider={loginProvider}
        onClose={() => setAddOpen(false)}
        onAdded={async (account) => {
          setAddOpen(false);
          setSelectedGroupId(`provider:${account.provider}`);
          setSection("accounts");
          let nextAccount = account;
          try {
            nextAccount = await bridgeApi.refreshAccount(account.id);
          } catch {
            /* The account remains available with cached state. */
          }
          await load();
          if (nextAccount.provider === "google_ai_studio" && !googleAiStudioHasQuotaWindows(nextAccount)) {
            setGoogleUsageAccount(nextAccount);
          }
        }}
      />
      <BucketModal
        open={bucketModalOpen}
        bucket={bucketToEdit}
        initialProvider={bucketInitialProvider}
        accounts={accounts}
        initialConfirmDelete={bucketConfirmDelete}
        onClose={() => {
          setBucketModalOpen(false);
          setBucketConfirmDelete(false);
        }}
        onSaved={async (saved) => {
          setBucketModalOpen(false);
          setBucketConfirmDelete(false);
          setSelectedGroupId(`bucket:${saved.id}`);
          await load();
        }}
        onDeleted={async (deletedId) => {
          setBucketModalOpen(false);
          setBucketConfirmDelete(false);
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

function SidebarUpdateButton({
  update,
  updateBusy,
  updateError,
  onCheck,
  onInstall,
}: {
  update: AppUpdateStatus | null;
  updateBusy: UpdateBusy;
  updateError: string | null;
  onCheck: () => void;
  onInstall: () => void;
}) {
  const [transientLabel, setTransientLabel] = useState<string | null>(null);
  const initiatedRef = useRef<"check" | "install" | null>(null);
  const available = Boolean(update?.available && update.availableVersion);

  useEffect(() => {
    if (updateBusy) {
      setTransientLabel(null);
      return;
    }
    const action = initiatedRef.current;
    if (!action) return;
    initiatedRef.current = null;
    if (action === "check" && available) return;
    const label = updateError
      ? action === "install"
        ? "Update install failed"
        : "Update check failed"
      : "You’re up to date";
    setTransientLabel(label);
    const timer = window.setTimeout(() => setTransientLabel(null), SIDEBAR_UPDATE_FEEDBACK_MS);
    return () => window.clearTimeout(timer);
  }, [updateBusy, available, updateError]);

  let label = "Check for Updates";
  if (updateBusy === "installing") label = "Installing update…";
  else if (updateBusy === "checking") label = "Checking…";
  else if (transientLabel) label = transientLabel;
  else if (available) label = `Update to v${update!.availableVersion}`;

  const activate = () => {
    if (updateBusy) return;
    initiatedRef.current = available ? "install" : "check";
    if (available) onInstall();
    else onCheck();
  };

  return (
    <>
      <button
        type="button"
        className={`sidebar-footer${available ? " update-available" : ""}`}
        onClick={activate}
        aria-busy={updateBusy !== null}
        aria-label={label}
        title={updateError ?? undefined}
      >
        <RefreshIcon />
        <span>{label}</span>
      </button>
      {available ? (
        <button
          type="button"
          className="sidebar-changelog-link"
          onClick={() => {
            void openUrl(CHANGELOG_URL).catch(() => {
              /* opener errors surface through the native dialog */
            });
          }}
        >
          View Change Log
        </button>
      ) : null}
    </>
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
  const reorderable = group.type !== "all";
  return (
    <button
      type="button"
      className={`provider-summary-row ${group.type === "bucket" ? "is-bucket-row" : ""} ${group.type === "all" ? "is-all-row" : ""} ${selected ? "selected" : ""}`}
      onClick={(e) => {
        if (isReordering()) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        onSelect();
      }}
      data-provider={group.provider ?? undefined}
      data-reorder-provider={group.provider ?? undefined}
      data-group-id={group.id}
      data-reorder-enabled={reorderable ? "true" : undefined}
      aria-label={`${group.title}, ${group.accounts.length} accounts, ${average == null ? "usage unavailable" : `${Math.round(average)} percent average remaining`}`}
    >
      <span className={`provider-summary-icon ${group.provider ? `provider-${group.provider}` : "provider-all"}`}>
        {group.provider ? <ProviderIcon provider={group.provider} /> : <UsersIcon />}
      </span>
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
  selectedGroup: SidebarGroup;
  needsAttention: number;
  nextReset: NextResetSummary;
  onToggleSidebar?: () => void;
  onAdd: () => void;
  onRefreshAll: () => void;
  onEditBucket?: (bucket: AccountBucket) => void;
  onDeleteBucket?: (bucket: AccountBucket) => void;
  nowMs: number;
  onRefresh: (account: Account) => void;
  onReconnect: (account: Account) => void;
  onConnectGoogleUsage: (account: Account) => void;
  onRename: (account: Account, label: string) => Promise<void>;
  onRemove: (account: Account) => void;
  onNotifications: (account: Account) => void;
  busy: string | null;
  error?: string | null;
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
            <div className="dashboard-title-heading">
              <div className="dashboard-title-top">
                <h1 className="eyebrow">
                  {props.selectedGroup.type === "all"
                    ? props.allAccounts.length === 0 ? "Dashboard" : "All accounts"
                    : props.selectedGroup.title}
                </h1>
                {props.selectedGroup.type === "bucket" ? (
                  <span className="dashboard-bucket-pill">Custom Group</span>
                ) : null}
              </div>
              <p className="dashboard-account-count">
                {props.selectedGroup.accounts.length} {props.selectedGroup.accounts.length === 1 ? "account" : "accounts"}
              </p>
            </div>
          </div>
        </div>
        <div className="header-actions">
          {props.selectedGroup.type === "bucket" && props.selectedGroup.bucket ? (
            <button
              type="button"
              className="button ghost edit-bucket-header-btn"
              onClick={() => props.onEditBucket?.(props.selectedGroup.bucket!)}
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
          <div><span className="summary-label">{props.selectedGroup && props.selectedGroup.type !== "all" ? `${props.selectedGroup.title} Accounts` : "Total accounts"}</span><strong className="summary-helper">Active</strong></div>
          <div className="summary-value-cluster"><strong>{props.accounts.length}</strong><UsersIcon /></div>
        </div>
        <div className={`mockup-summary-card attention-card ${props.needsAttention ? "has-attention" : ""}`}>
          <div>
            <span className="summary-label">Action Needed</span>
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
            <span className="next-reset-pill">{props.nextReset.value}</span>
            <ClockIcon />
          </div>
        </div>
      </section>

      <section className="provider-account-cards" data-group-id={props.selectedGroup?.id || undefined}>
        {props.accounts.length ? props.accounts.map((account) => (
          <AccountDashboardCard
            key={account.id}
            account={account}
            busy={props.busy}
            nowMs={props.nowMs}
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
            <h2>
              {props.selectedGroup.type === "bucket"
                ? `No accounts in ${props.selectedGroup.title}`
                : props.selectedGroup.type === "all"
                  ? "Connect a provider account"
                  : `No accounts in ${props.selectedGroup.title}`}
            </h2>
            <p>
              {props.selectedGroup.type === "bucket"
                ? "This group is still saved. Add accounts to it, or delete the group."
                : "Add an account to begin monitoring its limits."}
            </p>
            <div className="empty-group-actions">
              {props.selectedGroup.type === "bucket" && props.selectedGroup.bucket ? (
                <>
                  <button type="button" className="button ghost" onClick={() => props.onEditBucket?.(props.selectedGroup.bucket!)}>
                    <EditIcon />Edit Group
                  </button>
                  <button type="button" className="button ghost bucket-delete-button" onClick={() => props.onDeleteBucket?.(props.selectedGroup.bucket!)}>
                    <TrashIcon />Delete Group
                  </button>
                </>
              ) : null}
              <button className="button primary" onClick={props.onAdd}><PlusIcon />Add Account</button>
            </div>
          </section>
        )}
      </section>
      {props.error ? <div className="error-panel settings-update-error">{props.error}</div> : null}
    </div>
  );
}

function AccountDashboardCard({
  account,
  busy,
  nowMs,
  onRefresh,
  onReconnect,
  onConnectGoogleUsage,
  onRename,
  onRemove,
  onNotifications,
}: {
  account: Account;
  busy: string | null;
  nowMs: number;
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
  // Gate actions per account: refreshing or renaming one card must not freeze
  // the controls of every other card. A global "Refresh All" still locks
  // per-account refresh to avoid redundant provider calls, but leaves
  // remove/notify usable.
  const isGlobalRefresh = busy === "refresh-all";
  const cardBusy = isRefreshing || isRenaming || isRemoving;
  const windows = orderedWindows(account.lastUsage?.windows ?? []);
  const modelsOnly = account.provider === "google_ai_studio" && account.lastUsage?.source === "google_ai_studio_model_access";
  const waitingForMetrics = account.provider === "google_ai_studio" && account.lastUsage?.source === "google_ai_studio_monitoring_waiting";
  const googleUnavailableLabel = modelsOnly ? "Key only" : waitingForMetrics ? "Setup in progress" : "Unavailable";
  const updatedAtLabel = formatUpdatedAt(account.lastUsage?.fetchedAt, nowMs) ?? "Not updated yet";
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
    <article
      className={`provider-account-card ${needsAttention ? "needs-attention" : ""}`}
      data-account-id={account.id}
      data-reorder-provider={account.provider}
      data-reorder-enabled="true"
    >
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
            ) : <h2>{displayAccountLabel(account)}</h2>}
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
              <button type="button" className="button ghost compact-button google-cloud-connect-action" disabled={cardBusy} onClick={onConnectGoogleUsage}>
                {modelsOnly || waitingForMetrics ? "Connect Cloud Usage" : "Change Cloud Project"}
              </button>
            ) : null}
          </div>
          <div className="account-card-action-stack">
            <p className="account-card-updated">{updatedAtLabel}</p>
            <div className="account-card-name-actions">
            <button
              type="button"
              className="account-card-action remove-action"
              data-tooltip="Remove this account"
              aria-label={`Remove ${account.label}`}
              disabled={cardBusy}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={onRemove}
            >{isRemoving ? <span className="mini-spinner" /> : <TrashIcon />}</button>
            <button
              type="button"
              className="account-card-action notify-action"
              data-tooltip="Usage notifications"
              aria-label={`Configure usage notifications for ${account.label}`}
              disabled={cardBusy}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={onNotifications}
            ><BellIcon /></button>
            <button
              type="button"
              className={`account-card-action refresh-action ${isRefreshing ? "spinning" : ""}`}
              data-tooltip={`Refresh this account · ${updatedAtLabel}`}
              aria-label={`Refresh ${account.label}. ${updatedAtLabel}`}
              disabled={cardBusy || isGlobalRefresh}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={onRefresh}
            ><RefreshIcon /></button>
          </div>
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
  const countdown = resetCountdownLabel(window.resetsAt);
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
      <span
        className="metric-reset"
        data-reset-countdown={countdown ?? undefined}
      >
        {window.resetsAt ? `Resets ${formatTime(window.resetsAt)}` : remaining == null ? "This provider has not reported a quota value yet" : "Rolling window"}
      </span>
    </div>
  );
}

function IntegrationView({
  bridge,
  busy,
  onToggle,
  onView,
  onToggleSidebar,
  error,
}: {
  bridge: BridgeStatus | null;
  busy: boolean;
  onToggle: (enabled: boolean) => void;
  onView: () => void;
  onToggleSidebar?: () => void;
  error?: string | null;
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
            <span className="eyebrow">API Integration</span>
          </div>
          <p>Expose localhost API for Paseo & other status tools.</p>
        </div>
      </header>
      <section className="settings-card">
        <div className="settings-row">
          <div>
            <strong>Enable Paseo bridge</strong>
            <small>Allows local HTTP tools to access quota usage & notification status.</small>
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
            <small>View the local bridge status, auth tokens, and connection URL.</small>
          </div>
          <button
            type="button"
            className="button ghost settings-changelog-button"
            disabled={busy}
            onClick={onView}
          >
            <span>View</span>
            <ExternalLinkIcon />
          </button>
        </div>
      </section>
      {bridge?.error ? <div className="error-panel api-integration-error">{bridge.error}</div> : null}
      {error ? <div className="error-panel settings-update-error">{error}</div> : null}
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
  updateMessage,
  error,
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
  updateMessage?: string | null;
  error?: string | null;
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
            <span className="eyebrow">App Settings</span>
          </div>
          <p>Control how AI Usage Tracker app behaves.</p>
        </div>
      </header>
      <section className="settings-card">
        <div className="settings-row">
          <div>
            <strong>{typeof navigator !== "undefined" && /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ? "Start on device boot" : "Start at login"}</strong>
            <small>{typeof navigator !== "undefined" && /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ? "Start app automatically at device startup." : "Start app automatically at login."}</small>
          </div>
          <button className={`toggle ${autostart ? "on" : ""}`} onClick={onToggleAutostart} aria-pressed={autostart}><span /></button>
        </div>
        <div className="settings-row settings-updates-group-row">
          <div className="settings-updates-group-header">
            <div>
              <strong>App Updates</strong>
              <small>Automatically check for updates.</small>
            </div>
            <button
              type="button"
              className={`toggle ${automaticUpdates ? "on" : ""}`}
              disabled={!appSettings || settingsBusy}
              aria-label={automaticUpdates ? "Disable automatic updates" : "Enable automatic updates"}
              aria-pressed={automaticUpdates}
              onClick={() => onAutomaticUpdatesChange(!automaticUpdates)}
            >
              <span />
            </button>
          </div>

          <div className="settings-updates-subcard">
            <div className="settings-updates-subcard-info">
              <span className="settings-installed-version mono">{`v${update?.currentVersion || installedVersion}`}</span>
              <span className="settings-updates-subcard-dot">•</span>
              <span className={`settings-updates-subcard-status ${update?.available ? "update-available" : ""}`}>
                {update?.available && update.availableVersion
                  ? `Version ${update.availableVersion} available`
                  : updateBusy === "checking"
                  ? "Checking for updates…"
                  : "Up to date"}
              </span>
            </div>
            {update?.available ? (
              <button
                type="button"
                className="button primary settings-update-action"
                disabled={updateBusy !== null}
                onClick={onInstallUpdate}
              >
                {updateBusy === "installing" ? "Installing…" : `Update to v${update.availableVersion}`}
              </button>
            ) : (
              <button
                type="button"
                className="button ghost settings-update-action"
                disabled={updateBusy !== null}
                onClick={onCheckForUpdate}
              >
                {updateBusy === "checking" ? "Checking…" : "Check Now"}
              </button>
            )}
          </div>
        </div>
        <div className="settings-row">
          <div>
            <strong>Account Updates</strong>
            <small>Set how often the app updates your AI usage.</small>
          </div>
          <div className="settings-account-refresh">
            <CustomDropdown<number>
              value={
                appSettings?.accountRefreshMinutes != null &&
                (ACCOUNT_REFRESH_OPTIONS as readonly number[]).includes(appSettings.accountRefreshMinutes)
                  ? appSettings.accountRefreshMinutes
                  : 15
              }
              disabled={!appSettings || settingsBusy}
              options={ACCOUNT_REFRESH_OPTIONS.map((minutes) => ({
                value: minutes,
                label: `${minutes} minutes`,
              }))}
              onChange={(minutes) => onAccountRefreshMinutesChange(minutes)}
            />
          </div>
        </div>
        <div className="settings-row">
          <div>
            <strong>Change Log</strong>
            <small>View full history of app changes.</small>
          </div>
          <button
            type="button"
            className="button ghost settings-changelog-button"
            aria-label="View change log (opens in a new window)"
            title="Opens in a new window"
            onClick={(event) => {
              const button = event.currentTarget;
              button.title = "Opens in a new window";
              void openUrl(CHANGELOG_URL).catch((cause) => {
                button.title = `Could not open changelog: ${String(cause)}`;
              });
            }}
          >
            <span>View</span>
            <ExternalLinkIcon />
          </button>
        </div>
      </section>
      {update?.available && update.body ? <section className="update-notes"><strong>What changed in v{update.availableVersion}</strong><p>{update.body}</p>{update.date ? <small>Published {formatTime(update.date)}</small> : null}</section> : null}
      {updateMessage ? <div className="info-panel settings-update-info">{updateMessage}</div> : null}
      {updateError ? <div className="error-panel settings-update-error">{updateError}</div> : null}
      {error ? <div className="error-panel settings-update-error">{error}</div> : null}
    </div>
  );
}

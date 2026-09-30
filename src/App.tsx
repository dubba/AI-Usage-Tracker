import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { listen } from "@tauri-apps/api/event";
import { openSafeUrl } from "./utils/safeUrl";
import { bridgeApi, pairingApi } from "./api";
import { useBusyKeys, type BusyKeys } from "./busy";
import { useAppErrors } from "./errors";
import { resumeLoginAttemptWatch, subscribeLoginStatus } from "./login-status";
import { AccountAlertModal } from "./components/AccountAlertModal";
import { RemoveAccountModal } from "./components/RemoveAccountModal";
import { AddAccountModal } from "./components/AddAccountModal";
import { BucketModal } from "./components/BucketModal";
import { CustomDropdown } from "./components/CustomDropdown";
import { ErrorBanner } from "./components/ErrorBanner";
import { GoogleAiStudioUsageModal } from "./components/GoogleAiStudioUsageModal";
import { PairingModal } from "./components/PairingModal";
import { ProviderIcon } from "./components/ProviderIcon";
import { UpdateNotesModal } from "./components/UpdateNotesModal";
import "./pairing.css";
import {
  providerName,
  displayAccountLabel,
  formatResetAtShort,
  googleAiStudioHasQuotaWindows,
  accountNeedsAttention,
  accountStatus,
  canonicalWindow,
  isMonthlyWindow,
  groupAverage,
  nextResetSummary,
  accountsNeedScheduledRefresh,
  formatUpdatedAt,
  usageTone,
  orderedWindows,
  windowLength,
  resetCountdownLabel,
  type NextResetSummary,
} from "./usage-logic";
import {
  DASHBOARD_GROUP_ORDER_EVENT,
  DASHBOARD_PROVIDER_ORDER_EVENT,
  isReordering,
  readDashboardProviderOrder,
  readSidebarGroupOrder,
} from "./dashboard-reorder";
import {
  applyPageAccountOrder,
  applyPageUiState,
  DASHBOARD_PAGE_ORDER_EVENT,
  isCardCollapsedOnPage,
  migrateLegacyCollapsedCards,
  setCardCollapsedOnPage,
} from "./dashboard-page-state";
import {
  BellIcon,
  CheckCircleIcon,
  CheckIcon,
  ChevronIcon,
  ClockIcon,
  CloseIcon,
  EditIcon,
  ExternalLinkIcon,
  GaugeIcon,
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
  AppUpdateProgress,
  AppUpdateStatus,
  BridgeStatus,
  DashboardSnapshot,
  Provider,
  UpdateBusy,
  UsageWindow,
} from "./types";

type Section = "accounts" | "settings";

export type SidebarGroup = {
  id: string;
  type: "all" | "bucket" | "provider";
  title: string;
  provider: Provider | null;
  accounts: Account[];
  bucket?: AccountBucket;
};


const UPDATE_CHECK_INTERVAL_MS = 8 * 60 * 60 * 1000; // 8 hours
// Shown only until getVersion() resolves; getVersion() is the single source of truth.
const FALLBACK_APP_VERSION = "0.3.5";
const DASHBOARD_SYNC_INTERVAL_MS = 30 * 1000;
const STARTUP_REFRESH_DELAY_MS = 3 * 1000;
const DEFAULT_ACCOUNT_REFRESH_MINUTES = 15;
const ACCOUNT_REFRESH_OPTIONS = [5, 10, 15, 30, 45, 60] as const;
const ALL_ACCOUNTS_GROUP_ID = "all";
const RELATIVE_TIME_TICK_MS = 1000;
const CHANGELOG_URL = "https://github.com/dubba/AI-Usage-Tracker/blob/main/CHANGELOG.md";




function displayProviderGroupTitle(provider: Provider, accounts: Account[]): string {
  const labels = accounts.map(displayAccountLabel).filter((label) => label.trim());
  if (labels.length === 0) return providerName(provider);
  const first = labels[0];
  if (labels.every((label) => label === first)) return first;
  return providerName(provider);
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


function formatAlertTime(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
















function cleanModelPrefix(prefix: string): string {
  return prefix
    .replace(/\bclaude\s+and\s+gpt\b/i, "Claude & GPT")
    .replace(/\s+models$/i, "")
    .replace(/\s+model$/i, "")
    .trim();
}

function antigravityGroupLabel(window: UsageWindow): string | null {
  const label = window.label.trim();
  const lower = label.toLowerCase();
  let prefix = "";
  if (label.includes(" · ")) {
    prefix = cleanModelPrefix(label.split(" · ")[0] ?? "");
  } else if (lower.endsWith(" weekly") && lower !== "weekly") {
    prefix = cleanModelPrefix(label.slice(0, -7).trim());
  } else if ((lower.endsWith(" 5 hour") || lower.endsWith(" 5-hour")) && lower !== "5 hour" && lower !== "5-hour") {
    prefix = cleanModelPrefix(label.slice(0, -7).trim());
  } else if (lower.endsWith(" five hour") && lower !== "five hour") {
    prefix = cleanModelPrefix(label.slice(0, -10).trim());
  } else {
    const cleaned = cleanModelPrefix(label);
    if (
      ["weekly", "5 hour", "5-hour", "five hour", "monthly", "rolling", "usage"].includes(cleaned.toLowerCase())
    ) {
      return null;
    }
    prefix = cleaned;
  }
  if (!prefix) return null;
  if (/claude|gpt/i.test(prefix)) {
    return "Other";
  }
  return prefix;
}

function displayMetricLabel(window: UsageWindow, provider?: Provider | string): string {
  const label = window.label.trim();
  const lower = label.toLowerCase();
  const providerLower = provider?.toLowerCase();

  // Model-grouped windows, e.g. "Gemini models · 5 hour", "Claude & GPT models · 5 hour", "GPT · 30-Day Limit"
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

  // Pure standalone window labels or provider-specific defaults
  if (providerLower === "openai") {
    if (window.id.toLowerCase().includes("code_review") || lower.includes("code review")) {
      return "Code Review · Remaining Limit";
    }
    return "GPT · Remaining Limit";
  }

  if (
    lower === "weekly" ||
    lower === "5 hour" ||
    lower === "5-hour" ||
    lower === "five hour" ||
    lower === "five_hour" ||
    lower === "monthly" ||
    lower === "rolling" ||
    lower === "session" ||
    lower === "five hour limit remaining" ||
    lower === "weekly limit remaining" ||
    lower === "5 hour limit remaining" ||
    lower === "5-hour limit remaining" ||
    lower === "limit remaining" ||
    lower === "usage"
  ) {
    if (providerLower === "grok") return "Grok · Remaining Limit";
    return "Remaining Limit";
  }

  return cleanModelPrefix(label);
}

function windowPillClass(window: UsageWindow): string {
  if (canonicalWindow(window, "five_hour")) return "window-pill-5h";
  if (canonicalWindow(window, "weekly")) return "window-pill-7d";
  if (isMonthlyWindow(window)) return "window-pill-monthly";
  return "window-pill-default";
}

function displayPlan(account: Account): string | null {
  const raw = account.plan?.trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();
  const provider = account.provider;
  const withoutTier = raw.replace(/-tier$/i, "").trim();
  const lowStrip = withoutTier.toLowerCase();

  // Reference: user-provided plan table (Free | Budget $5-10 | Standard $20-30 | Mid $100 | Max $200-300)
  // OpenCode: Free | Go $10 | Zen PAYG | Black Tier
  // OpenAI: Free | Go $8 | Plus $20 | Pro $100 | Pro $200
  // Anthropic: Free | Pro $20 | Max $100 | Max $200
  // Google: Free | Plus $5 (4.99→5) | Pro $20 (19.99→20) | Ultra $100 | Ultra $200 - cents rounded to nearest dollar (AI prefix removed)
  // xAI: Free | SuperGrok $30 | SuperGrok $100 | Heavy $300
  // Cursor: Free $0 | Start ~$8-10 | Pro $20 | Pro+ $60 | Ultra $200

  if (provider === "openai") {
    if (lower.includes("free")) return "Free";
    if (lower === "go" || lower.includes("go/") || lowStrip === "go") return "Go/$8";
    if (lower.includes("plus")) return "Plus/$20";
    if (lower.includes("pro")) {
      if (lower.includes("100") || lower.includes("pro/$100")) return "Pro/$100";
      if (lower.includes("200") || lower.includes("enterprise")) return "Pro/$200";
      return "Pro/$200";
    }
    if (lower.includes("team")) return "Team";
    return withoutTier.toUpperCase() || "Free";
  }

  if (provider === "anthropic") {
    if (lower.includes("free")) return "Free";
    if (lower.includes("max")) {
      if (lower.includes("200")) return "Max/$200";
      return "Max/$100";
    }
    if (lower.includes("pro")) return "Pro/$20";
    if (lower === "claude subscription") return "Pro/$20";
    return "Free";
  }

  if (provider === "antigravity") {
    if (lower === "google antigravity" || lower === "antigravity") return "ANTIGRAVITY";
    if (lowStrip === "free" || lower === "free" || lower === "free-tier") return "Free";
    // G1-Pro/$20 removed as redundant
    if (lower.includes("ultra")) {
      if (lower.includes("200") || lower.includes("30tb") || lower.includes("genie")) return "Ultra/$200";
      return "Ultra/$100";
    }
    if (lower.includes("plus")) return "Plus/$5";
    if (lower.includes("pro")) return "Pro/$20";
    const cleaned = withoutTier.replaceAll("_", " ").trim();
    // G1-Pro fallback also removed - treat as Pro
    if (cleaned.toLowerCase().startsWith("g1-")) return "Pro/$20";
    return cleaned.toUpperCase() || "Free";
  }

  if (provider === "google_ai_studio") {
    if (lower.includes("free") || lower === "google ai studio") return "Free";
    if (lower.includes("ultra")) {
      if (lower.includes("200") || lower.includes("30tb") || lower.includes("genie")) return "Ultra/$200";
      return "Ultra/$100";
    }
    if (lower.includes("plus")) return "Plus/$5";
    if (lower.includes("pro")) return "Pro/$20";
    return withoutTier.toUpperCase() || "Free";
  }

  if (provider === "grok") {
    if (lower.includes("free")) return "Free";
    if (lower.includes("heavy")) return "SuperGrok Heavy/$300";
    if (lower.includes("100") || lower.includes("plus")) return "SuperGrok Plus/$100";
    if (lower.includes("supergrok") || lower.includes("sgrok") || lower === "grok" || lower === "grok / supergrok" || lower === "supergrok / grok") {
      return "SuperGrok/$30";
    }
    return "SuperGrok/$30";
  }

  if ((provider as string) === "cursor") {
    if (lower.includes("free")) return "Free";
    if (lower.includes("start")) return "Start/$8";
    if (lower.includes("pro+") || lower.includes("pro +") || lower.includes("60")) return "Pro+/$60";
    if (lower.includes("ultra") || lower.includes("200")) return "Ultra/$200";
    if (lower.includes("pro")) return "Pro/$20";
    return withoutTier.toUpperCase() || "Free";
  }

  if (provider === "opencode_go") {
    if (lower.includes("free")) return "Free";
    if (lower.includes("go")) return "Go/$10";
    if (lower.includes("zen")) return "Zen/PAYG";
    if (lower.includes("black")) return "Black Tier";
    return withoutTier.toUpperCase() || "Go/$10";
  }

  if (lowStrip === "free" || lower === "free" || lower === "free-tier") return "Free";
  return withoutTier.replaceAll("_", " ").toUpperCase() || raw.toUpperCase();
}

export default function App() {
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null);
  const [selectedGroupId, setSelectedGroupId] = useState(ALL_ACCOUNTS_GROUP_ID);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [providerOrder, setProviderOrder] = useState<Provider[]>(readDashboardProviderOrder);
  const [sidebarGroupOrder, setSidebarGroupOrder] = useState<string[]>(readSidebarGroupOrder);
  const [pageOrderTick, setPageOrderTick] = useState(0);
  const [section, setSection] = useState<Section>("accounts");
  const [addOpen, setAddOpen] = useState(false);
  const [bucketModalOpen, setBucketModalOpen] = useState(false);
  const [bucketToEdit, setBucketToEdit] = useState<AccountBucket | null>(null);
  const [bucketInitialProvider, setBucketInitialProvider] = useState<Provider | null>(null);
  const [bucketConfirmDelete, setBucketConfirmDelete] = useState(false);
  const [alertAccount, setAlertAccount] = useState<Account | null>(null);
  const [accountToRemove, setAccountToRemove] = useState<Account | null>(null);
  const [googleUsageAccount, setGoogleUsageAccount] = useState<Account | null>(null);
  const [pairingOpen, setPairingOpen] = useState(false);
  const [pairingInitialUri, setPairingInitialUri] = useState<string | null>(null);
  const addOpenRef = useRef(addOpen);
  const googleUsageAccountRef = useRef(googleUsageAccount);
  addOpenRef.current = addOpen;
  googleUsageAccountRef.current = googleUsageAccount;
  const [loginLabel, setLoginLabel] = useState("");
  const [loginProvider, setLoginProvider] = useState<Provider | undefined>(undefined);
  const { busy, begin: beginBusy, end: endBusy, has: isBusy } = useBusyKeys();
  const { errors, report: reportError, clear: clearError } = useAppErrors();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [autostart, setAutostart] = useState(false);
  const [appSettings, setAppSettings] = useState<AppSettings | null>(null);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [installedVersion, setInstalledVersion] = useState(FALLBACK_APP_VERSION);
  const [inAppAlerts, setInAppAlerts] = useState<Array<{ id: string; title: string; body: string; timestamp: number }>>([]);
  const [appUpdate, setAppUpdate] = useState<AppUpdateStatus | null>(null);
  const [updateBusy, setUpdateBusy] = useState<UpdateBusy>(null);
  const [updateProgress, setUpdateProgress] = useState<AppUpdateProgress | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [updateMessage, setUpdateMessage] = useState<string | null>(null);
  const updateMessageTimerRef = useRef<number | null>(null);
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

  useEffect(() => {
    return () => {
      if (updateMessageTimerRef.current) window.clearTimeout(updateMessageTimerRef.current);
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
    if (isReordering()) return;
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
      clearError("load");
    } catch (cause) {
      reportError("load", cause);
    }
  }, [clearError, reportError]);

  const handlePairingCompleted = useCallback(async () => {
    await load();
    // Refresh app-level settings that may have been imported via pairing
    try {
      const settings = await bridgeApi.getAppSettings();
      setAppSettings(settings);
    } catch {}
    try {
      const auto = await bridgeApi.getAutostart();
      setAutostart(auto);
    } catch {}
    // Force dashboard reorder to re-apply any transferred UI state
    window.dispatchEvent(new Event("focus"));
  }, [load]);

  // Apply UI state transferred via pairing (sidebar order, collapsed cards, etc.)
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<Record<string, unknown>>("pairing-ui-state", (event) => {
      const payload = event.payload as Record<string, unknown>;
      try {
        if (Array.isArray(payload.sidebar_group_order)) {
          window.localStorage.setItem(
            "ai-subscription-tracker:sidebar-group-order",
            JSON.stringify(payload.sidebar_group_order),
          );
          window.dispatchEvent(
            new CustomEvent("ai-subscription-tracker:group-order-changed", {
              detail: payload.sidebar_group_order,
            }),
          );
        }
        if (Array.isArray(payload.provider_order)) {
          window.localStorage.setItem(
            "ai-subscription-tracker:provider-order",
            JSON.stringify(payload.provider_order),
          );
          window.dispatchEvent(
            new CustomEvent("ai-subscription-tracker:provider-order-changed", {
              detail: payload.provider_order,
            }),
          );
        }
        applyPageUiState(payload);
        if (typeof payload.sidebar_width === "number" && payload.sidebar_width > 0) {
          window.localStorage.setItem("paseo-usage-bridge:sidebar-width", String(payload.sidebar_width));
          document.documentElement.style.setProperty("--sidebar-width", `${payload.sidebar_width}px`);
        }
      } catch {}
      window.dispatchEvent(new Event("focus"));
    }).then((fn) => {
      unlisten = fn;
    }).catch(() => {});
    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  const checkForUpdate = useCallback(async (showFeedback = false) => {
    setUpdateBusy("checking");
    const minDelayPromise = new Promise((resolve) => setTimeout(resolve, 500));
    if (showFeedback) {
      showTransientUpdateMessage(null);
      setUpdateError(null);
    }
    try {
      const [status] = await Promise.all([
        bridgeApi.checkForUpdate(),
        minDelayPromise,
      ]);
      if (status.error) {
        if (showFeedback) {
          setUpdateError(status.error);
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
      await minDelayPromise;
      if (showFeedback) {
        setUpdateError(String(cause));
      }
    } finally {
      setUpdateBusy(null);
    }
  }, [installedVersion, showTransientUpdateMessage]);

  const installUpdate = useCallback(async () => {
    setUpdateBusy("downloading");
    setUpdateProgress({ phase: "downloading", downloaded: 0, total: null, percent: null });
    setUpdateError(null);
    try {
      await bridgeApi.installUpdate();
      setUpdateBusy(null);
      setUpdateProgress(null);
      showTransientUpdateMessage("The installer should be open. Confirm the update on the next screen.");
    } catch (cause) {
      const message = String(cause);
      setUpdateError(message);
      setUpdateBusy(null);
      setUpdateProgress(null);
    }
  }, [showTransientUpdateMessage]);

  const saveAccountRefreshMinutes = useCallback(async (minutes: number) => {
    setSettingsBusy(true);
    try {
      const saved = await bridgeApi.setAccountRefreshMinutes(minutes);
      setAppSettings(saved);
      clearError("settings");
    } catch (cause) {
      reportError("settings", cause, "Couldn't save the refresh interval");
    } finally {
      setSettingsBusy(false);
    }
  }, [clearError, reportError]);

  const saveAutomaticUpdatesEnabled = useCallback(async (enabled: boolean) => {
    setSettingsBusy(true);
    try {
      const saved = await bridgeApi.setAutomaticUpdatesEnabled(enabled);
      setAppSettings(saved);
      clearError("settings");
    } catch (cause) {
      reportError("settings", cause, "Couldn't save the automatic updates setting");
    } finally {
      setSettingsBusy(false);
    }
  }, [clearError, reportError]);

  const setApiIntegrationEnabled = useCallback(async (enabled: boolean) => {
    if (!beginBusy("toggle-api-integration")) return;
    try {
      const status = await bridgeApi.setApiIntegrationEnabled(enabled);
      setSnapshot((current) => current ? { ...current, bridge: status } : null);
      clearError("bridge");
    } catch (cause) {
      reportError("bridge", cause, "Couldn't change the API integration");
    } finally {
      endBusy("toggle-api-integration");
    }
  }, [beginBusy, endBusy, clearError, reportError]);

  const openApiIntegrationWindow = useCallback(async () => {
    if (!beginBusy("open-api-integration")) return;
    try {
      await bridgeApi.openApiIntegrationWindow();
      clearError("bridge");
    } catch (cause) {
      reportError("bridge", cause, "Couldn't open the API integration window");
    } finally {
      endBusy("open-api-integration");
    }
  }, [beginBusy, endBusy, clearError, reportError]);

  useEffect(() => {
    migrateLegacyCollapsedCards();
    const onPageOrder = () => setPageOrderTick((tick) => tick + 1);
    window.addEventListener(DASHBOARD_PAGE_ORDER_EVENT, onPageOrder);
    return () => window.removeEventListener(DASHBOARD_PAGE_ORDER_EVENT, onPageOrder);
  }, []);

  useEffect(() => {
    void load();
    getVersion()
      .then((ver) => setInstalledVersion(ver || FALLBACK_APP_VERSION))
      .catch(() => setInstalledVersion(FALLBACK_APP_VERSION));
    bridgeApi.getAppSettings().then(setAppSettings).catch((cause) => reportError("settings", cause, "Couldn't load app settings"));
    bridgeApi.getAutostart().then(setAutostart).catch(() => setAutostart(false));
    const syncInterval = window.setInterval(() => void load(), DASHBOARD_SYNC_INTERVAL_MS);
    const initialRefreshTimeout = window.setTimeout(() => {
      void bridgeApi.refreshAll().then(() => load()).catch((cause) => reportError("refresh-all", cause, "Couldn't refresh accounts"));
    }, STARTUP_REFRESH_DELAY_MS);
    return () => {
      window.clearInterval(syncInterval);
      window.clearTimeout(initialRefreshTimeout);
    };
  }, [load, reportError]);

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
      clearError("refresh-due");
    } catch (cause) {
      reportError("refresh-due", cause, "Couldn't refresh accounts");
    } finally {
      refreshDueInFlightRef.current = false;
    }
  }, [load, clearError, reportError]);

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
        clearError("login");
        void load();
        return;
      }
      if (status.status === "failed") {
        if (status.message && !addOpenRef.current && googleUsageAccountRef.current == null) {
          reportError("login", status.message, "Sign-in failed");
        }
        return;
      }
      if ((status.status === "choose_project" || status.status === "monitoring_disabled") && status.account) {
        setGoogleUsageAccount(status.account);
      }
    });
  }, [load, clearError, reportError]);

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
    // Always check once at launch so users are informed about new versions
    // even when automatic checks are disabled in Settings.
    void checkForUpdate(false);
    if (!appSettings?.automaticUpdatesEnabled) return;
    const updateInterval = window.setInterval(() => void checkForUpdate(false), UPDATE_CHECK_INTERVAL_MS);
    return () => window.clearInterval(updateInterval);
  }, [appSettings?.automaticUpdatesEnabled, checkForUpdate]);

  useEffect(() => {
    const tick = window.setInterval(() => {
      if (isReordering()) return;
      setNowMs(Date.now());
    }, RELATIVE_TIME_TICK_MS);
    return () => window.clearInterval(tick);
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<AppUpdateProgress>("app-update-progress", (event) => {
      const payload = event.payload;
      if (!payload?.phase) return;
      setUpdateBusy(payload.phase);
      setUpdateProgress(payload);
    })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => {});
    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;

    const checkPending = async () => {
      try {
        const uri = await pairingApi.getPendingPairingUri();
        if (uri && (uri.startsWith("aiusage-pair:") || uri.startsWith("aiusage:"))) {
          setPairingInitialUri(uri);
          setPairingOpen(true);
        }
      } catch {}
    };

    void checkPending();

    void listen<string>("pairing-uri-received", (event) => {
      const uri = event.payload;
      if (uri && (uri.startsWith("aiusage-pair:") || uri.startsWith("aiusage:"))) {
        setPairingInitialUri(uri);
        setPairingOpen(true);
      }
    }).then((fn) => {
      unlisten = fn;
    }).catch(() => {});

    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  useEffect(() => {
    let unlistenAlerts: (() => void) | undefined;
    void listen<{
      accountId: string;
      accountLabel: string;
      provider: string;
      windowLabel: string;
      remainingPercent: number;
      thresholdPercent: number;
      title: string;
      body: string;
    }>("usage-alert", (event) => {
      const payload = event.payload;
      if (!payload) return;
      const now = Date.now();
      const alertId = `${payload.accountId}-${payload.windowLabel}-${now}`;
      setInAppAlerts((prev) => [...prev, { id: alertId, title: payload.title, body: payload.body, timestamp: now }]);
      window.setTimeout(() => {
        setInAppAlerts((prev) => prev.filter((a) => a.id !== alertId));
      }, 15000);
    }).then((fn) => {
      unlistenAlerts = fn;
    }).catch(() => {});

    return () => {
      if (unlistenAlerts) unlistenAlerts();
    };
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
    // Follow dashboard card order (oldest → newest) instead of a fixed provider list.
    for (const account of accounts) {
      if (assignedIds.has(account.id) || seenProviders.has(account.provider)) continue;
      seenProviders.add(account.provider);
      const unassigned = accounts.filter(
        (a) => a.provider === account.provider && !assignedIds.has(a.id),
      );
      if (unassigned.length > 0) {
        providerGroups.push({
          id: `provider:${account.provider}`,
          type: "provider",
          title: displayProviderGroupTitle(account.provider, unassigned),
          provider: account.provider,
          accounts: unassigned,
        });
      }
    }
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
          title: displayProviderGroupTitle(provider, unassigned),
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

  const visibleAccounts = useMemo(
    () => applyPageAccountOrder(selectedGroup.accounts, selectedGroup.id),
    [selectedGroup, pageOrderTick],
  );
  const needsAttention = visibleAccounts.filter(accountNeedsAttention).length;
  const nextReset = nextResetSummary(visibleAccounts, nowMs);

  const refreshOne = async (id: string) => {
    if (isBusy("refresh-all")) return;
    const key = `refresh:${id}`;
    if (!beginBusy(key)) return;
    try {
      await bridgeApi.refreshAccount(id);
      await load();
      clearError(key);
    } catch (cause) {
      reportError(key, cause, "Couldn't refresh account");
    } finally {
      endBusy(key);
    }
  };

  const refreshAll = async () => {
    if (!beginBusy("refresh-all")) return;
    try {
      await bridgeApi.refreshAll();
      await load();
      clearError("refresh-all");
    } catch (cause) {
      reportError("refresh-all", cause, "Couldn't refresh accounts");
    } finally {
      endBusy("refresh-all");
    }
  };

  // Rename failures are shown inline on the card (the card catches the rethrow).
  const rename = async (account: Account, label: string) => {
    const trimmed = label.trim();
    if (!trimmed || trimmed === account.label) return;
    const key = `rename:${account.id}`;
    if (!beginBusy(key)) return;
    try {
      await bridgeApi.renameAccount(account.id, trimmed);
      await load();
    } finally {
      endBusy(key);
    }
  };

  const remove = async (account: Account) => {
    const key = `remove:${account.id}`;
    if (isBusy(key)) return;
    setAccountToRemove(null);
    if (alertAccount?.id === account.id) setAlertAccount(null);
    if (!beginBusy(key)) return;
    try {
      await bridgeApi.removeAccount(account.id);
      await load();
      clearError(key);
    } catch (cause) {
      reportError(key, cause, `Couldn't remove ${displayAccountLabel(account)}`);
    } finally {
      endBusy(key);
    }
  };

  const toggleAutostart = async () => {
    try {
      const next = !autostart;
      const updated = await bridgeApi.setAutostart(next);
      setAutostart(updated);
      clearError("autostart");
    } catch (cause) {
      reportError("autostart", cause, "Couldn't change the start-at-login setting");
    }
  };

  const loadError = errors.find((entry) => entry.source === "load");

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
          {sidebarGroups.map((group) => (
            <SidebarGroupRow
              key={group.id}
              group={group}
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
      </aside>

      <main className="main-stage">
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
        busy={Boolean(accountToRemove && busy.has(`remove:${accountToRemove.id}`))}
        onClose={() => setAccountToRemove(null)}
        onConfirm={() => {
          if (accountToRemove) void remove(accountToRemove);
        }}
      />
      <PairingModal
        open={pairingOpen}
        initialJoinUri={pairingInitialUri}
        onClose={() => {
          setPairingOpen(false);
          setPairingInitialUri(null);
        }}
        onCompleted={handlePairingCompleted}
      />
      <ErrorBanner
        errors={snapshot ? errors : errors.filter((entry) => entry.source !== "load")}
        onDismiss={clearError}
      />
      {inAppAlerts.length > 0 && (
        <div className="usage-alert-toast-container" role="region" aria-label="Usage limit alerts">
          {inAppAlerts.slice(-5).map((alert) => (
            <div key={alert.id} className="usage-alert-toast" role="alert">
              <div className="usage-alert-toast-icon">
                <BellIcon />
              </div>
              <div className="usage-alert-toast-content">
                <div className="usage-alert-toast-header">
                  <span className="usage-alert-toast-title">{alert.title}</span>
                  <span className="usage-alert-toast-time">{formatAlertTime(alert.timestamp)}</span>
                </div>
                <div className="usage-alert-toast-body">{alert.body}</div>
              </div>
              <button
                type="button"
                className="usage-alert-toast-close"
                onClick={() => setInAppAlerts((prev) => prev.filter((a) => a.id !== alert.id))}
                aria-label="Dismiss alert"
                data-tooltip="Dismiss"
              >
                <CloseIcon />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SidebarGroupRow({
  group,
  selected,
  onSelect,
}: {
  group: SidebarGroup;
  selected: boolean;
  onSelect: () => void;
}) {
  const five = groupAverage(group.accounts, "five_hour");
  const weekly = groupAverage(group.accounts, "weekly");
  const displayValue = five ?? weekly;
  const toneValue = five != null && weekly != null ? Math.min(five, weekly) : displayValue;
  const width = toneValue == null ? 0 : Math.min(100, Math.max(0, toneValue));
  const tone = usageTone(toneValue);
  const toneFive = five == null ? null : usageTone(five);
  const toneWeekly = weekly == null ? null : usageTone(weekly);
  const labelFive = five == null ? "NA" : `${Math.round(five)}%`;
  const labelWeekly = weekly == null ? "—" : `${Math.round(weekly)}%`;
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
      aria-label={`${group.title}, ${group.accounts.length} accounts, 5h ${labelFive}, 7d ${labelWeekly}`}
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
          <span className="provider-average">
            <span className={five == null ? "tone-na" : `tone-${toneFive}`}>{labelFive}</span>
            <span className="tone-pipe"> | </span>
            <span className={weekly == null ? "tone-na" : `tone-${toneWeekly}`}>{labelWeekly}</span>
          </span>
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
  busy: BusyKeys;
}) {
  const [showAttentionOnly, setShowAttentionOnly] = useState(false);

  useEffect(() => {
    setShowAttentionOnly(false);
  }, [props.selectedGroup.id]);

  useEffect(() => {
    if (showAttentionOnly && props.needsAttention === 0) {
      setShowAttentionOnly(false);
    }
  }, [showAttentionOnly, props.needsAttention]);

  const displayedAccounts = useMemo(() => {
    if (!showAttentionOnly) return props.accounts;
    return props.accounts.filter(accountNeedsAttention);
  }, [showAttentionOnly, props.accounts]);

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
                data-tooltip="Toggle navigation menu"
              >
                <MenuIcon />
              </button>
            ) : null}
            <h1 className="eyebrow">
              {props.selectedGroup.type === "all"
                ? props.allAccounts.length === 0 ? "Dashboard" : "All accounts"
                : `${props.selectedGroup.title} Accounts`}
            </h1>
            {props.selectedGroup.type === "bucket" ? (
              <span className="dashboard-bucket-pill">Group</span>
            ) : null}
            {props.selectedGroup.type === "bucket" && props.selectedGroup.bucket ? (
              <button
                type="button"
                className="button ghost edit-bucket-title-btn"
                onClick={() => props.onEditBucket?.(props.selectedGroup.bucket!)}
                aria-label="Edit Group"
                data-tooltip="Edit Group"
              >
                <EditIcon />
              </button>
            ) : null}
          </div>
          <p className="dashboard-description">This is a dashboard of all your AI subscriptions by usage.</p>
        </div>
        <div className="header-actions">
          {props.selectedGroup.type === "bucket" && props.selectedGroup.bucket ? (
            <button
              type="button"
              className="button ghost edit-bucket-header-btn"
              onClick={() => props.onEditBucket?.(props.selectedGroup.bucket!)}
              aria-label="Edit Group"
              data-tooltip="Edit Group"
            >
              <EditIcon /><span className="edit-bucket-label">Edit Group</span>
            </button>
          ) : null}
          <button className="button ghost dashboard-header-refresh" onClick={props.onRefreshAll} disabled={props.busy.has("refresh-all")}>
            <RefreshIcon />{props.busy.has("refresh-all") ? "Refreshing…" : "Refresh All"}
          </button>
          <button className="button primary dashboard-header-add" onClick={props.onAdd}><PlusIcon />Add Account</button>
        </div>
      </header>

      <div className="dashboard-scroll">
        <section className="summary-grid mockup-summary-grid">
          <div className="mockup-summary-card total-card">
            <div><span className="summary-label">Accounts</span><strong className="summary-helper">Active</strong></div>
            <div className="summary-value-cluster"><strong>{props.accounts.length}</strong><UsersIcon /></div>
          </div>
          <div
            className={`mockup-summary-card attention-card ${props.needsAttention ? "has-attention is-clickable" : ""} ${showAttentionOnly ? "is-filtering" : ""}`}
            role={props.needsAttention ? "button" : undefined}
            tabIndex={props.needsAttention ? 0 : undefined}
            aria-pressed={props.needsAttention ? showAttentionOnly : undefined}
            aria-label={
              props.needsAttention > 0
                ? showAttentionOnly
                  ? "Showing accounts needing attention. Click to show all."
                  : "Show only accounts needing attention"
                : undefined
            }
            data-tooltip={
              props.needsAttention > 0
                ? showAttentionOnly
                  ? "Click to show all accounts"
                  : "Click to filter accounts needing attention"
                : undefined
            }
            onClick={() => {
              if (props.needsAttention > 0) {
                setShowAttentionOnly((prev) => !prev);
              }
            }}
            onKeyDown={(event) => {
              if (props.needsAttention > 0 && (event.key === "Enter" || event.key === " ")) {
                event.preventDefault();
                setShowAttentionOnly((prev) => !prev);
              }
            }}
          >
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

        {showAttentionOnly ? (
          <div className="filter-active-banner">
            <span>Showing {displayedAccounts.length} account{displayedAccounts.length === 1 ? "" : "s"} needing attention</span>
            <button
              type="button"
              className="button ghost compact-button filter-active-clear-btn"
              onClick={() => setShowAttentionOnly(false)}
              aria-label="Show all accounts"
            >
              Show all <CloseIcon />
            </button>
          </div>
        ) : null}

        <section className="provider-account-cards" data-group-id={props.selectedGroup?.id || undefined}>
        {displayedAccounts.length ? displayedAccounts.map((account) => (
          <AccountDashboardCard
            key={`${props.selectedGroup.id}:${account.id}`}
            pageId={props.selectedGroup.id}
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
              {showAttentionOnly
                ? "No accounts need attention"
                : props.selectedGroup.type === "bucket"
                  ? `No accounts in ${props.selectedGroup.title}`
                  : props.selectedGroup.type === "all"
                    ? "Connect a provider account"
                    : `No accounts in ${props.selectedGroup.title}`}
            </h2>
            <p>
              {showAttentionOnly
                ? "All accounts in this view are healthy and reporting live quota."
                : props.selectedGroup.type === "bucket"
                  ? "This group is still saved. Add accounts to it, or delete the group."
                  : "Add an account to begin monitoring its limits."}
            </p>
            <div className="empty-group-actions">
              {showAttentionOnly ? (
                <button type="button" className="button primary" onClick={() => setShowAttentionOnly(false)}>
                  Show All Accounts
                </button>
              ) : (
                <>
                  {props.selectedGroup.type === "bucket" && props.selectedGroup.bucket ? (
                    <>
                      <button type="button" className="button ghost edit-bucket-empty-btn" onClick={() => props.onEditBucket?.(props.selectedGroup.bucket!)}>
                        <EditIcon /><span className="edit-bucket-label">Edit Group</span>
                      </button>
                      <button type="button" className="button ghost bucket-delete-button" onClick={() => props.onDeleteBucket?.(props.selectedGroup.bucket!)}>
                        <TrashIcon />Delete Group
                      </button>
                    </>
                  ) : null}
                  <button className="button primary" onClick={props.onAdd}><PlusIcon />Add Account</button>
                </>
              )}
            </div>
          </section>
        )}
      </section>
      </div>
      <div className="dashboard-mobile-actions">
        <button className="button ghost" onClick={props.onRefreshAll} disabled={props.busy.has("refresh-all")}>
          <RefreshIcon />{props.busy.has("refresh-all") ? "Refreshing…" : "Refresh All"}
        </button>
        <button className="button primary" onClick={props.onAdd}><PlusIcon />Add Account</button>
      </div>
    </div>
  );
}

function AccountDashboardCard({
  pageId,
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
  pageId: string;
  account: Account;
  busy: BusyKeys;
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
  const [isCollapsed, setIsCollapsed] = useState(() => isCardCollapsedOnPage(pageId, account.id));
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(account.label);
  const [renameError, setRenameError] = useState<string | null>(null);
  const committingRenameRef = useRef(false);

  const toggleCollapse = () => {
    setIsCollapsed((prev) => {
      const next = !prev;
      setCardCollapsedOnPage(pageId, account.id, next);
      return next;
    });
  };
  const isRefreshing = busy.has(`refresh:${account.id}`);
  const isRenaming = busy.has(`rename:${account.id}`);
  const isRemoving = busy.has(`remove:${account.id}`);
  // Gate actions per account: refreshing or renaming one card must not freeze
  // the controls of every other card. A global "Refresh All" still locks
  // per-account refresh to avoid redundant provider calls, but leaves
  // remove/notify usable.
  const isGlobalRefresh = busy.has("refresh-all");
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

  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const mobileMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!mobileMenuOpen) return;
    const handleClickOutside = (event: MouseEvent) => {
      if (mobileMenuRef.current && !mobileMenuRef.current.contains(event.target as Node)) {
        setMobileMenuOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMobileMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [mobileMenuOpen]);

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
    if (committingRenameRef.current) return;
    committingRenameRef.current = true;
    try {
      await onRename(next);
      setEditing(false);
      setRenameError(null);
    } catch {
      setRenameError("Unable to rename this account.");
    } finally {
      committingRenameRef.current = false;
    }
  };

  const cancelRename = () => {
    setLabel(account.label);
    setRenameError(null);
    setEditing(false);
  };

  return (
    <article
      className={`provider-account-card ${needsAttention ? "needs-attention" : ""} ${isCollapsed ? "is-collapsed" : ""}`}
      data-account-id={account.id}
      data-reorder-provider={account.provider}
      data-reorder-enabled="true"
    >
      <header className="provider-account-card-header">
        <button
          type="button"
          className={`account-card-provider-icon provider-${account.provider}${isCollapsed ? " is-collapsed" : ""}`}
          onClick={(event) => {
            event.stopPropagation();
            toggleCollapse();
          }}
          data-tooltip={isCollapsed ? "Click to expand card" : "Click to shrink card"}
          aria-label={isCollapsed ? `Expand ${displayAccountLabel(account)}` : `Shrink ${displayAccountLabel(account)} to divider`}
          aria-expanded={!isCollapsed}
        >
          <ProviderIcon provider={account.provider} />
        </button>
        <div className="account-card-identity">
          <div className="account-card-name-row">
            {editing ? (
              <div className="account-card-name-edit-wrap">
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
                  onBlur={cancelRename}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void commitRename();
                    } else if (event.key === "Escape") {
                      event.preventDefault();
                      cancelRename();
                    }
                  }}
                />
                <div className="account-card-name-edit-actions">
                  <button
                    type="button"
                    className="account-name-cancel"
                    data-tooltip="Cancel"
                    aria-label={`Cancel renaming ${account.label}`}
                    disabled={isRenaming}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={cancelRename}
                  >
                    <CloseIcon />
                  </button>
                  <button
                    type="button"
                    className="account-name-confirm"
                    data-tooltip="Save name"
                    aria-label={`Save name for ${account.label}`}
                    disabled={isRenaming}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => void commitRename()}
                  >
                    {isRenaming ? <span className="mini-spinner" /> : <CheckIcon />}
                  </button>
                </div>
              </div>
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
            {status.label !== "LIVE" ? <span className={`account-status-badge ${status.className}`}>{status.label}</span> : null}
            <span className="plan-with-dot">
              <span
                className={`live-dot ${needsAttention || status.label !== "LIVE" ? "attention" : ""}`}
                aria-hidden="true"
              />
              {displayPlan(account) ? <span className="account-plan-badge">{displayPlan(account)}</span> : null}
            </span>
            {account.provider === "google_ai_studio" ? (
              <button type="button" className="button ghost compact-button google-cloud-connect-action" disabled={cardBusy} onClick={onConnectGoogleUsage}>
                {modelsOnly || waitingForMetrics ? "Connect Cloud Usage" : "Change Cloud Project"}
              </button>
            ) : null}
          </div>
          <div className="account-card-action-stack">
            <p className="account-card-updated">{updatedAtLabel}</p>
            <div className="account-card-name-actions desktop-only">
            <button
              type="button"
              className="account-card-action remove-action"
              data-tooltip="Remove this account"
              aria-label={`Remove ${account.label}`}
              disabled={cardBusy}
              onClick={onRemove}
            >{isRemoving ? <span className="mini-spinner" /> : <TrashIcon />}</button>
            <button
              type="button"
              className="account-card-action notify-action"
              data-tooltip="Usage notifications"
              aria-label={`Configure usage notifications for ${account.label}`}
              disabled={cardBusy}
              onClick={onNotifications}
            ><BellIcon /></button>
            <button
              type="button"
              className={`account-card-action refresh-action ${isRefreshing ? "spinning" : ""}`}
              data-tooltip="Refresh this account"
              aria-label={`Refresh ${account.label}`}
              disabled={cardBusy || isGlobalRefresh}
              onClick={onRefresh}
            ><RefreshIcon /></button>
           </div>
            <div className="mobile-actions-dropdown" ref={mobileMenuRef}>
              <button
                type="button"
                className="mobile-dropdown-toggle"
                onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
                aria-expanded={mobileMenuOpen}
                aria-label="More actions"
              >
                <ChevronIcon className={mobileMenuOpen ? "open" : ""} />
              </button>
              {mobileMenuOpen ? (
                <div className="mobile-dropdown-menu">
                  <button type="button" className="mobile-dropdown-item refresh-action" disabled={cardBusy || isGlobalRefresh} onClick={() => { setMobileMenuOpen(false); onRefresh(); }}>
                    <RefreshIcon /> Refresh
                  </button>
                  <button type="button" className="mobile-dropdown-item notify-action" disabled={cardBusy} onClick={() => { setMobileMenuOpen(false); onNotifications(); }}>
                    <BellIcon /> Notifications
                  </button>
                  <button type="button" className="mobile-dropdown-item remove-action" disabled={cardBusy} onClick={() => { setMobileMenuOpen(false); onRemove(); }}>
                    <TrashIcon /> Delete
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </header>

      {!isCollapsed ? (
        <>
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
                provider={account.provider}
                nowMs={nowMs}
                unavailableLabel={googleUnavailableLabel}
                creditLabel={index === 0 ? creditLabel : null}
              />
            )) : (
              <div className="account-usage-metric unavailable-metric">
                <span className="metric-label">Usage</span>
                <div className="metric-reset-row">
                  <span className="metric-reset">Refresh this account to retrieve its limits.</span>
                </div>
                <div className="metric-value-row">
                  <strong className="metric-full-value">Unavailable</strong>
                  <span className="account-metric-track"><span className="tone-neutral" style={{ width: "0%" }} /></span>
                  {creditLabel ? <span className="metric-inline-credit">{creditLabel}</span> : null}
                </div>
              </div>
            )}
          </div>
        </>
      ) : null}
    </article>
  );
}

function resetSummaryLine(
  window: UsageWindow,
  remaining: number | null | undefined,
  nowMs?: number,
): string {
  const countdown = resetCountdownLabel(window.resetsAt, nowMs, window.windowSeconds);
  const when = formatResetAtShort(window.resetsAt);
  if (countdown && when) return `${countdown} (${when})`;
  if (countdown) return countdown;
  if (when) return `Reset: ${when}`;
  if (remaining == null) return "This provider has not reported a quota value yet";
  return "Rolling window";
}

function AccountUsageMetric({
  window,
  provider,
  nowMs,
  unavailableLabel = "Unavailable",
  creditLabel = null,
}: {
  window: UsageWindow;
  provider?: Provider | string;
  nowMs?: number;
  unavailableLabel?: string;
  creditLabel?: string | null;
}) {
  const remaining = window.remainingPercent;
  const width = remaining == null ? 0 : Math.min(100, Math.max(0, remaining));
  const tone = usageTone(remaining);
  const length = windowLength(window);
  const group = provider === "antigravity" ? antigravityGroupLabel(window) : null;
  const pillText = length && group ? `${length} · ${group}` : length;
  return (
    <div className="account-usage-metric">
      <div className="metric-reset-row">
        {pillText ? (
          <span className="metric-reset-lead">
            <span className={`metric-window-pill ${windowPillClass(window)}`}>
              {pillText}
            </span>
          </span>
        ) : <span className="metric-window-pill-spacer" />}
        <span className="metric-reset">
          {resetSummaryLine(window, remaining, nowMs)}
        </span>
      </div>
      <div className="metric-value-row">
        <strong className="metric-full-value">{remaining == null ? unavailableLabel : `${Math.round(remaining)}%`}</strong>
        <span className="account-metric-track"><span className={`tone-${tone}`} style={{ width: `${width}%` }} /></span>
        {creditLabel ? <span className="metric-inline-credit">{creditLabel}</span> : null}
      </div>
    </div>
  );
}

function updateProgressLabel(busy: UpdateBusy, percent: number | null): string {
  if (busy === "downloading") {
    return percent != null ? `Downloading… ${percent}%` : "Downloading…";
  }
  if (busy === "verifying") return "Verifying update…";
  if (busy === "installing") return "Opening installer…";
  return "";
}

function updateInstallLabel(busy: UpdateBusy, percent: number | null): string {
  if (busy === "downloading") {
    return percent != null ? `Downloading ${percent}%` : "Downloading…";
  }
  if (busy === "verifying") return "Verifying…";
  if (busy === "installing") return "Installing…";
  return "Update";
}

function UpdateProgressBar({ busy, percent }: { busy: UpdateBusy; percent: number | null }) {
  if (busy !== "downloading" && busy !== "verifying" && busy !== "installing") return null;
  const label = updateProgressLabel(busy, percent);
  const determinate = busy === "downloading" && percent != null;
  return (
    <div className="settings-update-progress" role="status" aria-live="polite">
      <span className="settings-update-progress-label">{label}</span>
      <div
        className={`settings-update-progress-track${determinate ? "" : " is-indeterminate"}`}
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={determinate ? percent ?? undefined : undefined}
      >
        <div
          className="settings-update-progress-fill"
          style={determinate ? { width: `${percent}%` } : undefined}
        />
      </div>
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
  updateProgress,
  updateError,
  updateMessage,
  onCheckForUpdate,
  onInstallUpdate,
  onToggleSidebar,
  onOpenPairing,
  bridge,
  bridgeBusy,
  onToggleBridge,
  onViewBridgeWindow,
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
  updateProgress: AppUpdateProgress | null;
  updateError: string | null;
  updateMessage?: string | null;
  onCheckForUpdate: () => void;
  onInstallUpdate: () => void;
  onToggleSidebar?: () => void;
  onOpenPairing?: () => void;
  bridge: BridgeStatus | null;
  bridgeBusy: boolean;
  onToggleBridge: (enabled: boolean) => void;
  onViewBridgeWindow: () => void;
}) {
  const [updateNotesOpen, setUpdateNotesOpen] = useState(false);
  const automaticUpdates = appSettings?.automaticUpdatesEnabled ?? true;
  return (
    <div className="content-scroll dashboard-content settings-style-content">
      <header className="dashboard-header">
        <div>
          <div className="dashboard-title-row">
            {onToggleSidebar ? (
              <button
                type="button"
                className="mobile-sidebar-toggle-btn"
                onClick={onToggleSidebar}
                aria-label="Toggle navigation menu"
                data-tooltip="Toggle navigation menu"
              >
                <MenuIcon />
              </button>
            ) : null}
            <h1 className="eyebrow">App Settings</h1>
          </div>
        </div>
      </header>
      <div className="dashboard-scroll">
      <section className="settings-card">
        <div className="settings-row">
          <div>
            <strong>Device Transfer</strong>
            <small>Sync accounts & credentials across devices securely.</small>
          </div>
          <button
            type="button"
            className="button primary"
            onClick={onOpenPairing}
          >
            Link Devices
          </button>
        </div>
      </section>
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
              <span className="settings-installed-version mono">
                {`Current Version: ${String(update?.currentVersion || installedVersion || FALLBACK_APP_VERSION).replace(/^v/i, "")}`}
              </span>
              <div className={`settings-updates-subcard-status ${!updateBusy && update?.available ? "update-available" : ""}`}>
                {updateBusy === "checking" ? (
                  <span>Checking for updates…</span>
                ) : updateBusy === "downloading" || updateBusy === "verifying" || updateBusy === "installing" ? (
                  <span>{updateProgressLabel(updateBusy, updateProgress?.percent ?? null)}</span>
                ) : update?.available && update.availableVersion ? (
                  <>
                    <span className="status-indicator-dot red" aria-hidden="true" />
                    <span>{`Version ${update.availableVersion.replace(/^v/i, "")} available`}</span>
                  </>
                ) : (
                  <>
                    <span className="status-indicator-dot green" aria-hidden="true" />
                    <span>Up to date</span>
                  </>
                )}
              </div>
              {!updateBusy && update?.available && update.availableVersion ? (
                <button
                  type="button"
                  className="settings-view-changelog-link"
                  onClick={() => setUpdateNotesOpen(true)}
                >
                  {`View what changed in v${update.availableVersion.replace(/^v/i, "")}`}
                </button>
              ) : null}
            </div>
            {update?.available ? (
              <button
                type="button"
                className="button danger settings-update-action settings-update-action-danger"
                disabled={updateBusy !== null}
                onClick={onInstallUpdate}
              >
                {updateInstallLabel(updateBusy, updateProgress?.percent ?? null)}
              </button>
            ) : (
              <button
                type="button"
                className="button primary settings-update-action"
                disabled={updateBusy !== null}
                onClick={onCheckForUpdate}
              >
                {updateBusy === "checking" ? "Checking…" : "Check Now"}
              </button>
            )}
            <UpdateProgressBar busy={updateBusy} percent={updateProgress?.percent ?? null} />
            {updateMessage ? <div className="info-panel settings-update-info">{updateMessage}</div> : null}
            {updateError ? <div className="error-panel settings-update-error">{updateError}</div> : null}
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
            data-tooltip="Opens in a new window"
            onClick={(event) => {
              const button = event.currentTarget;
              button.setAttribute("data-tooltip", "Opens in a new window");
              void openSafeUrl(CHANGELOG_URL).catch((cause) => {
                button.setAttribute("data-tooltip", `Could not open changelog: ${String(cause)}`);
              });
            }}
          >
            <span>View</span>
            <ExternalLinkIcon />
          </button>
        </div>
      </section>
      <section className="settings-card">
        <div className="settings-row">
          <div>
            <strong>Enable Paseo bridge</strong>
            <small>Allows local HTTP tools to access quota usage & notification status.</small>
          </div>
          <button
            type="button"
            className={`toggle ${bridge?.enabled ? "on" : ""}`}
            disabled={bridgeBusy}
            aria-label={bridge?.enabled ? "Disable Paseo bridge" : "Enable Paseo bridge"}
            aria-pressed={Boolean(bridge?.enabled)}
            onClick={() => onToggleBridge(!bridge?.enabled)}
          >
            <span />
          </button>
        </div>
        <div className="settings-row">
          <div>
            <strong>Integration window</strong>
            <small>View local bridge status, auth tokens and connection URL.</small>
          </div>
          <button
            type="button"
            className="button ghost settings-changelog-button"
            aria-label="View integration window (opens in a new window)"
            data-tooltip="Opens in a new window"
            disabled={bridgeBusy}
            onClick={onViewBridgeWindow}
          >
            <span>View</span>
            <ExternalLinkIcon />
          </button>
        </div>
      </section>
      {bridge?.error ? <div className="error-panel api-integration-error">{bridge.error}</div> : null}
      </div>
      <UpdateNotesModal
        open={updateNotesOpen}
        version={update?.availableVersion ?? null}
        releaseDate={update?.date}
        releaseNotes={update?.body}
        onClose={() => setUpdateNotesOpen(false)}
        onInstallUpdate={onInstallUpdate}
        updateBusy={updateBusy}
        updatePercent={updateProgress?.percent ?? null}
      />
    </div>
  );
}

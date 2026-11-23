import { logIgnored } from "./log";

/**
 * Every persisted key the UI uses, in one place. The values are the existing
 * ones (they carry mixed historical prefixes) and must not change without a
 * migration, because they hold users' saved layout.
 */
export const STORAGE_KEYS = {
  sidebarGroupOrder: "ai-subscription-tracker:sidebar-group-order",
  providerOrder: "ai-subscription-tracker:provider-order",
  sidebarWidthDesktop: "paseo-usage-bridge:sidebar-width",
  sidebarWidthMobile: "paseo-usage-bridge:sidebar-width-mobile",
  /** "dark" | "oled" | "light" | "system"; also read by public/theme-init.js before the app loads. */
  theme: "ai-usage-tracker:theme",
  /** sessionStorage: survives a reload during sign-in, not an app restart. */
  loginAttempt: "ai-usage-tracker:login-attempt",
  /** "left" | "used": whether usage percentages show the quota remaining or already consumed. */
  usageDisplayMode: "ai-usage-tracker:usage-display-mode",
  /** "7d" | "30d" | "90d": how many days the Usage page shows. */
  activityPeriod: "ai-usage-tracker:activity-period",
  /** "on" | "off": whether the bottom navigation bar shows the page names under its icons. */
  bottomNavLabels: "ai-usage-tracker:bottom-nav-labels",
  /** "activity" | "accounts" | "settings": the page to open on the next launch. */
  openSection: "ai-usage-tracker:open-section",
  /** "on" | "off": whether Dashboard account cards render in compact single-row mode. */
  compactDashboard: "ai-usage-tracker:compact-dashboard",
} as const;

export const STORAGE_PREFIXES = {
  cardCollapsed: "ai-usage-tracker:card-collapsed:",
  pageAccountOrder: "ai-usage-tracker:page-account-order:",
} as const;

/** The onboarding hints: "drag to reorder" and "pull down to refresh". */
export type HintKind = "reorder" | "pull-refresh";
/** The page a hint belongs to; each page counts and dismisses its own copy. */
export type HintPage = "accounts" | "activity";

/**
 * The keys of one hint on one page:
 * - `seen` (local): "1" once the user has done what the hint teaches on that page;
 * - `openCount` (local): how many app sessions the hint was offered in;
 * - `sessionCounted` (session): "1" once this session was added to `openCount`;
 * - `sessionDismissed` (session): "1" if the hint was dismissed in this session.
 *
 * The strings are the ones earlier versions wrote, e.g. `ai-usage-tracker:reorder-hint-seen` and
 * `ai-usage-tracker:activity-pull-refresh-hint-open-count`.
 */
export function hintStorageKeys(kind: HintKind, page: HintPage) {
  const prefix = `ai-usage-tracker:${page === "activity" ? "activity-" : ""}${kind}-hint-`;
  return {
    seen: `${prefix}seen`,
    openCount: `${prefix}open-count`,
    sessionCounted: `${prefix}session-counted`,
    sessionDismissed: `${prefix}session-dismissed`,
  } as const;
}

/** Keys written by older versions; removed on start-up. */
export const LEGACY_STORAGE = {
  opencodeAccountEmails: "ai-subscription-tracker:opencode-account-emails",
  accountEmailPrefix: "paseo-usage-bridge:account-email:",
  settingsAdvancedOpen: "ai-usage-tracker:settings-advanced-open",
} as const;

type Area = "local" | "session";

let reportedUnavailable = false;

function area(which: Area): Storage {
  return which === "session" ? window.sessionStorage : window.localStorage;
}

function guard<T>(fallback: T, action: () => T): T {
  try {
    return action();
  } catch (cause) {
    // WebView storage can be blocked or unavailable; the UI keeps working without persistence.
    if (!reportedUnavailable) {
      reportedUnavailable = true;
      logIgnored("storage", cause);
    }
    return fallback;
  }
}

export function storageGet(key: string, which: Area = "local"): string | null {
  return guard(null, () => area(which).getItem(key));
}

/** Returns false when the value could not be saved. */
export function storageSet(key: string, value: string, which: Area = "local"): boolean {
  return guard(false, () => {
    area(which).setItem(key, value);
    return true;
  });
}

export function storageRemove(key: string, which: Area = "local"): void {
  guard(undefined, () => area(which).removeItem(key));
}

export function storageKeys(prefix: string, which: Area = "local"): string[] {
  return guard<string[]>([], () => {
    const store = area(which);
    const keys: string[] = [];
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i);
      if (key && key.startsWith(prefix)) keys.push(key);
    }
    return keys;
  });
}

/** Every key this app writes starts with one of these (current and older versions). */
const APP_STORAGE_PREFIXES = ["ai-usage-tracker:", "ai-subscription-tracker:", "paseo-usage-bridge:"];

/** Removes everything the app saved in this browser's storage: layout, theme, hints, per-card state. */
export function clearAppStorage(): void {
  for (const which of ["local", "session"] as const) {
    for (const prefix of APP_STORAGE_PREFIXES) {
      for (const key of storageKeys(prefix, which)) storageRemove(key, which);
    }
  }
}

/** Parses stored JSON; anything missing, malformed, or rejected by `isValid` yields `fallback`. */
export function readJson<T>(key: string, fallback: T, isValid?: (value: unknown) => value is T): T {
  const raw = storageGet(key);
  if (raw == null) return fallback;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isValid ? isValid(parsed) : true) return parsed as T;
  } catch {
    // Malformed value: treated the same as a missing one.
  }
  return fallback;
}

export function writeJson(key: string, value: unknown): boolean {
  return storageSet(key, JSON.stringify(value));
}

export const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

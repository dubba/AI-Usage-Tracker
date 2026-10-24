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
  /** "dark" | "light" | "system"; also read by public/theme-init.js before the app loads. */
  theme: "ai-usage-tracker:theme",
  /** sessionStorage: survives a reload during sign-in, not an app restart. */
  loginAttempt: "ai-usage-tracker:login-attempt",
  /** "left" | "used": whether usage percentages show the quota remaining or already consumed. */
  usageDisplayMode: "ai-usage-tracker:usage-display-mode",
  /** "1" once the user has completed a reorder gesture or keyboard reorder. */
  reorderHintSeen: "ai-usage-tracker:reorder-hint-seen",
  /** Number of newly opened app sessions (up to 2) where the reorder hint was eligible to be shown. */
  reorderHintOpenCount: "ai-usage-tracker:reorder-hint-open-count",
  /** sessionStorage: "1" once this session has been counted toward the open count. */
  reorderHintSessionCounted: "ai-usage-tracker:reorder-hint-session-counted",
  /** sessionStorage: "1" if the reorder hint was dismissed in the current session. */
  reorderHintSessionDismissed: "ai-usage-tracker:reorder-hint-session-dismissed",
  /** "true" if the Advanced section in Settings is expanded. */
  settingsAdvancedOpen: "ai-usage-tracker:settings-advanced-open",
  /** "7d" | "30d": how many days the Usage page shows. */
  activityPeriod: "ai-usage-tracker:activity-period",
} as const;

export const STORAGE_PREFIXES = {
  cardCollapsed: "ai-usage-tracker:card-collapsed:",
  pageAccountOrder: "ai-usage-tracker:page-account-order:",
} as const;

/** Keys written by older versions; removed on start-up. */
export const LEGACY_STORAGE = {
  opencodeAccountEmails: "ai-subscription-tracker:opencode-account-emails",
  accountEmailPrefix: "paseo-usage-bridge:account-email:",
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

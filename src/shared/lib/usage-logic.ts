import { formatRemainingDuration } from "./format";
import { providerName } from "./providers";
import { GROK_BOT_WINDOW_ID } from "./usage-sources";
import type { Account, AccountHealth, Provider, UsageWindow, WindowKind } from "../../types";

export type SidebarWindow = "five_hour" | "weekly";

export type NextResetSummary = {
  account: string | null;
  /** The limit that resets: "5-hour", "7-day", "30-day"; null when its length is unknown. */
  limit: string | null;
  value: string;
  resetsAt: string | null;
  /** The provider and window that reset, so the card can name the model ("Gemini", "Bot"); null when none. */
  provider: Provider | null;
  window: UsageWindow | null;
};

const LIMIT_BY_KIND: Record<WindowKind, string> = { five_hour: "5-hour", weekly: "7-day", monthly: "30-day" };

/** A window's length as the Next reset card names it ("5-hour", "7-day"), from its kind or its seconds. */
export function windowLimitName(window: UsageWindow): string | null {
  if (window.kind) return LIMIT_BY_KIND[window.kind];
  if (!window.windowSeconds) return null;
  const hours = Math.round(window.windowSeconds / 3600);
  return hours >= 24 && hours % 24 === 0 ? `${hours / 24}-day` : `${hours}-hour`;
}

// Legacy accounts were auto-labeled with an older provider display name
// (e.g. "Google Antigravity"). Collapse only those obsolete branded defaults
// for the matching provider, including numbered copies ("Grok/Cursor 2").
const LEGACY_DEFAULT_LABELS: Partial<Record<Provider, string[]>> = {
  antigravity: ["Google Antigravity"],
  grok: ["Grok / SuperGrok", "Grok/Cursor"],
  openai: ["OpenAI Codex", "Codex/GPT", "GPT/Codex"],
  anthropic: ["Anthropic Claude"],
  google_ai_studio: ["Google AI Studio"],
};

export function displayAccountLabel(account: Account): string {
  const current = providerName(account.provider);
  const legacy = LEGACY_DEFAULT_LABELS[account.provider] ?? [];
  if (legacy.includes(account.label)) return current;
  for (const old of legacy) {
    const prefix = `${old} `;
    if (account.label.startsWith(prefix)) {
      const rest = account.label.slice(prefix.length);
      if (/^\d+$/.test(rest)) return `${current} ${rest}`;
    }
  }
  return account.label;
}
// An account's health and Google setup are worked out by the backend (`usage-core/src/health.rs`)
// and arrive with the account; the functions below only decide how to show them.

/** Anything but live: the Action needed list and the card's highlight. */
export function accountNeedsAttention(account: Account): boolean {
  return account.health !== "live";
}
/** The provider stopped accepting this account's saved sign-in: only signing in again fixes it. */
export function accountSignedOut(account: Account): boolean {
  return account.health === "signed_out";
}

const STATUS_CHIPS: Record<AccountHealth, { label: string; className: string }> = {
  signed_out: { label: "SIGNED OUT", className: "danger" },
  out_of_date: { label: "OUT OF DATE", className: "warning" },
  refresh_failed: { label: "REFRESH FAILED", className: "warning" },
  key_only: { label: "KEY ONLY", className: "warning" },
  setup: { label: "SETUP", className: "warning" },
  inactive: { label: "INACTIVE", className: "neutral" },
  live: { label: "LIVE", className: "success" },
};

/**
 * The card's status chip. Each label says what is wrong: signed out (sign in again), out of date
 * (older usage is still shown) or a refresh that failed before any usage loaded.
 */
export function accountStatus(account: Account): { label: string; className: string } {
  return STATUS_CHIPS[account.health];
}
/** True when the window is of the given kind. The backend works the kind out once (`WindowKind` in `model.rs`). */
export function canonicalWindow(window: UsageWindow, target: SidebarWindow): boolean {
  return window.kind === target;
}
/** True when `resetsAt` parses to a valid timestamp that has already passed at `now`. */
export function isWindowExpired(resetsAt: string | null | undefined, now: number = Date.now()): boolean {
  if (!resetsAt) return false;
  const resetAt = new Date(resetsAt).getTime();
  return Number.isFinite(resetAt) && resetAt <= now;
}
/**
 * The first of `candidates` (indexes into the account's windows) that has not reset by `now`, and,
 * with `needsValue`, has a percent.
 */
function currentWindow(account: Account, candidates: number[], now: number, needsValue: boolean): UsageWindow | undefined {
  const windows = account.lastUsage?.windows ?? [];
  for (const index of candidates) {
    const window = windows[index];
    if (!window || isWindowExpired(window.resetsAt, now)) continue;
    if (needsValue && window.remainingPercent == null) continue;
    return window;
  }
  return undefined;
}

/**
 * The percent a sidebar meter shows for an account. The backend sends which windows each meter
 * can read, best first (`headline`, from `usage-core/src/headline.rs`): the 5-hour ones, and the
 * 7-day ones followed by the 30-day ones (so free ChatGPT shows its 30-day limit under the long
 * meter). Only the check against the clock happens here. An account without a 5-hour window (Grok,
 * free ChatGPT) shows a dash on that meter.
 */
export function accountWindowRemaining(
  account: Account,
  target: SidebarWindow,
  now: number = Date.now(),
): number | null {
  const { headline } = account;
  const window = target === "five_hour"
    ? currentWindow(account, headline.fiveHour, now, false)
    : currentWindow(account, headline.long, now, true);
  return window?.remainingPercent ?? null;
}
export function groupAverage(
  accounts: Account[],
  target: SidebarWindow,
  now: number = Date.now(),
): number | null {
  const values = accounts
    .map((account) => accountWindowRemaining(account, target, now))
    .filter((value): value is number => value != null && Number.isFinite(value));
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
/** True for a sidebar row whose accounts are all Grok: its first slot shows the Grok Bot limit. */
export function isGrokOnlyGroup(accounts: Account[]): boolean {
  return accounts.length > 0 && accounts.every((account) => account.provider === "grok");
}
/** Average percent remaining of the Grok Bot limit over the accounts that report one. */
export function grokBotAverage(accounts: Account[], now: number = Date.now()): number | null {
  const values = accounts.flatMap((account) => {
    const window = account.lastUsage?.windows.find((candidate) => candidate.id === GROK_BOT_WINDOW_ID);
    if (!window || isWindowExpired(window.resetsAt, now)) return [];
    const remaining = window.remainingPercent;
    return remaining != null && Number.isFinite(remaining) ? [remaining] : [];
  });
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Why a sidebar row flags its group: an account must sign in again, or its data is out of date. */
export type GroupAlertLevel = "sign-in" | "stale";

export interface GroupAlert {
  level: GroupAlertLevel;
  /** How many accounts in the group have this problem (the worse level wins). */
  count: number;
}

function accountAlertLevel(account: Account): GroupAlertLevel | null {
  if (account.health === "signed_out") return "sign-in";
  if (account.health === "out_of_date" || account.health === "refresh_failed") return "stale";
  return null;
}

/**
 * The problem a sidebar row should flag, or null. Signing in again outranks stale data; a key-only
 * or not-yet-set-up Google AI Studio account is a normal state and is not flagged.
 */
export function groupAlert(accounts: Account[]): GroupAlert | null {
  const levels = accounts.map(accountAlertLevel);
  const signIn = levels.filter((level) => level === "sign-in").length;
  if (signIn) return { level: "sign-in", count: signIn };
  const stale = levels.filter((level) => level === "stale").length;
  return stale ? { level: "stale", count: stale } : null;
}
/**
 * The label for the second meter in a sidebar group row, from what each account's long meter
 * measures (`headline.longWindow`, worked out by the backend).
 * - Grok-only groups show "7D Grok".
 * - Groups containing an account with a weekly window show "7d".
 * - Groups whose reported limit is monthly (such as ChatGPT Free) show "30d".
 * - When accounts have no usage yet, groups of free ChatGPT accounts default to "30d", all others to "7d".
 */
export function groupSecondMeterLabel(accounts: Account[]): string {
  if (isGrokOnlyGroup(accounts)) return "7D Grok";
  const long = accounts.map((account) => account.headline.longWindow);
  if (long.includes("weekly")) return "7d";
  if (long.includes("monthly")) return "30d";
  if (long.length > 0 && long.every((window) => window === "monthly_by_plan")) return "30d";
  return "7d";
}
export function nextResetSummary(accounts: Account[], now: number = Date.now()): NextResetSummary {
  const currentNow = Math.max(now, Date.now());
  const candidates = accounts.flatMap((account) =>
    (account.lastUsage?.windows ?? []).flatMap((window) => {
      if (!window.resetsAt) return [];
      const resetAt = new Date(window.resetsAt).getTime();
      if (!Number.isFinite(resetAt) || resetAt <= currentNow) return [];
      return [{
        resetAt,
        account: displayAccountLabel(account),
        provider: account.provider,
        window,
        limit: windowLimitName(window),
        resetsAt: window.resetsAt,
        windowSeconds: window.windowSeconds,
      }];
    }),
  );

  if (!candidates.length) {
    return { account: null, limit: null, value: "—", resetsAt: null, provider: null, window: null };
  }

  candidates.sort((left, right) => left.resetAt - right.resetAt);
  const next = candidates[0];
  let remainingMs = next.resetAt - currentNow;
  if (next.windowSeconds && remainingMs >= next.windowSeconds * 1000) {
    remainingMs = next.windowSeconds * 1000 - 1;
  }
  return {
    account: next.account,
    limit: next.limit,
    value: formatRemainingDuration(remainingMs) ?? "—",
    resetsAt: next.resetsAt,
    provider: next.provider,
    window: next.window,
  };
}
export function usageTone(remaining: number | null): string {
  if (remaining == null) return "neutral";
  if (remaining <= 15) return "critical";
  if (remaining <= 30) return "warning";
  return "healthy";
}
export function orderedWindows(windows: UsageWindow[]): UsageWindow[] {
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
/**
 * The windows in the order an account card shows them. Grok Bot comes before the
 * SuperGrok window here only; the backend still sends the SuperGrok window first, because
 * the sidebar and alerts take the first weekly window as the account's headline limit.
 */
export function cardWindows(windows: UsageWindow[], provider?: Provider | string): UsageWindow[] {
  const ordered = orderedWindows(windows);
  if (provider !== "grok") return ordered;
  return [...ordered.filter((w) => w.id === GROK_BOT_WINDOW_ID), ...ordered.filter((w) => w.id !== GROK_BOT_WINDOW_ID)];
}
export function windowLength(window: UsageWindow): string | null {
  if (window.windowSeconds) {
    const hours = Math.round(window.windowSeconds / 3600);
    if (hours >= 24 && hours % 24 === 0) return `${hours / 24}d limit`;
    return `${hours}h limit`;
  }
  return window.kind === "monthly" ? "30d limit" : null;
}

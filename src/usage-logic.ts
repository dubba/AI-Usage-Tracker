import { formatClockTime, formatMonthDay } from "./format";
import type { Account, Provider, UsageWindow } from "./types";

export type SidebarWindow = "five_hour" | "weekly";

export type NextResetSummary = {
  account: string | null;
  value: string;
  resetsAt: string | null;
};

const GOOGLE_AI_STUDIO_MODELS_ONLY_SOURCE = "google_ai_studio_model_access";

// Legacy accounts were auto-labelled with an older provider display name
// (e.g. "Google Antigravity"). Collapse only those obsolete branded defaults
// for the matching provider, including numbered copies ("Grok/Cursor 2").
const LEGACY_DEFAULT_LABELS: Partial<Record<Provider, string[]>> = {
  antigravity: ["Google Antigravity"],
  grok: ["Grok / SuperGrok", "Grok/Cursor"],
  openai: ["OpenAI Codex", "Codex/GPT", "GPT/Codex"],
  anthropic: ["Anthropic Claude"],
  google_ai_studio: ["Google AI Studio"],
};

export function providerName(provider: Provider): string {
  switch (provider) {
    case "openai": return "ChatGPT";
    case "anthropic": return "Claude";
    case "antigravity": return "Antigravity";
    case "google_ai_studio": return "AI Studio";
    case "grok": return "Grok";
    case "opencode_go": return "OpenCode Go";
    case "cursor": return "Cursor";
  }
}
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
export function formatResetAtShort(value: string | null | undefined, locale?: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return `${formatMonthDay(date, locale)} @ ${formatClockTime(date, locale)}`;
}
export function googleAiStudioHasQuotaWindows(account: Account): boolean {
  return account.provider === "google_ai_studio"
    && account.lastUsage?.source === "google_ai_studio_cloud_monitoring"
    && (account.lastUsage.windows ?? []).some((window) => window.remainingPercent != null);
}
export function accountNeedsAttention(account: Account): boolean {
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
export function accountStatus(account: Account): { label: string; className: string } {
  if (account.authRequired || account.lastUsage?.freshness === "auth_required") {
    return { label: "AUTH NEEDED", className: "danger" };
  }
  if (account.lastError || account.lastUsage?.freshness === "stale") {
    return { label: "ACTION NEEDED", className: "warning" };
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
export function canonicalWindow(window: UsageWindow, target: SidebarWindow): boolean {
  const id = window.id.toLowerCase().replaceAll("-", "_");
  const label = window.label.toLowerCase();
  if (target === "five_hour") {
    return id === "five_hour"
      || id.startsWith("five_hour")
      || id === "rolling"
      || window.windowSeconds === 18_000
      || label.includes("5 hour")
      || label.includes("five hour")
      || label.includes("5h")
      || label.includes("5-hour");
  }
  return id === "weekly"
    || id.startsWith("weekly")
    || window.windowSeconds === 604_800
    || label.includes("weekly")
    || label.includes("7 day")
    || label.includes("seven day")
    || label.includes("7d")
    || label.includes("7-day");
}
export function isMonthlyWindow(window: UsageWindow): boolean {
  const id = window.id.toLowerCase().replaceAll("-", "_");
  const label = window.label.toLowerCase();
  return (
    id.includes("monthly") ||
    id.includes("30d") ||
    id.includes("30_day") ||
    id.includes("thirty_day") ||
    (window.windowSeconds != null && window.windowSeconds >= 2_000_000 && window.windowSeconds <= 2_700_000) ||
    label.includes("monthly") ||
    label.includes("30d") ||
    label.includes("30-day") ||
    label.includes("30 day") ||
    label.includes("thirty day")
  );
}
export function accountWindowRemaining(account: Account, target: SidebarWindow): number | null {
  const windows = account.lastUsage?.windows ?? [];
  if (!windows.length) return null;

  // 1. If H (hourly / 5-hour) is selected, only return usage for providers that actually have an hourly rate.
  // Accounts without an hourly window (such as Grok with a 7d limit, or free GPT with a 30d limit) return null (dash "—").
  if (target === "five_hour") {
    const hourly = windows.find((candidate) => canonicalWindow(candidate, "five_hour"));
    return hourly?.remainingPercent ?? null;
  }

  // 2. If W (weekly) is selected:
  // First look for a 7-day / weekly window.
  const weekly = windows.find((candidate) => canonicalWindow(candidate, "weekly"));
  if (weekly?.remainingPercent != null) return weekly.remainingPercent;

  // For GPT or accounts with a monthly / 30-day limit, show the 30-day limit under W.
  const monthly = windows.find(isMonthlyWindow);
  if (monthly?.remainingPercent != null) return monthly.remainingPercent;

  return null;
}
export function groupAverage(accounts: Account[], target: SidebarWindow): number | null {
  const values = accounts
    .map((account) => accountWindowRemaining(account, target))
    .filter((value): value is number => value != null && Number.isFinite(value));
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
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
        resetsAt: window.resetsAt,
        windowSeconds: window.windowSeconds,
      }];
    }),
  );

  if (!candidates.length) {
    return { account: null, value: "—", resetsAt: null };
  }

  candidates.sort((left, right) => left.resetAt - right.resetAt);
  const next = candidates[0];
  let remainingMs = next.resetAt - currentNow;
  if (next.windowSeconds && remainingMs >= next.windowSeconds * 1000) {
    remainingMs = next.windowSeconds * 1000 - 1;
  }
  return {
    account: next.account,
    value: formatRemainingDuration(remainingMs) ?? "—",
    resetsAt: next.resetsAt,
  };
}
export function formatRemainingDuration(remainingMs: number): string | null {
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return null;
  const totalMinutes = Math.floor(remainingMs / 60_000);
  if (totalMinutes === 0) {
    const totalSeconds = Math.max(1, Math.floor(remainingMs / 1000));
    if (totalSeconds >= 45) return "45s";
    if (totalSeconds >= 30) return "30s";
    if (totalSeconds >= 15) return "15s";
    return "5s";
  }
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) {
    return hours === 0 ? `${days}d` : `${days}d ${hours}h`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
}
export function accountAutoRefreshEligible(account: Account): boolean {
  if (account.authRequired) return false;
  if (account.provider === "google_ai_studio" && account.lastUsage?.source === GOOGLE_AI_STUDIO_MODELS_ONLY_SOURCE) {
    return false;
  }
  return true;
}
export function accountsNeedScheduledRefresh(accounts: Account[], minutes: number, now = Date.now()): boolean {
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
/** "just now", "5m ago", "3h ago", "2d ago" for a duration that has passed. */
export function formatElapsed(elapsedMs: number): string {
  const minutes = Math.floor(Math.max(0, elapsedMs) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function formatUpdatedAt(value: string | null | undefined, now = Date.now()): string | null {
  if (!value) return null;
  const then = new Date(value).getTime();
  if (!Number.isFinite(then)) return null;
  return `Updated ${formatElapsed(now - then)}`;
}
export function usageTone(remaining: number | null): string {
  if (remaining == null) return "neutral";
  if (remaining <= 10) return "critical";
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
export function windowLength(window: UsageWindow): string | null {
  const id = window.id.toLowerCase().replaceAll("-", "_");
  const label = window.label.toLowerCase();
  if (window.windowSeconds) {
    const hours = Math.round(window.windowSeconds / 3600);
    if (hours >= 24 && hours % 24 === 0) return `${hours / 24}d limit`;
    return `${hours}h limit`;
  }
  if (id.includes("monthly") || label.includes("monthly") || id.includes("30d") || label.includes("30d")) {
    return "30d limit";
  }
  return null;
}
export function resetCountdownLabel(
  value: string | null | undefined,
  now: number = Date.now(),
  windowSeconds?: number | null,
): string | null {
  if (!value) return null;
  const resetAt = new Date(value).getTime();
  if (!Number.isFinite(resetAt)) return null;
  const currentNow = Math.max(now, Date.now());
  let remainingMs = resetAt - currentNow;
  if (windowSeconds && remainingMs >= windowSeconds * 1000) {
    remainingMs = windowSeconds * 1000 - 1;
  }
  const remaining = formatRemainingDuration(remainingMs);
  return remaining ? `Reset: ${remaining}` : null;
}

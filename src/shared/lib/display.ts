import type { Account, Provider, UsageWindow, WindowKind } from "../../types";
import { providerName } from "./providers";
import { displayAccountLabel } from "./usage-logic";
import { GROK_BOT_WINDOW_ID } from "./usage-sources";

export function displayProviderGroupTitle(provider: Provider, accounts: Account[]): string {
  const labels = accounts.map(displayAccountLabel).filter((label) => label.trim());
  if (labels.length === 0) return providerName(provider);
  const first = labels[0];
  if (labels.every((label) => label === first)) return first;
  return providerName(provider);
}

export function displayAccountSubtitle(account: Account): string {
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

export function cleanModelPrefix(prefix: string): string {
  return prefix
    .replace(/\bclaude\s+and\s+gpt\b/i, "Claude & GPT")
    .replace(/\s+models$/i, "")
    .replace(/\s+model$/i, "")
    .trim();
}

const GENERIC_WINDOW_LABELS = new Set([
  "weekly",
  "5 hour",
  "5-hour",
  "five hour",
  "five_hour",
  "monthly",
  "rolling",
  "session",
  "usage",
]);

const WINDOW_SUFFIXES = [" weekly", " 5 hour", " 5-hour", " five hour"];

/** "Sonnet weekly" -> "Sonnet"; null when the label has no window suffix (or nothing before it). */
function stripWindowSuffix(label: string): string | null {
  const lower = label.toLowerCase();
  const suffix = WINDOW_SUFFIXES.find((candidate) => lower.endsWith(candidate));
  if (!suffix) return null;
  return label.slice(0, -suffix.length).trim();
}

export function windowGroupPrefix(window: UsageWindow): string | null {
  const label = window.label.trim();
  const stripped = stripWindowSuffix(label);
  let prefix = "";
  if (label.includes(" · ")) {
    prefix = cleanModelPrefix(label.split(" · ")[0] ?? "");
  } else if (stripped !== null) {
    prefix = cleanModelPrefix(stripped);
  } else {
    const cleaned = cleanModelPrefix(label);
    if (GENERIC_WINDOW_LABELS.has(cleaned.toLowerCase())) {
      return null;
    }
    prefix = cleaned;
  }
  return prefix || null;
}

export function antigravityGroupLabel(window: UsageWindow): string | null {
  const prefix = windowGroupPrefix(window);
  if (!prefix) return null;
  if (/claude|gpt/i.test(prefix)) {
    return "Other";
  }
  // The quota names are "Gemini 4 Argon" and "Gemini 4 Carbon". The card only needs the model.
  if (/^gemini 4 argon$/i.test(prefix)) {
    return "Argon";
  }
  if (/^gemini 4 carbon$/i.test(prefix)) {
    return "Carbon";
  }
  return prefix;
}

/** The group a window falls into when its label names none, by provider. */
const DEFAULT_GROUP_BY_PROVIDER: Record<string, string> = {
  anthropic: "Claude",
  openai: "GPT",
  grok: "Grok",
  google_ai_studio: "Gemini",
  opencode_go: "OpenCode",
};

function providerDefaultGroup(window: UsageWindow, provider?: Provider | string): string | null {
  if (provider === "openai") {
    const codeReview = window.id.toLowerCase().includes("code_review") || window.label.toLowerCase().includes("code review");
    return codeReview ? "Code Review" : "GPT";
  }
  return (provider && DEFAULT_GROUP_BY_PROVIDER[provider]) || null;
}

export function metricGroupLabel(window: UsageWindow, provider?: Provider | string): string | null {
  if (provider === "antigravity") {
    return antigravityGroupLabel(window);
  }
  return windowGroupPrefix(window) ?? providerDefaultGroup(window, provider);
}

/**
 * The model named on the Next reset card between the limit and the account: Antigravity's "Gemini",
 * "Other" or "Argon", and "Bot" for the Grok Bot limit. Null for anything else, so a plain Grok limit
 * reads "7D Grok".
 */
export function nextResetModelLabel(provider: Provider | null, window: UsageWindow | null): string | null {
  if (!provider || !window) return null;
  if (provider === "antigravity") return antigravityGroupLabel(window);
  if (provider === "grok" && window.id === GROK_BOT_WINDOW_ID) return "Bot";
  if (provider === "anthropic" && (window.id === "seven_day_fable" || /fable/i.test(window.label) || /fable/i.test(window.id))) return "Fable";
  return null;
}

function windowDurationDescriptor(window: UsageWindow): string | null {
  const is5h =
    window.kind === "five_hour" ||
    window.id === "five_hour" ||
    /5[\s_-]*h(our)?/i.test(window.label) ||
    /5[\s_-]*h(our)?/i.test(window.id) ||
    Boolean(window.windowSeconds && Math.round(window.windowSeconds / 3600) === 5);
  if (is5h) {
    return "5H LIMIT";
  }

  const isWeekly =
    window.kind === "weekly" ||
    window.id === "weekly" ||
    window.id === "seven_day" ||
    /7[\s_-]*d(ay)?|weekly/i.test(window.label) ||
    /7[\s_-]*d(ay)?|weekly/i.test(window.id) ||
    Boolean(window.windowSeconds && Math.round(window.windowSeconds / 86400) === 7);
  if (isWeekly) {
    return "7D LIMIT";
  }

  const isMonthly =
    window.kind === "monthly" ||
    window.id === "monthly" ||
    /30[\s_-]*d(ay)?|monthly/i.test(window.label) ||
    /30[\s_-]*d(ay)?|monthly/i.test(window.id);
  if (isMonthly) {
    return "30D LIMIT";
  }

  const isSession =
    window.id === "session" ||
    /session/i.test(window.label) ||
    /session/i.test(window.id);
  if (isSession) {
    return "SESSION LIMIT";
  }

  if (window.windowSeconds) {
    const hours = Math.round(window.windowSeconds / 3600);
    if (hours >= 24 && hours % 24 === 0) {
      const days = hours / 24;
      return `${days}D LIMIT`;
    }
    return `${hours}H LIMIT`;
  }
  return null;
}

/**
 * Clean chip label for an account card usage metric (Option B).
 * Eliminates redundant provider repetitions while retaining distinguishing model group or window kind context.
 */
export function metricChipLabel(window: UsageWindow, provider?: Provider | string): string | null {
  const duration = windowDurationDescriptor(window);

  if (provider === "anthropic") {
    const isFable = window.id === "seven_day_fable" || /fable/i.test(window.label) || /fable/i.test(window.id);
    const subLabel = isFable ? "Fable" : "Claude";
    if (duration) return `${duration} · ${subLabel}`;
  }

  if (provider === "openai") {
    const isCodeReview =
      window.id === "code_review" ||
      /code\s*review/i.test(window.label) ||
      /code\s*review/i.test(window.id);
    if (isCodeReview) {
      return duration ? `${duration} · Code Review` : "Code Review";
    }
    if (duration) return `${duration} · ChatGPT`;
  }

  if (provider === "grok") {
    const isBot = window.id === GROK_BOT_WINDOW_ID || /grok\s*bot/i.test(window.label) || /grok\s*bot/i.test(window.id);
    const subLabel = isBot ? "Bot" : "Grok";
    return duration ? `${duration} · ${subLabel}` : subLabel;
  }

  const group = metricGroupLabel(window, provider);
  const defaultProviderGroup = provider ? DEFAULT_GROUP_BY_PROVIDER[provider] : null;
  const isGenericProviderBrand = group === "GPT" || group === "Claude" || (defaultProviderGroup !== null && group === defaultProviderGroup);
  const hasDistinctGroup = Boolean(group && !isGenericProviderBrand);

  if (duration && hasDistinctGroup && group) {
    return `${duration} · ${group}`;
  }
  if (duration) {
    return duration;
  }
  return (hasDistinctGroup ? group : null) ?? window.label ?? null;
}

const DURATION_SPAN: Record<string, string> = {
  "5H LIMIT": "5-hour",
  "7D LIMIT": "7-day",
  "30D LIMIT": "30-day",
  "SESSION LIMIT": "Session",
};

/**
 * The limit chip split in two for the desktop account card: the window length ("7-day") and what it
 * covers ("Grok"). Either may be missing, e.g. a window with no known length shows only its name.
 */
export function metricWindowParts(window: UsageWindow, provider?: Provider | string): { span: string | null; name: string | null } {
  const chip = metricChipLabel(window, provider);
  if (!chip) return { span: null, name: window.label || null };
  const [first, ...rest] = chip.split(" · ");
  const span = DURATION_SPAN[first] ?? null;
  if (!span) return { span: null, name: chip };
  return { span, name: rest.join(" · ") || null };
}

const WINDOW_PILL_CLASS: Record<WindowKind, string> = {
  five_hour: "window-pill-5h",
  weekly: "window-pill-7d",
  monthly: "window-pill-monthly",
};

export function windowPillClass(window: UsageWindow): string {
  return (window.kind && WINDOW_PILL_CLASS[window.kind]) || "window-pill-default";
}

/**
 * Sanitizes and formats account error messages for UI display.
 * Maps legacy or unformatted "authentication is required" to "Re-authentication required".
 */
export function displayAccountError(error: string | null | undefined): string | null {
  if (!error) return null;
  const trimmed = error.trim();
  if (/^authentication is required$/i.test(trimmed)) {
    return "Re-authentication required";
  }
  return error;
}


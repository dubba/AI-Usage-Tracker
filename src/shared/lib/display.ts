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
  // The quota name is "Gemini 4 Argon". The card only needs the model.
  if (/^gemini 4 argon$/i.test(prefix)) {
    return "Argon";
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
    if (duration) return `${duration} · Claude`;
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
    const subLabel = isBot ? "GrokBot" : "Grok";
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

const WINDOW_PILL_CLASS: Record<WindowKind, string> = {
  five_hour: "window-pill-5h",
  weekly: "window-pill-7d",
  monthly: "window-pill-monthly",
};

export function windowPillClass(window: UsageWindow): string {
  return (window.kind && WINDOW_PILL_CLASS[window.kind]) || "window-pill-default";
}

/** The plan as it was stored, in the spellings the rules below test. */
interface PlanText {
  /** Lower case, as stored. */
  lower: string;
  /** Without a trailing "-tier", original case. */
  withoutTier: string;
  /** Lower case, without a trailing "-tier". */
  stripped: string;
}

/** One line of a provider's plan table: the first rule that matches decides. */
type PlanRule = readonly [matches: (plan: PlanText) => boolean, plan: string | ((plan: PlanText) => string)];

/** True when the plan contains any of the words. */
const mentions = (...words: string[]) => (plan: PlanText) => words.some((word) => plan.lower.includes(word));
/** True when the whole plan is one of the spellings. */
const isOneOf = (...spellings: string[]) => (plan: PlanText) => spellings.includes(plan.lower);
const isFree = (plan: PlanText) => plan.stripped === "free" || plan.lower === "free" || plan.lower === "free-tier";
const ultraPlan = (plan: PlanText) => (mentions("200", "30tb", "genie")(plan) ? "Ultra/$200" : "Ultra/$100");
const upperOrFree = (plan: PlanText) => plan.withoutTier.toUpperCase() || "Free";

// Reference: user-provided plan table (Free | Budget $5-10 | Standard $20-30 | Mid $100 | Max $200-300)
// OpenCode: Free | Go $10 | Zen PAYG | Black Tier
// OpenAI: Free | Go $8 | Plus $20 | Pro $100 | Pro $200
// Anthropic: Free | Pro $20 | Max $100 | Max $200
// Google: Free | Plus $5 (4.99→5) | Pro $20 (19.99→20) | Ultra $100 | Ultra $200 - cents rounded to nearest dollar (AI prefix removed)
// xAI: Free | SuperGrok $30 | SuperGrok $100 | Heavy $300
// Cursor: Free $0 | Start ~$8-10 | Pro $20 | Pro+ $60 | Ultra $200
//
// The order of the rules is the behavior: a plan such as "ultra plus" takes the first rule it fits.
const PLAN_RULES: Record<string, readonly PlanRule[]> = {
  openai: [
    [mentions("free"), "Free"],
    [(plan) => plan.lower === "go" || plan.lower.includes("go/") || plan.stripped === "go", "Go/$8"],
    [mentions("plus"), "Plus/$20"],
    [mentions("pro"), (plan) => (mentions("100")(plan) ? "Pro/$100" : "Pro/$200")],
    [mentions("team"), "Team"],
  ],
  anthropic: [
    [mentions("free"), "Free"],
    [mentions("max"), (plan) => (mentions("200", "20x")(plan) ? "Max/$200" : "Max/$100")],
    [mentions("enterprise"), "Enterprise"],
    [mentions("team"), "Team"],
    [mentions("pro"), "Pro/$20"],
  ],
  antigravity: [
    [isOneOf("google antigravity", "antigravity"), "ANTIGRAVITY"],
    [isFree, "Free"],
    // G1-Pro/$20 removed as redundant
    [mentions("ultra"), ultraPlan],
    [mentions("plus"), "Plus/$5"],
    [mentions("pro"), "Pro/$20"],
  ],
  google_ai_studio: [
    [(plan) => plan.lower.includes("free") || plan.lower === "google ai studio", "Free"],
    [mentions("ultra"), ultraPlan],
    [mentions("plus"), "Plus/$5"],
    [mentions("pro"), "Pro/$20"],
  ],
  grok: [
    [mentions("free"), "Free"],
    [mentions("heavy"), "SuperGrok Heavy/$300"],
    [mentions("100", "plus"), "SuperGrok Plus/$100"],
  ],
  opencode_go: [
    [mentions("free"), "Free"],
    [mentions("go"), "Go/$10"],
    [mentions("zen"), "Zen/PAYG"],
    [mentions("black"), "Black Tier"],
  ],
};

/** What a provider's plan is shown as when none of its rules matches; null shows no plan. */
const PLAN_FALLBACK: Record<string, (plan: PlanText) => string | null> = {
  openai: upperOrFree,
  // Unrecognized values (legacy "Claude subscription", generic rate-limit tiers) say nothing
  // about the plan, so show none until the next refresh stores a real one.
  anthropic: () => null,
  antigravity: (plan) => {
    const cleaned = plan.withoutTier.replaceAll("_", " ").trim();
    // G1-Pro fallback also removed - treat as Pro
    if (cleaned.toLowerCase().startsWith("g1-")) return "Pro/$20";
    return cleaned.toUpperCase() || "Free";
  },
  google_ai_studio: upperOrFree,
  grok: () => "SuperGrok/$30",
  opencode_go: (plan) => plan.withoutTier.toUpperCase() || "Go/$10",
};

export function displayPlan(account: Account): string | null {
  const raw = account.plan?.trim();
  if (!raw) return null;
  const withoutTier = raw.replace(/-tier$/i, "").trim();
  const plan: PlanText = { lower: raw.toLowerCase(), withoutTier, stripped: withoutTier.toLowerCase() };

  const rules = PLAN_RULES[account.provider];
  if (rules) {
    const rule = rules.find(([matches]) => matches(plan));
    if (rule) return typeof rule[1] === "function" ? rule[1](plan) : rule[1];
    return PLAN_FALLBACK[account.provider](plan);
  }
  if (isFree(plan)) return "Free";
  return withoutTier.replaceAll("_", " ").toUpperCase() || raw.toUpperCase();
}

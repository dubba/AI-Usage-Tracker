import type { Account, Provider, UsageWindow } from "./types";
import { canonicalWindow, displayAccountLabel, isMonthlyWindow, providerName } from "./usage-logic";

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

export function formatAlertTime(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function cleanModelPrefix(prefix: string): string {
  return prefix
    .replace(/\bclaude\s+and\s+gpt\b/i, "Claude & GPT")
    .replace(/\s+models$/i, "")
    .replace(/\s+model$/i, "")
    .trim();
}

export function antigravityGroupLabel(window: UsageWindow): string | null {
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

export function displayMetricLabel(window: UsageWindow, provider?: Provider | string): string {
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

export function windowPillClass(window: UsageWindow): string {
  if (canonicalWindow(window, "five_hour")) return "window-pill-5h";
  if (canonicalWindow(window, "weekly")) return "window-pill-7d";
  if (isMonthlyWindow(window)) return "window-pill-monthly";
  return "window-pill-default";
}

export function displayPlan(account: Account): string | null {
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
      if (lower.includes("200") || lower.includes("20x")) return "Max/$200";
      return "Max/$100";
    }
    if (lower.includes("enterprise")) return "Enterprise";
    if (lower.includes("team")) return "Team";
    if (lower.includes("pro")) return "Pro/$20";
    // Unrecognized values (legacy "Claude subscription", generic rate-limit tiers) say nothing
    // about the plan, so show none until the next refresh stores a real one.
    return null;
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

import { describe, expect, it } from "vitest";
import {
  antigravityGroupLabel,
  cleanModelPrefix,
  displayAccountError,
  displayAccountSubtitle,
  metricChipLabel,
  metricGroupLabel,
  metricWindowParts,
  nextResetModelLabel,
  windowPillClass,
} from "./display";
import type { Account, UsageWindow } from "../../types";

function win(overrides: Partial<UsageWindow> = {}): UsageWindow {
  return { id: "x", label: "x", usedPercent: null, remainingPercent: null, resetsAt: null, windowSeconds: null, kind: null, ...overrides };
}

function account(overrides: Partial<Account> = {}): Account {
  return {
    id: "a",
    label: "Work",
    provider: "openai",
    email: null,
    providerAccountId: null,
    chatgptAccountId: null,
    plan: null,
    createdAt: "",
    updatedAt: "",
    lastUsage: null,
    lastError: null,
    authRequired: false,
    health: "inactive",
    googleSetup: null,
    autoRefresh: true,
    headline: { fiveHour: [], long: [], longWindow: null },
    planDisplay: null,
    ...overrides,
  };
}

describe("cleanModelPrefix", () => {
  it("normalizes Claude and GPT and strips 'models'", () => {
    expect(cleanModelPrefix("Claude and GPT models")).toBe("Claude & GPT");
    expect(cleanModelPrefix("Gemini models")).toBe("Gemini");
    expect(cleanModelPrefix("Sonnet model")).toBe("Sonnet");
  });
});

describe("antigravityGroupLabel", () => {
  it("reads the model group from 'Group · window' labels", () => {
    expect(antigravityGroupLabel(win({ label: "Gemini · 5h limit" }))).toBe("Gemini");
  });

  it("reads the model group from suffixed labels", () => {
    expect(antigravityGroupLabel(win({ label: "Gemini weekly" }))).toBe("Gemini");
    expect(antigravityGroupLabel(win({ label: "Gemini 5 hour" }))).toBe("Gemini");
    expect(antigravityGroupLabel(win({ label: "Gemini five hour" }))).toBe("Gemini");
  });

  it("collapses Claude/GPT groups to 'Other'", () => {
    expect(antigravityGroupLabel(win({ label: "Claude and GPT models · Weekly" }))).toBe("Other");
  });

  it("shortens Gemini 4 Argon and Gemini 4 Carbon to Argon and Carbon on the card", () => {
    expect(antigravityGroupLabel(win({ label: "Gemini 4 Argon · Weekly Limit" }))).toBe("Argon");
    expect(antigravityGroupLabel(win({ label: "Gemini 4 Carbon · Weekly Limit" }))).toBe("Carbon");
  });

  it("has no group for plain window labels", () => {
    for (const label of ["Weekly", "5 hour", "Monthly", "Usage"]) {
      expect(antigravityGroupLabel(win({ label }))).toBeNull();
    }
  });
});

describe("metricGroupLabel", () => {
  it("keeps Antigravity model groups, collapsing Claude/GPT to Other", () => {
    expect(metricGroupLabel(win({ label: "Gemini · 5h limit" }), "antigravity")).toBe("Gemini");
    expect(metricGroupLabel(win({ label: "Claude and GPT models · Weekly" }), "antigravity")).toBe("Other");
    expect(metricGroupLabel(win({ label: "Weekly" }), "antigravity")).toBeNull();
  });

  it("uses the model prefix when the window label has one", () => {
    expect(metricGroupLabel(win({ label: "GPT · Weekly Limit" }), "openai")).toBe("GPT");
    expect(metricGroupLabel(win({ label: "Code Review · Limit" }), "openai")).toBe("Code Review");
    expect(metricGroupLabel(win({ label: "Gemini 3.1 Flash Lite · Daily" }), "google_ai_studio")).toBe(
      "Gemini 3.1 Flash Lite",
    );
  });

  it("falls back to the provider model name for plain 5h/7d labels", () => {
    expect(metricGroupLabel(win({ label: "Weekly" }), "openai")).toBe("GPT");
    expect(metricGroupLabel(win({ label: "Weekly" }), "grok")).toBe("Grok");
    expect(metricGroupLabel(win({ label: "Grok Bot weekly" }), "grok")).toBe("Grok Bot");
    expect(metricGroupLabel(win({ label: "5 hour" }), "anthropic")).toBe("Claude");
    expect(metricGroupLabel(win({ label: "Weekly" }), "opencode_go")).toBe("OpenCode");
  });
});

describe("metricChipLabel", () => {
  it("formats Anthropic session and weekly windows as uppercase limit chips named for Claude", () => {
    expect(metricChipLabel(win({ kind: "five_hour", windowSeconds: 18_000, label: "5-Hour Window" }), "anthropic")).toBe("5H LIMIT · Claude");
    expect(metricChipLabel(win({ kind: "weekly", windowSeconds: 604_800, label: "Weekly" }), "anthropic")).toBe("7D LIMIT · Claude");
    expect(metricChipLabel(win({ kind: "weekly", windowSeconds: 604_800, id: "seven_day_fable", label: "Fable · Weekly" }), "anthropic")).toBe("7D LIMIT · Fable");
    expect(metricChipLabel(win({ kind: "monthly", label: "Monthly" }), "anthropic")).toBe("30D LIMIT · Claude");
  });

  it("formats Grok windows distinguishing Bot from general Grok pool", () => {
    expect(metricChipLabel(win({ id: "grok_bot", label: "Grok Bot weekly", windowSeconds: 604_800 }), "grok")).toBe("7D LIMIT · Bot");
    expect(metricChipLabel(win({ id: "grok_weekly", label: "Weekly", windowSeconds: 604_800 }), "grok")).toBe("7D LIMIT · Grok");
  });

  it("formats OpenCode Go weekly window without repeating provider name", () => {
    expect(metricChipLabel(win({ kind: "weekly", windowSeconds: 604_800, label: "Weekly" }), "opencode_go")).toBe("7D LIMIT");
  });

  it("formats OpenAI windows naming ChatGPT and distinguishing Code Review", () => {
    expect(metricChipLabel(win({ id: "code_review", label: "Code Review · Limit", windowSeconds: 604_800 }), "openai")).toBe("7D LIMIT · Code Review");
    expect(metricChipLabel(win({ id: "monthly", label: "GPT · 30-Day Limit", windowSeconds: 2_592_000 }), "openai")).toBe("30D LIMIT · ChatGPT");
    expect(metricChipLabel(win({ id: "gpt_weekly", label: "GPT · Weekly Limit", windowSeconds: 604_800 }), "openai")).toBe("7D LIMIT · ChatGPT");
    expect(metricChipLabel(win({ id: "session", label: "GPT · Session Limit", windowSeconds: 18_000 }), "openai")).toBe("5H LIMIT · ChatGPT");
  });

  it("formats Antigravity windows with their model groups", () => {
    expect(metricChipLabel(win({ label: "Gemini · 5h limit", windowSeconds: 18_000 }), "antigravity")).toBe("5H LIMIT · Gemini");
    expect(metricChipLabel(win({ label: "Claude and GPT models · Weekly", windowSeconds: 604_800 }), "antigravity")).toBe("7D LIMIT · Other");
    expect(metricChipLabel(win({ label: "Gemini 4 Argon · Weekly Limit", windowSeconds: 604_800 }), "antigravity")).toBe("7D LIMIT · Argon");
    expect(metricChipLabel(win({ label: "Gemini 4 Carbon · Weekly Limit", windowSeconds: 604_800 }), "antigravity")).toBe("7D LIMIT · Carbon");
  });
});

describe("metricWindowParts", () => {
  it("splits the limit chip into the window length and what it covers", () => {
    expect(metricWindowParts(win({ id: "weekly", label: "Grok 7d", kind: "weekly" }), "grok")).toEqual({ span: "7-day", name: "Grok" });
    expect(metricWindowParts(win({ id: "grok_bot", label: "Grok Bot weekly", windowSeconds: 604_800 }), "grok")).toEqual({ span: "7-day", name: "Bot" });
    expect(metricWindowParts(win({ id: "five_hour", label: "5h", kind: "five_hour" }), "anthropic")).toEqual({ span: "5-hour", name: "Claude" });
    expect(metricWindowParts(win({ id: "seven_day_fable", label: "Fable · Weekly", kind: "weekly", windowSeconds: 604_800 }), "anthropic")).toEqual({ span: "7-day", name: "Fable" });
    expect(metricWindowParts(win({ id: "monthly", label: "30d", kind: "monthly" }), "openai")).toEqual({ span: "30-day", name: "ChatGPT" });
  });

  it("keeps a chip with no known length whole, as the name", () => {
    expect(metricWindowParts(win({ id: "code_review", label: "Code Review" }), "openai")).toEqual({ span: null, name: "Code Review" });
  });

  it("gives a length alone when the chip names nothing else", () => {
    expect(metricWindowParts(win({ id: "weekly", label: "Weekly", kind: "weekly" }), "zai")).toEqual({ span: "7-day", name: null });
  });
});

describe("windowPillClass", () => {
  it("classifies by window kind", () => {
    expect(windowPillClass(win({ kind: "five_hour" }))).toBe("window-pill-5h");
    expect(windowPillClass(win({ kind: "weekly" }))).toBe("window-pill-7d");
    expect(windowPillClass(win({ kind: "monthly" }))).toBe("window-pill-monthly");
    expect(windowPillClass(win({ id: "five_hour", kind: null }))).toBe("window-pill-default");
  });
});

describe("displayAccountSubtitle", () => {
  it("prefers the trimmed email", () => {
    expect(displayAccountSubtitle(account({ email: "  me@example.com " }))).toBe("me@example.com");
  });

  it("falls back to 'Connected account' for default labels, else the provider name", () => {
    expect(displayAccountSubtitle(account({ label: "ChatGPT" }))).toBe("Connected account");
    expect(displayAccountSubtitle(account({ label: "Work" }))).toBe("ChatGPT");
  });
});

describe("nextResetModelLabel", () => {
  it("names the Antigravity model after the limit", () => {
    expect(nextResetModelLabel("antigravity", win({ label: "Gemini · 5 hour" }))).toBe("Gemini");
    expect(nextResetModelLabel("antigravity", win({ label: "Claude and GPT models · Weekly" }))).toBe("Other");
    expect(nextResetModelLabel("antigravity", win({ label: "Gemini 4 Argon · Weekly Limit" }))).toBe("Argon");
    expect(nextResetModelLabel("antigravity", win({ label: "Gemini 4 Carbon · Weekly Limit" }))).toBe("Carbon");
  });

  it("names the Grok Bot limit, but not the plain Grok limit", () => {
    expect(nextResetModelLabel("grok", win({ id: "grok_bot", label: "Grok Bot weekly" }))).toBe("Bot");
    expect(nextResetModelLabel("grok", win({ id: "weekly", label: "Weekly" }))).toBeNull();
  });

  it("names the Anthropic Fable limit, but not the plain Claude limit", () => {
    expect(nextResetModelLabel("anthropic", win({ id: "seven_day_fable", label: "Fable · Weekly" }))).toBe("Fable");
    expect(nextResetModelLabel("anthropic", win({ id: "weekly", label: "Weekly" }))).toBeNull();
  });

  it("adds nothing for other providers or when nothing resets", () => {
    expect(nextResetModelLabel("anthropic", win({ label: "Sonnet weekly" }))).toBeNull();
    expect(nextResetModelLabel(null, null)).toBeNull();
  });
});

describe("displayAccountError", () => {
  it("formats 'authentication is required' to 'Re-authentication required'", () => {
    expect(displayAccountError("authentication is required")).toBe("Re-authentication required");
    expect(displayAccountError("  authentication is required  ")).toBe("Re-authentication required");
    expect(displayAccountError("Authentication Is Required")).toBe("Re-authentication required");
  });

  it("preserves 'Re-authentication required' and other provider errors as-is", () => {
    expect(displayAccountError("Re-authentication required")).toBe("Re-authentication required");
    expect(displayAccountError("Rate limit exceeded. Try again later.")).toBe("Rate limit exceeded. Try again later.");
    expect(displayAccountError("Server temporarily unavailable.")).toBe("Server temporarily unavailable.");
  });

  it("returns null for null, undefined, or empty values", () => {
    expect(displayAccountError(null)).toBeNull();
    expect(displayAccountError(undefined)).toBeNull();
    expect(displayAccountError("")).toBeNull();
  });
});

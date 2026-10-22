import { describe, expect, it } from "vitest";
import {
  antigravityGroupLabel,
  cleanModelPrefix,
  displayAccountSubtitle,
  displayPlan,
  metricChipLabel,
  metricGroupLabel,
  windowPillClass,
} from "./display";
import type { Account, Provider, UsageWindow } from "../../types";

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

  it("keeps Gemini 4 Argon as its own group", () => {
    expect(antigravityGroupLabel(win({ label: "Gemini 4 Argon · Weekly Limit" }))).toBe("Gemini 4 Argon");
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
    expect(metricChipLabel(win({ kind: "monthly", label: "Monthly" }), "anthropic")).toBe("30D LIMIT · Claude");
  });

  it("formats Grok windows distinguishing GrokBot from general Grok pool", () => {
    expect(metricChipLabel(win({ id: "grok_bot", label: "Grok Bot weekly", windowSeconds: 604_800 }), "grok")).toBe("7D LIMIT · GrokBot");
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

describe("displayPlan", () => {
  const plan = (provider: Provider, value: string | null) => displayPlan(account({ provider, plan: value }));
  // A provider this build does not know, as an account from a newer version would have.
  const displayAccountPlan = (value: string) => displayPlan(account({ provider: "newcomer" as Provider, plan: value }));

  it("does not label Anthropic accounts Free when the stored plan is unrecognized", () => {
    expect(plan("anthropic", "default_claude_ai")).toBeNull();
    expect(plan("anthropic", "Claude subscription")).toBeNull();
  });

  it("returns null without a plan", () => {
    expect(plan("openai", null)).toBeNull();
    expect(plan("openai", "  ")).toBeNull();
  });

  // Every rule of every provider, and what falls through. The order of the rules matters
  // ("go" before "zen" for OpenCode, "free" before everything), so the cases include plans that
  // match two rules.
  it.each([
    ["openai", "Free", "Free"],
    ["openai", "free-tier", "Free"],
    ["openai", "go", "Go/$8"],
    ["openai", "GO", "Go/$8"],
    ["openai", "chatgpt-go/8", "Go/$8"],
    ["openai", "go-tier", "Go/$8"],
    ["openai", "plus", "Plus/$20"],
    ["openai", "pro", "Pro/$200"],
    ["openai", "pro-100", "Pro/$100"],
    ["openai", "pro/$100", "Pro/$100"],
    ["openai", "pro-200", "Pro/$200"],
    ["openai", "pro-enterprise", "Pro/$200"],
    ["openai", "team", "Team"],
    ["openai", "plus team", "Plus/$20"],
    ["openai", "prolite", "Pro/$200"],
    ["openai", "business", "BUSINESS"],
    ["openai", "free_trial-tier", "Free"],
    ["anthropic", "free", "Free"],
    ["anthropic", "claude_max_200", "Max/$200"],
    ["anthropic", "claude_max_5x", "Max/$100"],
    ["anthropic", "claude_max_20x", "Max/$200"],
    ["anthropic", "max", "Max/$100"],
    ["anthropic", "enterprise", "Enterprise"],
    ["anthropic", "claude_team", "Team"],
    ["anthropic", "claude_pro", "Pro/$20"],
    ["anthropic", "max pro", "Max/$100"],
    ["anthropic", "team pro", "Team"],
    ["anthropic", "enterprise team", "Enterprise"],
    ["anthropic", "default_claude_ai", null],
    ["antigravity", "Google Antigravity", "ANTIGRAVITY"],
    ["antigravity", "antigravity", "ANTIGRAVITY"],
    ["antigravity", "free", "Free"],
    ["antigravity", "Free-Tier", "Free"],
    ["antigravity", "g1-ultra", "Ultra/$100"],
    ["antigravity", "ultra-genie", "Ultra/$200"],
    ["antigravity", "ultra 30tb", "Ultra/$200"],
    ["antigravity", "ultra-200", "Ultra/$200"],
    ["antigravity", "plus", "Plus/$5"],
    ["antigravity", "pro", "Pro/$20"],
    ["antigravity", "ultra plus", "Ultra/$100"],
    ["antigravity", "plus pro", "Plus/$5"],
    ["antigravity", "g1-standard", "Pro/$20"],
    ["antigravity", "G1-Standard-tier", "Pro/$20"],
    ["antigravity", "some_new_plan", "SOME NEW PLAN"],
    ["google_ai_studio", "Google AI Studio", "Free"],
    ["google_ai_studio", "free-tier", "Free"],
    ["google_ai_studio", "ultra", "Ultra/$100"],
    ["google_ai_studio", "ultra-200", "Ultra/$200"],
    ["google_ai_studio", "plus", "Plus/$5"],
    ["google_ai_studio", "pro", "Pro/$20"],
    ["google_ai_studio", "paid-tier", "PAID"],
    ["google_ai_studio", "free ultra", "Free"],
    ["grok", "free", "Free"],
    ["grok", "SuperGrok Heavy", "SuperGrok Heavy/$300"],
    ["grok", "supergrok-100", "SuperGrok Plus/$100"],
    ["grok", "SuperGrok Plus", "SuperGrok Plus/$100"],
    ["grok", "supergrok", "SuperGrok/$30"],
    ["grok", "anything else", "SuperGrok/$30"],
    ["grok", "heavy plus", "SuperGrok Heavy/$300"],
    ["opencode_go", "free", "Free"],
    ["opencode_go", "go", "Go/$10"],
    ["opencode_go", "zen", "Zen/PAYG"],
    ["opencode_go", "zen-go", "Go/$10"],
    ["opencode_go", "black", "Black Tier"],
    ["opencode_go", "Black Tier", "Black Tier"],
    ["opencode_go", "enterprise", "ENTERPRISE"],
  ] as const)("maps %s %s to %s", (provider, value, expected) => {
    expect(plan(provider, value)).toBe(expected);
  });

  it("shows an unknown provider's plan in capitals without underscores, and Free as Free", () => {
    const unknown = (value: string) => displayAccountPlan(value);
    expect(unknown("free")).toBe("Free");
    expect(unknown("free-tier")).toBe("Free");
    expect(unknown("some_plan-tier")).toBe("SOME PLAN");
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

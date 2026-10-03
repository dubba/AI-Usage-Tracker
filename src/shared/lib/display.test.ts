import { describe, expect, it } from "vitest";
import {
  antigravityGroupLabel,
  cleanModelPrefix,
  displayAccountSubtitle,
  displayMetricLabel,
  displayPlan,
  metricGroupLabel,
  windowPillClass,
} from "./display";
import type { Account, Provider, UsageWindow } from "../../types";

function win(overrides: Partial<UsageWindow> = {}): UsageWindow {
  return { id: "x", label: "x", usedPercent: null, remainingPercent: null, resetsAt: null, windowSeconds: null, ...overrides };
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
    expect(metricGroupLabel(win({ label: "5 hour" }), "anthropic")).toBe("Claude");
    expect(metricGroupLabel(win({ label: "Weekly" }), "opencode_go")).toBe("OpenCode");
  });
});

describe("displayMetricLabel", () => {
  it("labels model-grouped windows", () => {
    expect(displayMetricLabel(win({ label: "Gemini · 5 hour" }))).toBe("Gemini · Remaining Limit");
    expect(displayMetricLabel(win({ label: "Gemini · Other thing" }))).toBe("Gemini · Other thing");
    expect(displayMetricLabel(win({ label: "Sonnet weekly" }))).toBe("Sonnet · Remaining Limit");
  });

  it("uses provider-specific defaults for plain labels", () => {
    expect(displayMetricLabel(win({ label: "Weekly" }), "openai")).toBe("GPT · Remaining Limit");
    expect(displayMetricLabel(win({ label: "Weekly" }), "grok")).toBe("Grok · Remaining Limit");
    expect(displayMetricLabel(win({ label: "Weekly" }), "anthropic")).toBe("Remaining Limit");
  });

  it("recognizes OpenAI code review windows", () => {
    expect(displayMetricLabel(win({ id: "code_review", label: "Code review" }), "openai")).toBe(
      "Code Review · Remaining Limit",
    );
  });
});

describe("windowPillClass", () => {
  it("classifies by window kind", () => {
    expect(windowPillClass(win({ id: "five_hour" }))).toBe("window-pill-5h");
    expect(windowPillClass(win({ id: "weekly" }))).toBe("window-pill-7d");
    expect(windowPillClass(win({ id: "monthly" }))).toBe("window-pill-monthly");
    expect(windowPillClass(win({ id: "custom", label: "custom" }))).toBe("window-pill-default");
  });
});

describe("displayPlan", () => {
  const plan = (provider: Provider, value: string | null) => displayPlan(account({ provider, plan: value }));

  it("does not label Anthropic accounts Free when the stored plan is unrecognized", () => {
    expect(plan("anthropic", "default_claude_ai")).toBeNull();
    expect(plan("anthropic", "Claude subscription")).toBeNull();
  });

  it("returns null without a plan", () => {
    expect(plan("openai", null)).toBeNull();
    expect(plan("openai", "  ")).toBeNull();
  });

  it.each([
    ["openai", "plus", "Plus/$20"],
    ["openai", "pro-100", "Pro/$100"],
    ["openai", "go", "Go/$8"],
    ["anthropic", "claude_max_200", "Max/$200"],
    ["anthropic", "Claude Pro", "Pro/$20"],
    ["anthropic", "claude_pro", "Pro/$20"],
    ["anthropic", "claude_max_5x", "Max/$100"],
    ["anthropic", "claude_max_20x", "Max/$200"],
    ["anthropic", "claude_team", "Team"],
    ["anthropic", "free", "Free"],
    ["antigravity", "g1-ultra", "Ultra/$100"],
    ["google_ai_studio", "free-tier", "Free"],
    ["grok", "SuperGrok Heavy", "SuperGrok Heavy/$300"],
    ["opencode_go", "zen", "Zen/PAYG"],
  ] as const)("maps %s %s to %s", (provider, value, expected) => {
    expect(plan(provider, value)).toBe(expected);
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

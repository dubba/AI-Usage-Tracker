import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  addOpenCodeGoAccount: vi.fn(),
  addGrokAccount: vi.fn(),
  addGoogleAiStudioAccount: vi.fn(),
}));
vi.mock("../../shared/lib/api", () => ({ bridgeApi: api }));

import type { Provider } from "../../types";
import { PROVIDER_META } from "../../shared/lib/providers";
import {
  defaultAccountName,
  emptyDraft,
  isAutoAccountName,
  strategyFor,
  validEmail,
  type AddAccountDraft,
} from "./strategies";

const draft = (provider: Provider, patch: Partial<AddAccountDraft> = {}): AddAccountDraft => ({
  ...emptyDraft(provider),
  ...patch,
});
const PROVIDERS = Object.keys(PROVIDER_META) as Provider[];

beforeEach(() => vi.clearAllMocks());

describe("drafts", () => {
  it("starts empty with the provider's default name", () => {
    expect(emptyDraft("anthropic")).toMatchObject({ label: "Claude", provider: "anthropic", email: "", advancedManual: false });
    expect(emptyDraft("openai", "Mine").label).toBe("Mine");
  });

  it("treats blank and generated names as automatic, but not a custom one", () => {
    expect(isAutoAccountName("", "openai")).toBe(true);
    expect(isAutoAccountName("  ChatGPT ", "openai")).toBe(true);
    expect(isAutoAccountName("OpenAI ChatGPT", "openai")).toBe(true);
    expect(isAutoAccountName("Work", "openai")).toBe(false);
    expect(isAutoAccountName("ChatGPT", "anthropic")).toBe(false);
  });

  it("accepts plain email addresses only", () => {
    expect(validEmail(" me@example.com ")).toBe(true);
    for (const bad of ["", "me", "me@", "@example.com", "me@example", "a b@example.com"]) expect(validEmail(bad)).toBe(false);
  });
});

describe("every provider", () => {
  it.each(PROVIDERS)("%s has a strategy with a non-empty description and button label", (provider) => {
    const strategy = strategyFor(provider);
    expect(strategy.description({ isAndroid: false })).not.toBe("");
    expect(strategy.description({ isAndroid: true })).not.toBe("");
    expect(strategy.actionLabel(emptyDraft(provider), false)).not.toBe("");
    expect(strategy.actionLabel(emptyDraft(provider), true)).not.toBe("");
  });
});

describe("browser sign-in providers", () => {
  it.each(["openai", "anthropic", "antigravity"] as const)("%s signs in through the browser", (provider) => {
    const strategy = strategyFor(provider);
    expect(strategy.connectMode(draft(provider))).toBe("sign-in");
    expect(strategy.validate(draft(provider))).toBeNull();
    expect(strategy.isReady(draft(provider))).toBe(true);
    expect(strategy.opensBrowser).toBe(true);
    expect(strategy.signInStartMessage).toBeNull();
    expect(strategy.signInEmail(draft(provider, { email: "x@y.z" }))).toBeUndefined();
    expect(strategy.waitingText("anything")).toBe("Waiting for the browser callback…");
    expect(strategy.actionLabel(draft(provider), false)).toBe(`Open ${defaultAccountName(provider)} Login`);
    expect(strategy.actionLabel(draft(provider), true)).toBe("Connecting…");
  });

  it("names the provider in the reconnect copy, differently on Android", () => {
    const strategy = strategyFor("anthropic");
    expect(strategy.description({ isAndroid: false })).toContain("Finish the Anthropic Claude login in your browser.");
    expect(strategy.description({ isAndroid: true })).toContain("Your browser opens the Anthropic Claude sign-in page.");
  });
});

describe("Grok", () => {
  const strategy = strategyFor("grok");

  it("signs in through its private window unless connecting manually", () => {
    expect(strategy.connectMode(draft("grok"))).toBe("sign-in");
    expect(strategy.connectMode(draft("grok", { advancedManual: true }))).toBe("manual");
    expect(strategy.opensBrowser).toBe(false);
    expect(strategy.signInStartMessage).toBe("Sign in to Grok in the private window.");
  });

  it("needs a cookie only in manual mode", () => {
    expect(strategy.validate(draft("grok"))).toBeNull();
    expect(strategy.isReady(draft("grok"))).toBe(true);
    expect(strategy.validate(draft("grok", { advancedManual: true, grokCookie: "  " }))).toBe(
      "Grok session cookies are required for manual connection.",
    );
    expect(strategy.isReady(draft("grok", { advancedManual: true, grokCookie: " " }))).toBe(false);
    expect(strategy.isReady(draft("grok", { advancedManual: true, grokCookie: "sso=1" }))).toBe(true);
  });

  it("prefers the backend's waiting message", () => {
    expect(strategy.waitingText("Almost there")).toBe("Almost there");
    expect(strategy.waitingText(null)).toBe("Waiting for the Grok login…");
  });

  it("labels the button for each phase", () => {
    expect(strategy.actionLabel(draft("grok"), false)).toBe("Open Grok Login");
    expect(strategy.actionLabel(draft("grok"), true)).toBe("Waiting for Grok…");
    expect(strategy.actionLabel(draft("grok", { advancedManual: true }), false)).toBe("Connect Manually");
    expect(strategy.actionLabel(draft("grok", { advancedManual: true }), true)).toBe("Adding Account…");
  });

  it("sends the trimmed cookie when connecting manually", async () => {
    api.addGrokAccount.mockResolvedValue({ id: "g" });
    await strategy.connectDirect!(draft("grok", { grokCookie: " sso=1 " }), "My Grok");
    expect(api.addGrokAccount).toHaveBeenCalledWith("My Grok", "sso=1", undefined);
  });
});

describe("OpenCode Go", () => {
  const strategy = strategyFor("opencode_go");

  it("always needs a valid email, even for manual connection", () => {
    const message = "A valid email address is required for OpenCode Go accounts.";
    expect(strategy.validate(draft("opencode_go"))).toBe(message);
    expect(strategy.validate(draft("opencode_go", { email: "nope" }))).toBe(message);
    expect(strategy.validate(draft("opencode_go", { email: "me@example.com" }))).toBeNull();
    expect(strategy.validate(draft("opencode_go", { email: "nope", advancedManual: true }))).toBe(message);
  });

  it("is ready as soon as an email is typed, valid or not", () => {
    expect(strategy.isReady(draft("opencode_go"))).toBe(false);
    expect(strategy.isReady(draft("opencode_go", { email: "x" }))).toBe(true);
  });

  it("passes the trimmed email to sign-in and nothing for a blank one", () => {
    expect(strategy.signInEmail(draft("opencode_go", { email: " me@example.com " }))).toBe("me@example.com");
    expect(strategy.signInEmail(draft("opencode_go", { email: " " }))).toBeUndefined();
  });

  it("does not open the system browser", () => {
    expect(strategy.opensBrowser).toBe(false);
    expect(strategy.signInStartMessage).toBe("Sign in to OpenCode and select Go from the sidebar.");
    expect(strategy.waitingText(null)).toBe("Waiting for the OpenCode Go page…");
  });

  it("sends trimmed workspace, cookie, and email when connecting manually", async () => {
    api.addOpenCodeGoAccount.mockResolvedValue({ id: "o" });
    await strategy.connectDirect!(
      draft("opencode_go", { workspaceId: " ws ", authCookie: " c ", email: " me@example.com " }),
      "Go",
    );
    expect(api.addOpenCodeGoAccount).toHaveBeenCalledWith("Go", "ws", "c", "me@example.com", undefined);
  });

  it("labels the button for each phase", () => {
    expect(strategy.actionLabel(draft("opencode_go"), false)).toBe("Open OpenCode Login");
    expect(strategy.actionLabel(draft("opencode_go", { advancedManual: true }), false)).toBe("Connect Manually");
    expect(strategy.actionLabel(draft("opencode_go"), true)).toBe("Waiting for OpenCode…");
    expect(strategy.actionLabel(draft("opencode_go", { advancedManual: true }), true)).toBe("Waiting for OpenCode…");
  });
});

describe("Google AI Studio", () => {
  const strategy = strategyFor("google_ai_studio");
  const models = [{ name: "m1", label: "M1" }];

  it("connects with an API key and never signs in", () => {
    expect(strategy.connectMode(draft("google_ai_studio"))).toBe("api-key");
  });

  it("reports the first missing step", () => {
    expect(strategy.validate(draft("google_ai_studio"))).toBe("A Google AI Studio API key is required.");
    expect(strategy.validate(draft("google_ai_studio", { apiKey: "k" }))).toBe(
      "Load the models from Google before adding this account.",
    );
    expect(strategy.validate(draft("google_ai_studio", { apiKey: "k", availableModels: models }))).toBe(
      "Select at least one Google model to track.",
    );
    expect(
      strategy.validate(draft("google_ai_studio", { apiKey: "k", availableModels: models, selectedModels: ["m1"] })),
    ).toBeNull();
  });

  it("is ready only with a key, loaded models, and a selection", () => {
    expect(strategy.isReady(draft("google_ai_studio", { apiKey: "k", availableModels: models }))).toBe(false);
    expect(
      strategy.isReady(draft("google_ai_studio", { apiKey: " k ", availableModels: models, selectedModels: ["m1"] })),
    ).toBe(true);
  });

  it("sends the trimmed key and the selected models", async () => {
    api.addGoogleAiStudioAccount.mockResolvedValue({ id: "a" });
    await strategy.connectDirect!(draft("google_ai_studio", { apiKey: " k ", selectedModels: ["m1"] }), "Studio");
    expect(api.addGoogleAiStudioAccount).toHaveBeenCalledWith("Studio", "k", ["m1"]);
  });

  it("labels the button", () => {
    expect(strategy.actionLabel(draft("google_ai_studio"), false)).toBe("Add Selected Models");
    expect(strategy.actionLabel(draft("google_ai_studio"), true)).toBe("Adding Account…");
  });
});

import { describe, expect, it } from "vitest";
import { DEFAULT_PROVIDER_ORDER, PROVIDER_META, providerName } from "./providers";

describe("provider registry", () => {
  it("orders exactly the providers it describes, once each", () => {
    expect([...DEFAULT_PROVIDER_ORDER].sort()).toEqual(Object.keys(PROVIDER_META).sort());
  });

  it("gives every provider a non-empty name, picker label, and description", () => {
    for (const meta of Object.values(PROVIDER_META)) {
      expect(meta.name).not.toBe("");
      expect(meta.connectLabel).not.toBe("");
      expect(meta.connectDetail).not.toBe("");
    }
  });

  it("keeps the names users already see", () => {
    expect(providerName("openai")).toBe("ChatGPT");
    expect(providerName("google_ai_studio")).toBe("AI Studio");
    expect(providerName("opencode_go")).toBe("OpenCode Go");
  });

  it("describes each provider in the Add Account menu", () => {
    expect(PROVIDER_META.openai.connectDetail).toBe("Link Go, Plus or Pro plans using Browser OAuth");
    expect(PROVIDER_META.anthropic.connectDetail).toBe("Link Pro or Max plans using Browser OAuth");
    expect(PROVIDER_META.antigravity.connectLabel).toBe("Google Antigravity (Gemini)");
    expect(PROVIDER_META.antigravity.connectDetail).toBe("Link Plus, Pro or Ultra plans using Browser OAuth");
    expect(PROVIDER_META.grok.connectDetail).toBe("Link SuperGrok, Plus or Heavy plans using Grok.com login");
    expect(PROVIDER_META.google_ai_studio.connectLabel).toBe("Google AI Studio (Gemini)");
    expect(PROVIDER_META.google_ai_studio.connectDetail).toBe("Link models using API key validation");
    expect(PROVIDER_META.opencode_go.connectDetail).toBe("Link Go plan using OpenCode.ai login");
  });
});

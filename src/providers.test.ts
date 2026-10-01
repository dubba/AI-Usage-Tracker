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
});

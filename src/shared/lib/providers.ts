import type { Provider } from "../../types";

export interface ProviderMeta {
  /** Short name used for default account labels, sidebar groups, and buckets. */
  name: string;
  /** Longer name shown in the Add Account provider picker and sign-in copy. */
  connectLabel: string;
  /** One-line description shown under the provider in the Add Account picker. */
  connectDetail: string;
}

/**
 * Single source of truth for provider display names. Typed as a Record so adding a
 * provider to `Provider` fails to compile until it is described here.
 */
export const PROVIDER_META: Record<Provider, ProviderMeta> = {
  openai: {
    name: "ChatGPT",
    connectLabel: "OpenAI ChatGPT",
    connectDetail: "Link Go, Plus or Pro plans using Browser OAuth",
  },
  anthropic: {
    name: "Claude",
    connectLabel: "Anthropic Claude",
    connectDetail: "Link Pro or Max plans using Browser OAuth",
  },
  antigravity: {
    name: "Antigravity",
    connectLabel: "Google Antigravity (Gemini)",
    connectDetail: "Link Plus, Pro or Ultra plans using Browser OAuth",
  },
  grok: {
    name: "Grok",
    connectLabel: "xAI Grok",
    connectDetail: "Link SuperGrok, Plus or Heavy plans using Grok.com login",
  },
  google_ai_studio: {
    name: "AI Studio",
    connectLabel: "Google AI Studio (Gemini)",
    connectDetail: "Link models using API key validation",
  },
  opencode_go: {
    name: "OpenCode Go",
    connectLabel: "OpenCode",
    connectDetail: "Link Go plan using OpenCode.ai login",
  },
};

/** Default sidebar order for providers with no saved order. */
export const DEFAULT_PROVIDER_ORDER: readonly Provider[] = [
  "openai",
  "anthropic",
  "grok",
  "antigravity",
  "google_ai_studio",
  "opencode_go",
];

export function providerName(provider: Provider): string {
  return PROVIDER_META[provider].name;
}

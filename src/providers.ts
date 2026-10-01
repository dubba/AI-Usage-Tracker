import type { Provider } from "./types";

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
    connectDetail: "ChatGPT Go, Plus or Pro plans using OpenAI Browser OAuth",
  },
  anthropic: {
    name: "Claude",
    connectLabel: "Anthropic Claude",
    connectDetail: "Claude Pro or Max plans using Anthropic Browser OAuth",
  },
  antigravity: {
    name: "Antigravity",
    connectLabel: "Google Antigravity",
    connectDetail: "Gemini Plus, Pro or Ultra using Google Browser OAuth",
  },
  grok: {
    name: "Grok",
    connectLabel: "xAI Grok",
    connectDetail: "SuperGrok, Plus or Heavy plans using Grok.com sign-in",
  },
  google_ai_studio: {
    name: "AI Studio",
    connectLabel: "Google AI Studio",
    connectDetail: "AI Studio Gemini models using API key validation",
  },
  opencode_go: {
    name: "OpenCode Go",
    connectLabel: "OpenCode",
    connectDetail: "Go plan using opencode.ai sign-in",
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

import { bridgeApi } from "../api";
import { PROVIDER_META } from "../providers";
import type { Account, Provider } from "../types";

export type GoogleModelOption = {
  name: string;
  label: string;
};

/** Everything the Add Account form collects, for whichever provider is selected. */
export type AddAccountDraft = {
  label: string;
  provider: Provider;
  email: string;
  workspaceId: string;
  authCookie: string;
  grokCookie: string;
  advancedManual: boolean;
  apiKey: string;
  availableModels: GoogleModelOption[];
  selectedModels: string[];
};

export function defaultAccountName(provider: Provider): string {
  return PROVIDER_META[provider].name;
}

export function emptyDraft(provider: Provider, label = defaultAccountName(provider)): AddAccountDraft {
  return {
    label,
    provider,
    email: "",
    workspaceId: "",
    authCookie: "",
    grokCookie: "",
    advancedManual: false,
    apiKey: "",
    availableModels: [],
    selectedModels: [],
  };
}

/** True while the name is still one the app filled in, so it may follow a change of provider. */
export function isAutoAccountName(value: string, provider: Provider): boolean {
  const trimmed = value.trim();
  return !trimmed || trimmed === defaultAccountName(provider) || trimmed === PROVIDER_META[provider].connectLabel;
}

export function validEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

/**
 * How submitting the form connects the account:
 * - `sign-in`: start a browser or private-window sign-in and wait for it
 * - `manual`: send pasted cookies straight to the backend
 * - `api-key`: send an API key and the chosen models straight to the backend
 */
export type ConnectMode = "sign-in" | "manual" | "api-key";

/** Everything about one provider's Add Account flow that is not layout. */
export interface ProviderStrategy {
  connectMode(draft: AddAccountDraft): ConnectMode;
  /** The first problem with the form that must stop a submit, or null. */
  validate(draft: AddAccountDraft): string | null;
  /** False while a required field is empty, which keeps the primary button disabled. */
  isReady(draft: AddAccountDraft): boolean;
  /** Explains the sign-in under the title when reconnecting. */
  description(env: { isAndroid: boolean }): string;
  /** Status text shown the moment a sign-in starts; null when the browser callback speaks for itself. */
  signInStartMessage: string | null;
  /** Text for the waiting panel; `backendMessage` is what the backend last reported. */
  waitingText(backendMessage: string | null): string;
  /** Whether the authorization URL is opened in the system browser. */
  opensBrowser: boolean;
  /** Email passed to the sign-in start, for providers that need one. */
  signInEmail(draft: AddAccountDraft): string | undefined;
  /** Sends the form to the backend for the `manual` and `api-key` modes. */
  connectDirect?(draft: AddAccountDraft, name: string): Promise<Account>;
  /** Label for the primary button. */
  actionLabel(draft: AddAccountDraft, busy: boolean): string;
}

const connectLabel = (provider: Provider) => PROVIDER_META[provider].connectLabel;

const browserSignIn = (provider: Provider): ProviderStrategy => ({
  connectMode: () => "sign-in",
  validate: () => null,
  isReady: () => true,
  description: ({ isAndroid }) =>
    isAndroid
      ? `Your browser opens the ${connectLabel(provider)} sign-in page. After you finish, return to the app; it links the account automatically. Passwords never pass through this app.`
      : `Finish the ${connectLabel(provider)} login in your browser. Passwords never pass through this app.`,
  signInStartMessage: null,
  waitingText: () => "Waiting for the browser callback…",
  opensBrowser: true,
  signInEmail: () => undefined,
  actionLabel: (_draft, busy) => (busy ? "Connecting…" : `Open ${defaultAccountName(provider)} login`),
});

const opencodeGo: ProviderStrategy = {
  ...browserSignIn("opencode_go"),
  connectMode: (draft) => (draft.advancedManual ? "manual" : "sign-in"),
  validate: (draft) => (validEmail(draft.email) ? null : "A valid email address is required for OpenCode Go accounts."),
  isReady: (draft) => Boolean(draft.email.trim()),
  description: ({ isAndroid }) =>
    isAndroid
      ? "The app opens OpenCode sign-in in this window. Sign in, then select Go from the OpenCode sidebar. After your limits are found, the app returns to the dashboard."
      : "A private OpenCode window will open in the app. Sign in, then select Go from the OpenCode sidebar. The bridge detects the workspace and session automatically and closes the window when the account is connected.",
  signInStartMessage: "Sign in to OpenCode and select Go from the sidebar.",
  waitingText: (backendMessage) => backendMessage ?? "Waiting for the OpenCode Go page…",
  opensBrowser: false,
  signInEmail: (draft) => draft.email.trim() || undefined,
  connectDirect: (draft, name) =>
    bridgeApi.addOpenCodeGoAccount(name, draft.workspaceId.trim(), draft.authCookie.trim(), draft.email.trim() || undefined),
  actionLabel: (draft, busy) =>
    busy ? "Waiting for OpenCode…" : draft.advancedManual ? "Connect manually" : "Open OpenCode login",
};

const grok: ProviderStrategy = {
  ...browserSignIn("grok"),
  connectMode: (draft) => (draft.advancedManual ? "manual" : "sign-in"),
  validate: (draft) =>
    draft.advancedManual && !draft.grokCookie.trim() ? "Grok session cookies are required for manual connection." : null,
  isReady: (draft) => !draft.advancedManual || Boolean(draft.grokCookie.trim()),
  description: ({ isAndroid }) =>
    isAndroid
      ? "The app opens Grok sign-in in this window. After you sign in, it returns to the dashboard and securely saves only the session needed to read weekly usage. Your xAI password never passes through the tracker."
      : "A private Grok window opens inside the tracker. After you sign in, the tracker securely saves only the Grok session needed to read the provider-reported weekly usage percentage and reset time. Your xAI password never passes through the tracker.",
  signInStartMessage: "Sign in to Grok in the private window.",
  waitingText: (backendMessage) => backendMessage ?? "Waiting for the Grok login…",
  opensBrowser: false,
  connectDirect: (draft, name) => bridgeApi.addGrokAccount(name, draft.grokCookie.trim()),
  actionLabel: (draft, busy) =>
    busy
      ? draft.advancedManual ? "Adding account…" : "Waiting for Grok…"
      : draft.advancedManual ? "Connect manually" : "Open Grok login",
};

const googleAiStudio: ProviderStrategy = {
  ...browserSignIn("google_ai_studio"),
  connectMode: () => "api-key",
  validate: (draft) => {
    if (!draft.apiKey.trim()) return "A Google AI Studio API key is required.";
    if (!draft.availableModels.length) return "Load the models from Google before adding this account.";
    if (!draft.selectedModels.length) return "Select at least one Google model to track.";
    return null;
  },
  isReady: (draft) => Boolean(draft.apiKey.trim() && draft.availableModels.length && draft.selectedModels.length),
  description: () =>
    "Enter an AI Studio API key, load the model list directly from Google, and choose which models to track. After the account is added, connect its Google Cloud project to retrieve provider-reported quota usage.",
  connectDirect: (draft, name) => bridgeApi.addGoogleAiStudioAccount(name, draft.apiKey.trim(), draft.selectedModels),
  actionLabel: (_draft, busy) => (busy ? "Adding account…" : "Add selected models"),
};

const STRATEGIES: Record<Provider, ProviderStrategy> = {
  openai: browserSignIn("openai"),
  anthropic: browserSignIn("anthropic"),
  antigravity: browserSignIn("antigravity"),
  grok,
  google_ai_studio: googleAiStudio,
  opencode_go: opencodeGo,
};

export function strategyFor(provider: Provider): ProviderStrategy {
  return STRATEGIES[provider];
}

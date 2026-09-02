import { useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { bridgeApi } from "../api";
import { abandonLoginAttempt, retryLoginAttempt, subscribeLoginStatus, watchLoginAttempt } from "../login-status";
import type { Account, LoginStatus, Provider } from "../types";
import { CustomDropdown, type DropdownOption } from "./CustomDropdown";
import { useModalA11y } from "./useModalA11y";

type ConnectionProvider = Provider;

type GoogleModelOption = {
  name: string;
  label: string;
};

const providerOptions: Array<{ id: ConnectionProvider; label: string; detail: string }> = [
  { id: "openai", label: "Codex/GPT", detail: "ChatGPT Plus, Pro, Business, or other Codex-enabled plans" },
  { id: "anthropic", label: "Claude", detail: "Claude Pro or Max through Anthropic OAuth" },
  { id: "grok", label: "Grok", detail: "Private grok.com sign-in and provider-reported weekly usage" },
  { id: "antigravity", label: "Antigravity", detail: "Google OAuth and Cloud Code quota data" },
  { id: "google_ai_studio", label: "AI Studio", detail: "Validate an API key, choose models, and optionally connect project quota usage" },
  { id: "opencode_go", label: "OpenCode Go", detail: "Sign in and select Go; setup is detected automatically" },
];

const providerDropdownOptions: DropdownOption<ConnectionProvider>[] = providerOptions.map((option) => ({
  value: option.id,
  label: option.label,
  detail: option.detail,
}));

function providerName(provider: ConnectionProvider): string {
  return providerOptions.find((option) => option.id === provider)?.label ?? provider;
}

function validEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

export function AddAccountModal({
  open,
  initialLabel,
  initialProvider,
  onClose,
  onAdded,
}: {
  open: boolean;
  initialLabel?: string;
  initialProvider?: Provider;
  onClose: () => void;
  onAdded: (account: Account) => void;
}) {
  const isAndroid = /android/i.test(navigator.userAgent);
  const [label, setLabel] = useState("Codex/GPT");
  const [provider, setProvider] = useState<ConnectionProvider>("openai");
  const [email, setEmail] = useState("");
  const [workspaceId, setWorkspaceId] = useState("");
  const [authCookie, setAuthCookie] = useState("");
  const [grokCookie, setGrokCookie] = useState("");
  const [advancedManual, setAdvancedManual] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [availableModels, setAvailableModels] = useState<GoogleModelOption[]>([]);
  const [selectedModels, setSelectedModels] = useState<string[]>([]);
  const [modelsBusy, setModelsBusy] = useState(false);
  const [status, setStatus] = useState<LoginStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const closeRequestedRef = useRef(false);
  const attemptIdRef = useRef<string | null>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const providerLocked = Boolean(initialProvider && initialLabel?.trim());

  useEffect(() => {
    if (!open) {
      closeRequestedRef.current = true;
      setLabel("Codex/GPT");
      setProvider("openai");
      setEmail("");
      setWorkspaceId("");
      setAuthCookie("");
      setGrokCookie("");
      setAdvancedManual(false);
      setApiKey("");
      setAvailableModels([]);
      setSelectedModels([]);
      setModelsBusy(false);
      setStatus(null);
      setBusy(false);
      setError(null);
      attemptIdRef.current = null;
    } else {
      closeRequestedRef.current = false;
      const nextProvider = providerLocked && initialProvider ? initialProvider : "openai";
      setProvider(nextProvider);
      setLabel(initialLabel?.trim() || providerName(nextProvider));
      setEmail("");
      setAdvancedManual(false);
      setApiKey("");
      setAvailableModels([]);
      setSelectedModels([]);
      setModelsBusy(false);
    }
  }, [open, initialLabel, initialProvider, providerLocked]);

  useEffect(() => {
    if (!open) return;
    return subscribeLoginStatus((next) => {
      if (closeRequestedRef.current) return;
      if (attemptIdRef.current !== next.attemptId) return;
      setStatus(next);
      if (next.status === "complete" && next.account) {
        onAdded(next.account);
        return;
      }
      if (next.status === "failed") {
        setBusy(false);
        setError(next.message ?? `${providerName(provider)} authentication failed.`);
      }
    });
  }, [open, onAdded, provider]);

  const closeModal = () => {
    closeRequestedRef.current = true;
    const attemptId = status?.attemptId ?? attemptIdRef.current;
    setStatus(null);
    setBusy(false);
    attemptIdRef.current = null;
    if (attemptId) {
      abandonLoginAttempt(attemptId);
    }
    onClose();
  };

  useModalA11y(dialogRef, open, closeModal);

  if (!open) return null;

  const loadGoogleModels = async () => {
    const key = apiKey.trim();
    if (!key) {
      setError("Enter a Google AI Studio API key first.");
      return;
    }

    setModelsBusy(true);
    setError(null);
    try {
      const probe = await bridgeApi.testGoogleAiStudioKey(key);
      const models = (probe.lastUsage?.windows ?? []).map((model) => ({
        name: model.id,
        label: model.label,
      }));
      if (!models.length) {
        setAvailableModels([]);
        setSelectedModels([]);
        setError("Google returned no models that can be tracked with this key.");
        return;
      }
      const availableNames = new Set(models.map((model) => model.name));
      setAvailableModels(models);
      setSelectedModels((current) => current.filter((name) => availableNames.has(name)));
    } catch (cause) {
      setAvailableModels([]);
      setSelectedModels([]);
      setError(String(cause));
    } finally {
      setModelsBusy(false);
    }
  };

  const begin = async () => {
    if (provider === "google_ai_studio") {
      if (!apiKey.trim()) {
        setError("A Google AI Studio API key is required.");
        return;
      }
      if (!availableModels.length) {
        setError("Load the models from Google before adding this account.");
        return;
      }
      if (!selectedModels.length) {
        setError("Select at least one Google model to track.");
        return;
      }

      setBusy(true);
      setError(null);
      try {
        const account = await bridgeApi.addGoogleAiStudioAccount(
          label.trim() || providerName(provider),
          apiKey.trim(),
          selectedModels,
        );
        onAdded(account);
      } catch (cause) {
        setBusy(false);
        setError(String(cause));
      }
      return;
    }

    if (provider === "opencode_go" && !validEmail(email)) {
      setError("A valid email address is required for OpenCode Go accounts.");
      return;
    }

    setBusy(true);
    setError(null);
    try {
      if (provider === "opencode_go" && advancedManual) {
        const account = await bridgeApi.addOpenCodeGoAccount(
          label.trim() || providerName(provider),
          workspaceId.trim(),
          authCookie.trim(),
          email.trim() || undefined,
        );
        onAdded(account);
        return;
      }

      if (provider === "grok" && advancedManual) {
        if (!grokCookie.trim()) {
          setError("Grok session cookies are required for manual connection.");
          setBusy(false);
          return;
        }
        const account = await bridgeApi.addGrokAccount(
          label.trim() || providerName(provider),
          grokCookie.trim(),
        );
        onAdded(account);
        return;
      }

      const start = await bridgeApi.startLogin(
        label.trim() || providerName(provider),
        provider,
        provider === "opencode_go" ? email.trim() || undefined : undefined,
      );
      if (closeRequestedRef.current) {
        await bridgeApi.cancelLogin(start.attemptId).catch(() => undefined);
        return;
      }
      attemptIdRef.current = start.attemptId;
      setStatus({
        attemptId: start.attemptId,
        status: "waiting",
        message: provider === "opencode_go"
          ? "Sign in to OpenCode and select Go from the sidebar."
          : provider === "grok"
            ? "Sign in to Grok in the private window."
            : null,
        account: null,
        projects: null,
        selectedProjectId: null,
      });
      watchLoginAttempt(start.attemptId);
      if (start.authorizationUrl.trim()) {
        await openUrl(start.authorizationUrl);
      }
    } catch (cause) {
      if (!closeRequestedRef.current) {
        setBusy(false);
        setError(String(cause));
      }
    }
  };

  const retry = () => {
    const attemptId = status?.attemptId ?? attemptIdRef.current;
    if (attemptId && retryLoginAttempt(attemptId)) {
      setError(null);
      setBusy(true);
      setStatus({
        attemptId,
        status: "waiting",
        message: "Reconnecting to the sign-in…",
        account: null,
        projects: null,
        selectedProjectId: null,
      });
      return;
    }
    void begin();
  };

  const providerCopy = provider === "opencode_go"
    ? "A private OpenCode window will open in the app. Sign in, then select Go from the OpenCode sidebar. The bridge detects the workspace and session automatically and closes the window when the account is connected."
    : provider === "google_ai_studio"
      ? "Enter an AI Studio API key, load the model list directly from Google, and choose which models to track. After the account is added, connect its Google Cloud project to retrieve provider-reported quota usage."
      : provider === "grok"
        ? isAndroid
          ? "The app opens Grok sign-in in this window. After you sign in, it returns to the dashboard and securely saves only the session needed to read weekly usage. Your xAI password never passes through the tracker."
          : "A private Grok window opens inside the tracker. After you sign in, the tracker securely saves only the Grok session needed to read the provider-reported weekly usage percentage and reset time. Your xAI password never passes through the tracker."
        : isAndroid
          ? `Your browser opens the ${providerName(provider)} sign-in page. After you finish, return to the app; it links the account automatically. Passwords never pass through this app.`
          : `Finish the ${providerName(provider)} login in your browser. Passwords never pass through this app.`;

  const googleReady = Boolean(
    apiKey.trim()
    && availableModels.length
    && selectedModels.length
    && !modelsBusy,
  );

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !busy && closeModal()}>
      <section ref={dialogRef} className="modal-card" role="dialog" aria-modal="true" aria-labelledby="add-account-title" tabIndex={-1}>
        <div className="modal-kicker">Provider connection</div>
        <h2 id="add-account-title">{providerLocked ? `Reconnect ${providerName(provider)}` : "Which account do you want to add?"}</h2>
        <p>{providerLocked ? providerCopy : "Choose a provider, name the account, and enter its secure connection details."}</p>

        <label className="field-label" htmlFor="account-provider">Provider</label>
        <CustomDropdown<ConnectionProvider>
          id="account-provider"
          value={provider}
          options={providerDropdownOptions}
          onChange={(nextProvider) => {
            setLabel((current) => !current.trim() || current === providerName(provider) ? providerName(nextProvider) : current);
            setProvider(nextProvider);
            setEmail("");
            setWorkspaceId("");
            setAuthCookie("");
            setGrokCookie("");
            setAdvancedManual(false);
            setApiKey("");
            setAvailableModels([]);
            setSelectedModels([]);
            setModelsBusy(false);
            setStatus(null);
            setError(null);
          }}
          disabled={busy || modelsBusy || providerLocked}
        />

        <label className="field-label field-spaced" htmlFor="account-label">Account name</label>
        <input
          id="account-label"
          className="text-input"
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          placeholder={providerName(provider)}
          disabled={busy || modelsBusy}
        />

        {provider === "google_ai_studio" ? (
          <>
            <label className="field-label field-spaced" htmlFor="google-ai-studio-key">Google AI Studio API key</label>
            <div className="google-key-row">
              <input
                id="google-ai-studio-key"
                className="text-input"
                type="password"
                value={apiKey}
                onChange={(event) => {
                  setApiKey(event.target.value);
                  setAvailableModels([]);
                  setSelectedModels([]);
                  setError(null);
                }}
                placeholder="Paste the API key"
                autoComplete="off"
                spellCheck={false}
                disabled={busy || modelsBusy}
              />
              <button
                type="button"
                className="button ghost google-load-models"
                onClick={() => void loadGoogleModels()}
                disabled={busy || modelsBusy || !apiKey.trim()}
              >
                {modelsBusy ? "Loading…" : availableModels.length ? "Reload models" : "Load models"}
              </button>
            </div>
            <div className="credential-note">The key is sent only to the Rust backend and saved in Credential Manager or Keychain after you add the account.</div>

            {availableModels.length ? (
              <div className="google-model-picker">
                <div className="google-model-picker-header">
                  <div>
                    <strong>Models to track</strong>
                    <small>{selectedModels.length} of {availableModels.length} selected</small>
                  </div>
                  <div className="google-model-picker-actions">
                    <button type="button" onClick={() => setSelectedModels(availableModels.map((model) => model.name))} disabled={busy}>Select all</button>
                    <button type="button" onClick={() => setSelectedModels([])} disabled={busy || !selectedModels.length}>Clear</button>
                  </div>
                </div>
                <div className="google-model-list">
                  {availableModels.map((model) => (
                    <label className="google-model-option" key={model.name}>
                      <input
                        type="checkbox"
                        checked={selectedModels.includes(model.name)}
                        disabled={busy}
                        onChange={(event) => {
                          setSelectedModels((current) => event.target.checked
                            ? [...current, model.name]
                            : current.filter((name) => name !== model.name));
                          setError(null);
                        }}
                      />
                      <span>
                        <strong>{model.label}</strong>
                        <small>{model.name}</small>
                      </span>
                    </label>
                  ))}
                </div>
                <div className="credential-note google-usage-note">The API key confirms model access. Project-level RPM, TPM, and daily quotas require the separate read-only Google Cloud connection available on the account card.</div>
              </div>
            ) : null}
          </>
        ) : null}

        {provider === "grok" ? (
          <>
            {!advancedManual ? (
              <div className="guided-login-card grok-login-card">
                <strong>What happens next</strong>
                <ol>
                  <li>The tracker opens {isAndroid ? "Grok sign-in in this window" : "a temporary private accounts.x.ai sign-in window"}.</li>
                  <li>Sign in normally to your Grok or SuperGrok account.</li>
                  <li>{isAndroid ? "The app returns to the dashboard" : "The window closes"} after Grok reports your weekly usage percentage and reset time.</li>
                </ol>
                <small>The session needed for read-only usage checks is stored securely on your device. The tracker does not estimate tokens or message counts and never receives your xAI password.</small>
              </div>
            ) : (
              <div className="manual-connection-fields">
                <label className="field-label field-spaced" htmlFor="grok-cookie">Grok session cookie or cookie header</label>
                <input
                  id="grok-cookie"
                  className="text-input"
                  type="password"
                  value={grokCookie}
                  onChange={(event) => {
                    setGrokCookie(event.target.value);
                    setError(null);
                  }}
                  placeholder="Paste grok.com cookies (e.g. sso=... or full cookie header)"
                  autoComplete="off"
                  spellCheck={false}
                  disabled={busy}
                />
                <div className="credential-note">Manual connection is recommended on mobile or if sign-in opens the external Grok or X app. Sign in to grok.com in your mobile browser, copy your cookies, and paste them here.</div>
              </div>
            )}

            {!busy ? (
              <button
                type="button"
                className="advanced-connection-toggle"
                onClick={() => {
                  setAdvancedManual((current) => !current);
                  setError(null);
                }}
              >
                {advancedManual ? "Use automatic sign-in instead" : "Advanced manual connection"}
              </button>
            ) : null}
          </>
        ) : null}

        {provider === "opencode_go" ? (
          <>
            <label className="field-label field-spaced" htmlFor="opencode-email">Email address</label>
            <input
              id="opencode-email"
              className="text-input"
              type="email"
              value={email}
              onChange={(event) => {
                setEmail(event.target.value);
                setError(null);
              }}
              placeholder="you@example.com"
              autoComplete="email"
              required
              disabled={busy}
            />
            <div className="credential-note opencode-email-note">Required so the account card can identify which OpenCode account is connected.</div>

            {!advancedManual ? (
              <div className="guided-login-card">
                <strong>What happens next</strong>
                <ol>
                  <li>The app opens an OpenCode sign-in window.</li>
                  <li>Sign in normally, then click <strong>Go</strong> in OpenCode’s sidebar.</li>
                  <li>The window closes automatically after your limits are found.</li>
                </ol>
                <small>Your OpenCode session is kept in a temporary private webview. Only the Go session value needed for read-only usage checks is saved in Credential Manager or Keychain.</small>
              </div>
            ) : (
              <div className="manual-connection-fields">
                <label className="field-label field-spaced" htmlFor="workspace-id">Workspace ID</label>
                <input
                  id="workspace-id"
                  className="text-input"
                  value={workspaceId}
                  onChange={(event) => setWorkspaceId(event.target.value)}
                  placeholder="mystic-patrol-3ls3t"
                  disabled={busy}
                />
                <label className="field-label field-spaced" htmlFor="auth-cookie">OpenCode console auth cookie</label>
                <input
                  id="auth-cookie"
                  className="text-input"
                  type="password"
                  value={authCookie}
                  onChange={(event) => setAuthCookie(event.target.value)}
                  placeholder="Paste the auth cookie value, with or without auth="
                  autoComplete="off"
                  spellCheck={false}
                  disabled={busy}
                />
                <div className="credential-note">Manual connection is intended only when embedded sign-in is blocked by an identity provider.</div>
              </div>
            )}

            {!busy ? (
              <button
                type="button"
                className="advanced-connection-toggle"
                onClick={() => {
                  setAdvancedManual((current) => !current);
                  setError(null);
                }}
              >
                {advancedManual ? "Use automatic sign-in instead" : "Advanced manual connection"}
              </button>
            ) : null}
          </>
        ) : null}

        {status?.status === "waiting" ? (
          <div className="waiting-panel">
            <span className="spinner" />
            {provider === "opencode_go"
              ? status.message ?? "Waiting for the OpenCode Go page…"
              : provider === "grok"
                ? status.message ?? "Waiting for the Grok login…"
                : "Waiting for the browser callback…"}
          </div>
        ) : null}
        {error ? <div className="error-panel modal-error">{error}</div> : null}
        <div className="modal-actions">
          <button className="button ghost" onClick={closeModal}>Cancel</button>
          {status?.status === "failed" ? (
            <button className="button primary" onClick={retry} disabled={busy || modelsBusy}>
              Retry
            </button>
          ) : (
          <button
            className="button primary"
            onClick={begin}
            disabled={
              busy ||
              modelsBusy ||
              (provider === "opencode_go" && !email.trim()) ||
              (provider === "google_ai_studio" && !googleReady) ||
              (provider === "grok" && advancedManual && !grokCookie.trim())
            }
          >
            {busy
              ? provider === "opencode_go"
                ? "Waiting for OpenCode…"
                : provider === "grok"
                  ? advancedManual ? "Adding account…" : "Waiting for Grok…"
                  : provider === "google_ai_studio"
                    ? "Adding account…"
                    : "Connecting…"
              : provider === "opencode_go"
                ? advancedManual ? "Connect manually" : "Open OpenCode login"
                : provider === "grok"
                  ? advancedManual ? "Connect manually" : "Open Grok login"
                  : provider === "google_ai_studio"
                    ? "Add selected models"
                    : `Continue with ${providerName(provider)}`}
          </button>
          )}
        </div>
      </section>
    </div>
  );
}

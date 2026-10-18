import { useEffect, useRef, useState } from "react";
import { openSafeUrl } from "../../shared/lib/safeUrl";
import { bridgeApi } from "../../shared/lib/api";
import {
  defaultAccountName,
  emptyDraft,
  isAutoAccountName,
  strategyFor,
  type AddAccountDraft,
} from "./strategies";
import { logIgnored } from "../../shared/lib/log";
import { isAndroid as detectAndroid, isIOS } from "../../shared/lib/platform";
import { PROVIDER_META } from "../../shared/lib/providers";
import { abandonLoginAttempt, recoverFromStaleLogin, retryLoginAttempt, subscribeLoginStatus, watchLoginAttempt } from "../../shared/lib/login-status";
import type { Account, LoginStatus, Provider } from "../../types";
import { GoogleAiStudioFields } from "./fields/GoogleAiStudioFields";
import { GrokFields } from "./fields/GrokFields";
import { OpenCodeFields } from "./fields/OpenCodeFields";
import type { FieldsProps } from "./fields/types";
import { CustomDropdown, type DropdownOption } from "../../shared/ui/CustomDropdown";
import { useAutoDismissedError } from "../../shared/hooks/useAutoDismissedError";
import { useModalA11y } from "../../shared/hooks/useModalA11y";
import { backdropMouseDown } from "../../shared/hooks/useModalClosePolicy";
import { ModalCloseButton } from "../../shared/ui/ModalCloseButton";
import { ConfirmDialog } from "../../shared/ui/ConfirmDialog";
import { useVirtualKeyboard } from "../../shared/hooks/useVirtualKeyboard";

const PICKER_ORDER: Provider[] = ["anthropic", "antigravity", "openai", "grok", "opencode_go", "google_ai_studio"];

const providerDropdownOptions: DropdownOption<Provider>[] = PICKER_ORDER.map((id) => ({
  value: id,
  label: PROVIDER_META[id].connectLabel,
  detail: PROVIDER_META[id].connectDetail,
}));

const connectLabel = (provider: Provider) => PROVIDER_META[provider].connectLabel;

export function AddAccountModal({
  open,
  initialLabel,
  initialProvider,
  reconnectAccountId,
  onClose,
  onAdded,
}: {
  open: boolean;
  initialLabel?: string;
  initialProvider?: Provider;
  reconnectAccountId?: string;
  onClose: () => void;
  onAdded: (account: Account) => void;
}) {
  const isAndroid = detectAndroid() || isIOS();
  const [draft, setDraft] = useState<AddAccountDraft>(() => emptyDraft("anthropic"));
  const [modelsBusy, setModelsBusy] = useState(false);
  const [status, setStatus] = useState<LoginStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const { error, setError } = useAutoDismissedError(open);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const [baselineLabel, setBaselineLabel] = useState("");
  const [isKeyboardOpen, setIsKeyboardOpen] = useVirtualKeyboard(open);
  const closeRequestedRef = useRef(false);
  const attemptIdRef = useRef<string | null>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const providerLocked = Boolean(initialProvider && initialLabel?.trim());
  const { provider } = draft;
  const strategy = strategyFor(provider);

  const update = (patch: Partial<AddAccountDraft>) => setDraft((current) => ({ ...current, ...patch }));

  useEffect(() => {
    if (!open) {
      closeRequestedRef.current = true;
      setDraft(emptyDraft("anthropic"));
      setModelsBusy(false);
      setStatus(null);
      setBusy(false);
      setError(null);
      setConfirmingDiscard(false);
      attemptIdRef.current = null;
    } else {
      closeRequestedRef.current = false;
      const nextProvider = initialProvider ?? "anthropic";
      setDraft(emptyDraft(nextProvider, initialLabel?.trim() || defaultAccountName(nextProvider)));
      setBaselineLabel(initialLabel?.trim() || defaultAccountName(nextProvider));
      setModelsBusy(false);
    }
  }, [open, initialLabel, initialProvider, providerLocked, setError]);

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
        setError(next.message ?? `${connectLabel(provider)} authentication failed.`);
      }
    });
  }, [open, onAdded, provider, setError]);

  const closeModal = () => {
    closeRequestedRef.current = true;
    const attemptId = status?.attemptId ?? attemptIdRef.current;
    setStatus(null);
    setBusy(false);
    setIsKeyboardOpen(false);
    document.documentElement.style.removeProperty("--visual-keyboard-height");
    attemptIdRef.current = null;
    if (attemptId) {
      abandonLoginAttempt(attemptId);
    }
    onClose();
  };

  // This dialog can always be closed: closing abandons any login attempt in flight
  // (closeModal handles the cleanup), so no busy guard is needed. Typed-in but
  // unsaved credentials first ask whether to discard them.
  const draftDirty =
    [draft.email, draft.workspaceId, draft.authCookie, draft.grokCookie, draft.apiKey].some(
      (value) => value.trim() !== "",
    ) ||
    draft.selectedModels.length > 0 ||
    draft.label !== baselineLabel;
  const requestClose = () => {
    if (attemptIdRef.current || !draftDirty) {
      closeModal();
    } else {
      setConfirmingDiscard(true);
    }
  };

  const handleEscape = () => {
    if (error) {
      setError(null);
      return;
    }
    requestClose();
  };
  useModalA11y(dialogRef, open && !confirmingDiscard, handleEscape);

  if (!open) return null;

  const changeProvider = (nextProvider: Provider) => {
    setDraft((current) => emptyDraft(
      nextProvider,
      isAutoAccountName(current.label, current.provider) ? defaultAccountName(nextProvider) : current.label,
    ));
    setModelsBusy(false);
    setStatus(null);
    setError(null);
  };

  const loadGoogleModels = async () => {
    const key = draft.apiKey.trim();
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
        update({ availableModels: [], selectedModels: [] });
        setError("Google returned no models that can be tracked with this key.");
        return;
      }
      const availableNames = new Set(models.map((model) => model.name));
      setDraft((current) => ({
        ...current,
        availableModels: models,
        selectedModels: current.selectedModels.filter((name) => availableNames.has(name)),
      }));
    } catch (cause) {
      update({ availableModels: [], selectedModels: [] });
      setError(String(cause));
    } finally {
      setModelsBusy(false);
    }
  };

  /** Starts a browser or private-window sign-in and waits for the backend to report its result. */
  const startSignIn = async (name: string) => {
    const startLogin = () => bridgeApi.startLogin(name, provider, strategy.signInEmail(draft), reconnectAccountId);
    let start;
    try {
      start = await startLogin();
    } catch (cause) {
      if (!String(cause).toLowerCase().includes("already in progress")) {
        throw cause;
      }
      await recoverFromStaleLogin();
      start = await startLogin();
    }
    if (closeRequestedRef.current) {
      await bridgeApi.cancelLogin(start.attemptId).catch((cause) => logIgnored("login.cancel", cause));
      return;
    }
    attemptIdRef.current = start.attemptId;
    setStatus({
      attemptId: start.attemptId,
      status: "waiting",
      message: strategy.signInStartMessage,
      account: null,
      projects: null,
      selectedProjectId: null,
    });
    watchLoginAttempt(start.attemptId);
    if (strategy.opensBrowser && start.authorizationUrl.trim()) {
      await openSafeUrl(start.authorizationUrl);
    }
  };

  const begin = async () => {
    const problem = strategy.validate(draft);
    if (problem) {
      setError(problem);
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const name = draft.label.trim() || defaultAccountName(provider);
      if (strategy.connectMode(draft) === "sign-in") {
        await startSignIn(name);
      } else {
        onAdded(await strategy.connectDirect!(draft, name, reconnectAccountId));
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

  const fieldProps: FieldsProps = { draft, update, setError, busy, isAndroid };
  const providerFields = (() => {
    switch (provider) {
      case "google_ai_studio":
        return <GoogleAiStudioFields {...fieldProps} modelsBusy={modelsBusy} onLoadModels={() => void loadGoogleModels()} />;
      case "grok":
        return <GrokFields {...fieldProps} />;
      case "opencode_go":
        return <OpenCodeFields {...fieldProps} />;
      default:
        return null;
    }
  })();

  const providerCopy = strategy.description({ isAndroid });

  return (
    <div
      className={`modal-backdrop ${isKeyboardOpen ? "keyboard-open" : ""}`}
      role="presentation"
      onMouseDown={backdropMouseDown(requestClose)}
    >
      <section
        ref={dialogRef}
        className={`modal-card provider-connection-modal ${isKeyboardOpen ? "keyboard-open" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-account-title"
        tabIndex={-1}
      >
        <ModalCloseButton onClose={requestClose} />
        <div className="modal-kicker">Provider connection</div>
        <h2 id="add-account-title">{providerLocked ? `Reconnect ${connectLabel(provider)}` : "Add AI Provider Account"}</h2>
        <p>{providerLocked ? providerCopy : "Choose a provider, name the account, and enter its secure connection details."}</p>

        <label className="field-label" htmlFor="account-provider">Provider</label>
        <CustomDropdown<Provider>
          id="account-provider"
          aria-label="Provider"
          value={provider}
          options={providerDropdownOptions}
          onChange={changeProvider}
          disabled={busy || modelsBusy || providerLocked}
        />

        <label className="field-label field-spaced" htmlFor="account-label">Account name</label>
        <input
          id="account-label"
          className="text-input"
          value={draft.label}
          onChange={(event) => update({ label: event.target.value })}
          placeholder={defaultAccountName(provider)}
          disabled={busy || modelsBusy}
        />

        {strategy.wantsEmailHint ? (
          <>
            <label className="field-label field-spaced" htmlFor="account-email">Account email (optional)</label>
            <input
              id="account-email"
              className="text-input"
              type="email"
              value={draft.email}
              onChange={(event) => update({ email: event.target.value })}
              placeholder="you@example.com"
              autoComplete="email"
              spellCheck={false}
              disabled={busy || modelsBusy}
            />
            <div className="credential-note">If you've signed in to this provider before, entering an email lets you sign in with that account instead of reusing the existing session.</div>
          </>
        ) : null}

        {providerFields}

        {status?.status === "waiting" ? (
          <div className="waiting-panel">
            <span className="spinner" />
            {strategy.waitingText(status.message)}
          </div>
        ) : null}
        <div className="modal-actions">
          <button type="button" className="button ghost" onClick={requestClose}>Cancel</button>
          {status?.status === "failed" ? (
            <button type="button" className="button primary" onClick={retry} disabled={busy || modelsBusy}>
              Retry
            </button>
          ) : (
            <button type="button"
              className="button primary"
              onClick={begin}
              disabled={busy || modelsBusy || !strategy.isReady(draft)}
            >
              {strategy.actionLabel(draft, busy)}
            </button>
          )}
        </div>
        {error ? <div className="error-panel modal-error">{error}</div> : null}
      </section>
      <ConfirmDialog
        open={confirmingDiscard}
        kicker="Unsaved changes"
        title="Discard what you entered?"
        body="The sign-in details you typed haven't been saved and will be lost."
        confirmLabel="Discard Changes"
        onConfirm={() => {
          setConfirmingDiscard(false);
          closeModal();
        }}
        onCancel={() => setConfirmingDiscard(false)}
      />
    </div>
  );
}

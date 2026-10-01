import { AdvancedToggle } from "./AdvancedToggle";
import type { FieldsProps } from "./types";

export function OpenCodeFields({ draft, update, setError, busy, isAndroid }: FieldsProps) {
  return (
    <>
      <label className="field-label field-spaced" htmlFor="opencode-email">Email address</label>
      <input
        id="opencode-email"
        className="text-input"
        type="email"
        value={draft.email}
        onChange={(event) => {
          update({ email: event.target.value });
          setError(null);
        }}
        placeholder="you@example.com"
        autoComplete="email"
        required
        disabled={busy}
      />
      <div className="credential-note opencode-email-note">Required so the account card can identify which OpenCode account is connected.</div>

      {!draft.advancedManual ? (
        <div className="guided-login-card">
          <strong>What happens next</strong>
          <ol>
            <li>The app opens {isAndroid ? "OpenCode sign-in in this window" : "an OpenCode sign-in window"}.</li>
            <li>Sign in normally, then click <strong>Go</strong> in OpenCode’s sidebar.</li>
            <li>{isAndroid ? "The app returns to the dashboard" : "The window closes"} automatically after your limits are found.</li>
          </ol>
          <small>{isAndroid ? "The session needed for read-only usage checks is stored securely on your device." : "Your OpenCode session is kept in a temporary private webview. Only the Go session value needed for read-only usage checks is saved in Credential Manager or Keychain."}</small>
        </div>
      ) : (
        <div className="manual-connection-fields">
          <label className="field-label field-spaced" htmlFor="workspace-id">Workspace ID</label>
          <input
            id="workspace-id"
            className="text-input"
            value={draft.workspaceId}
            onChange={(event) => update({ workspaceId: event.target.value })}
            placeholder="mystic-patrol-3ls3t"
            disabled={busy}
          />
          <label className="field-label field-spaced" htmlFor="auth-cookie">OpenCode console auth cookie</label>
          <input
            id="auth-cookie"
            className="text-input"
            type="password"
            value={draft.authCookie}
            onChange={(event) => update({ authCookie: event.target.value })}
            placeholder="Paste the auth cookie value, with or without auth="
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
          />
          <div className="credential-note">Manual connection is intended only when embedded sign-in is blocked by an identity provider.</div>
        </div>
      )}

      {!busy ? (
        <AdvancedToggle
          manual={draft.advancedManual}
          onToggle={() => {
            update({ advancedManual: !draft.advancedManual });
            setError(null);
          }}
        />
      ) : null}
    </>
  );
}

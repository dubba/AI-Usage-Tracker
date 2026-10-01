import { AdvancedToggle } from "./AdvancedToggle";
import type { FieldsProps } from "./types";

export function GrokFields({ draft, update, setError, busy, isAndroid }: FieldsProps) {
  return (
    <>
      {!draft.advancedManual ? (
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
            value={draft.grokCookie}
            onChange={(event) => {
              update({ grokCookie: event.target.value });
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

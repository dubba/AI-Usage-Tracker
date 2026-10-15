import { AdvancedToggle } from "./AdvancedToggle";
import type { FieldsProps } from "./types";

export function GrokFields({ draft, update, setError, busy }: FieldsProps) {
  return (
    <>
      {draft.advancedManual && (
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

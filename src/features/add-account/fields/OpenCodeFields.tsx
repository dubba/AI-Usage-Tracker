import { AdvancedToggle } from "./AdvancedToggle";
import type { FieldsProps } from "./types";

export function OpenCodeFields({ draft, update, setError, busy }: FieldsProps) {
  return (
    <>
      <label className="field-label field-spaced" htmlFor="opencode-email">Account email (optional)</label>
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
        disabled={busy}
      />

      {draft.advancedManual && (
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

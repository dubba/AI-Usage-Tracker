import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { bridgeApi } from "../../shared/lib/api";
import { describeError } from "../../shared/lib/errors";
import { EyeIcon, EyeOffIcon, RefreshIcon } from "../../shared/ui/icons";
import type { BridgeInfo } from "../../types";

const DETAILS_REFRESH_MS = 2_000;
const COPIED_FEEDBACK_MS = 2_000;

function statusLabel(bridge: BridgeInfo): string {
  if (!bridge.enabled) return "Disabled";
  if (bridge.running) return "Running";
  if (bridge.error) return "Needs attention";
  return "Starting";
}

/** Same look as the Settings Copy buttons, text only. */
function CopyButton({ label = "Copy", copied, onClick }: { label?: string; copied: boolean; onClick: () => void }) {
  return (
    <button type="button" className="button ghost settings-changelog-button" aria-live="polite" onClick={onClick}>
      <span>{copied ? "Copied!" : label}</span>
    </button>
  );
}

export function ApiIntegrationWindow() {
  const [bridge, setBridge] = useState<BridgeInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [fullToken, setFullToken] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const copiedTimerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current);
    },
    []
  );

  const load = useCallback(async () => {
    try {
      // Polls masked token info only; the full bearer token is fetched
      // exclusively via revealBridgeToken() after explicit user action.
      const next = await bridgeApi.bridgeInfo();
      setBridge(next);
      setError(null);
    } catch (cause) {
      setError(describeError("api-integration", "Couldn't load the Paseo Bridge details", cause));
    }
  }, []);

  useEffect(() => {
    void load();
    const interval = window.setInterval(() => void load(), DETAILS_REFRESH_MS);
    return () => window.clearInterval(interval);
  }, [load]);

  // Clear the in-memory full token when hiding so it does not linger in
  // renderer memory longer than the reveal session. (An effect cleanup that
  // cleared it would also run as `revealed` turns true, wiping the token that
  // was just fetched; the state is dropped with the window on unmount.)
  useEffect(() => {
    if (!revealed) setFullToken(null);
  }, [revealed]);

  const healthEndpoint = useMemo(
    () => bridge?.endpoint.replace(/\/v1\/paseo-usage$/, "/v1/health") ?? "",
    [bridge?.endpoint],
  );
  const displayToken = revealed && fullToken ? fullToken : (bridge?.token ?? "");
  const environment = bridge
    ? `PASEO_EXTERNAL_PROVIDER_USAGE_URL=${bridge.endpoint}\nPASEO_EXTERNAL_PROVIDER_USAGE_TOKEN=${revealed && fullToken ? fullToken : bridge.token}`
    : "";

  const reveal = async () => {
    try {
      const token = await bridgeApi.revealBridgeToken();
      setFullToken(token);
      setRevealed(true);
      setError(null);
    } catch (cause) {
      setError(describeError("api-integration", "Couldn't reveal the token", cause));
    }
  };

  const copy = async (value: string, key: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setError(null);
      setCopiedKey(key);
      if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = window.setTimeout(
        () => setCopiedKey((c) => (c === key ? null : c)),
        COPIED_FEEDBACK_MS
      );
    } catch (cause) {
      setError(describeError("api-integration", "Couldn't copy to the clipboard", cause));
    }
  };

  // Copying the bearer token or the env block counts as an explicit reveal:
  // fetch the full token once for the copy without leaving it displayed. The
  // backend asks for confirmation in a native dialog, so keep the token after
  // the first confirmed fetch instead of asking again on every copy.
  const confirmedToken = async () => {
    if (fullToken) return fullToken;
    const token = await bridgeApi.revealBridgeToken();
    setFullToken(token);
    return token;
  };
  const copyToken = async () => {
    try {
      const token = await confirmedToken();
      await copy(token, "token");
    } catch (cause) {
      setError(describeError("api-integration", "Couldn't copy the token", cause));
    }
  };

  const copyEnv = async () => {
    if (!bridge) return;
    try {
      const token = await confirmedToken();
      await copy(
        `PASEO_EXTERNAL_PROVIDER_USAGE_URL=${bridge.endpoint}\nPASEO_EXTERNAL_PROVIDER_USAGE_TOKEN=${token}`,
        "env",
      );
    } catch (cause) {
      setError(describeError("api-integration", "Couldn't copy the settings", cause));
    }
  };

  const rotateToken = async () => {
    setBusy(true);
    try {
      const next = await bridgeApi.regenerateToken();
      setBridge(next);
      setRevealed(false);
      setFullToken(null);
      setError(null);
    } catch (cause) {
      setError(describeError("api-integration", "Couldn't generate a new token", cause));
    } finally {
      setBusy(false);
    }
  };

  if (!bridge) {
    return <div className="bridge-window-loading">Loading Paseo Bridge configuration…</div>;
  }

  return (
    <div className="bridge-window-shell">
      <header className="bridge-window-header">
        <div>
          <h1>Paseo Bridge</h1>
          <p>Local, authenticated access to sanitized AI usage data for Paseo.</p>
        </div>
        <span className={`bridge-window-status ${bridge.running ? "running" : bridge.error ? "error" : "idle"}`}>
          {statusLabel(bridge)}
        </span>
      </header>

      {!bridge.enabled ? (
        <div className="bridge-window-warning">The Paseo Bridge is disabled. Return to Settings in the main app to turn it on.</div>
      ) : null}
      {bridge.error ? <div className="error-panel">{bridge.error}</div> : null}
      {error ? <div className="error-panel" role="alert">{error}</div> : null}
      <div aria-live="polite" aria-atomic="true" className="sr-only">{copiedKey ? "Copied!" : ""}</div>

      <section className="bridge-detail-card">
        <div className="bridge-detail-row">
          <div><strong>Usage endpoint</strong><small>Authenticated usage data for Paseo.</small></div>
          <div className="bridge-detail-value"><code>{bridge.endpoint}</code><CopyButton copied={copiedKey === "endpoint"} onClick={() => void copy(bridge.endpoint, "endpoint")} /></div>
        </div>
        <div className="bridge-detail-row">
          <div><strong>Health endpoint</strong><small>Confirms that the local bridge listener is available.</small></div>
          <div className="bridge-detail-value"><code>{healthEndpoint}</code><CopyButton copied={copiedKey === "health"} onClick={() => void copy(healthEndpoint, "health")} /></div>
        </div>
        <div className="bridge-detail-row">
          <div><strong>Bearer token</strong><small>Required in the Authorization header for usage requests. Hidden by default.</small></div>
          <div className={`bridge-detail-value bridge-token-value${revealed ? " is-revealed" : ""}`}><code>{displayToken}</code>{revealed ? (<button type="button" className="button primary settings-update-action" onClick={() => setRevealed(false)}><EyeOffIcon className="settings-update-action-icon" /><span>Hide</span></button>) : (<button type="button" className="button primary settings-update-action" onClick={() => void reveal()}><EyeIcon className="settings-update-action-icon" /><span>Reveal</span></button>)}<CopyButton copied={copiedKey === "token"} onClick={() => void copyToken()} /></div>
        </div>
        <div className="bridge-detail-row">
          <div><strong>Rotate token</strong><small>Existing Paseo configuration stops working until its token is replaced.</small></div>
          <button type="button" className="button primary settings-update-action" disabled={busy || !bridge.enabled} onClick={() => void rotateToken()}><RefreshIcon className="settings-update-action-icon" /><span>{busy ? "Rotating…" : "Regenerate"}</span></button>
        </div>
      </section>

      <section className="bridge-config-card">
        <div className="bridge-config-heading">
          <div><strong>Environment configuration</strong><small>Add these values to Paseo's external provider-usage adapter.</small></div>
          <CopyButton label="Copy All" copied={copiedKey === "env"} onClick={() => void copyEnv()} />
        </div>
        <pre>{environment}</pre>
      </section>

      <section className="bridge-security-card">
        <strong>Connection details</strong>
        <ul>
          <li>Listens only on <code>127.0.0.1:47831</code>.</li>
          <li>Usage route: <code>/v1/paseo-usage</code>.</li>
          <li>Health route: <code>/v1/health</code> (same bearer token as usage).</li>
          <li>Authenticated requests are limited to one per second. Extra requests return <code>429</code> with <code>Retry-After: 1</code>.</li>
          <li>Schema version: <code>1</code>.</li>
          <li>Provider credentials are never returned by the bridge.</li>
        </ul>
      </section>
    </div>
  );
}

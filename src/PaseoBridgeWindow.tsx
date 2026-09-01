import { useCallback, useEffect, useMemo, useState } from "react";
import { bridgeApi } from "./api";
import type { BridgeInfo } from "./types";

const DETAILS_REFRESH_MS = 2_000;

function statusLabel(bridge: BridgeInfo): string {
  if (!bridge.enabled) return "Disabled";
  if (bridge.running) return "Running";
  if (bridge.error) return "Needs attention";
  return "Starting";
}

export function PaseoBridgeWindow() {
  const [bridge, setBridge] = useState<BridgeInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);

  const load = useCallback(async () => {
    try {
      const next = await bridgeApi.bridgeInfo();
      setBridge(next);
      setError(null);
    } catch (cause) {
      setError(String(cause));
    }
  }, []);

  useEffect(() => {
    void load();
    const interval = window.setInterval(() => void load(), DETAILS_REFRESH_MS);
    return () => window.clearInterval(interval);
  }, [load]);

  const healthEndpoint = useMemo(
    () => bridge?.endpoint.replace(/\/v1\/paseo-usage$/, "/v1/health") ?? "",
    [bridge?.endpoint],
  );
  const environment = bridge
    ? `PASEO_EXTERNAL_PROVIDER_USAGE_URL=${bridge.endpoint}\nPASEO_EXTERNAL_PROVIDER_USAGE_TOKEN=${bridge.token}`
    : "";

  const maskedToken = useMemo(() => {
    if (!bridge?.token) return "";
    if (bridge.token.length <= 8) return "•".repeat(bridge.token.length);
    return `${bridge.token.slice(0, 4)}${"•".repeat(Math.max(12, bridge.token.length - 8))}${bridge.token.slice(-4)}`;
  }, [bridge?.token]);

  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setError(null);
    } catch (cause) {
      setError(`Unable to copy: ${String(cause)}`);
    }
  };

  const rotateToken = async () => {
    setBusy(true);
    try {
      const next = await bridgeApi.regenerateToken();
      setBridge(next);
      setRevealed(false);
      setError(null);
    } catch (cause) {
      setError(String(cause));
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
          <span className="eyebrow">Integration details</span>
          <h1>Paseo Bridge</h1>
          <p>Local, authenticated access to sanitized AI usage data for Paseo.</p>
        </div>
        <span className={`bridge-window-status ${bridge.running ? "running" : bridge.error ? "error" : "idle"}`}>
          {statusLabel(bridge)}
        </span>
      </header>

      {!bridge.enabled ? (
        <div className="bridge-window-warning">The Paseo Bridge is disabled. Return to Integrations in the main app to turn it on.</div>
      ) : null}
      {bridge.error ? <div className="error-panel">{bridge.error}</div> : null}
      {error ? <div className="error-panel">{error}</div> : null}

      <section className="bridge-detail-card">
        <div className="bridge-detail-row">
          <div><strong>Usage endpoint</strong><small>Authenticated usage data for Paseo.</small></div>
          <div className="bridge-detail-value"><code>{bridge.endpoint}</code><button className="button ghost" onClick={() => void copy(bridge.endpoint)}>Copy</button></div>
        </div>
        <div className="bridge-detail-row">
          <div><strong>Health endpoint</strong><small>Confirms that the local bridge listener is available.</small></div>
          <div className="bridge-detail-value"><code>{healthEndpoint}</code><button className="button ghost" onClick={() => void copy(healthEndpoint)}>Copy</button></div>
        </div>
        <div className="bridge-detail-row">
          <div><strong>Bearer token</strong><small>Required in the Authorization header for usage requests. Hidden by default.</small></div>
          <div className="bridge-detail-value bridge-token-value"><code>{revealed ? bridge.token : maskedToken}</code><button className="button ghost" onClick={() => setRevealed((v) => !v)}>{revealed ? "Hide" : "Reveal"}</button><button className="button ghost" onClick={() => void copy(bridge.token)}>Copy</button></div>
        </div>
        <div className="bridge-detail-row">
          <div><strong>Rotate token</strong><small>Existing Paseo configuration stops working until its token is replaced.</small></div>
          <button className="button ghost" disabled={busy || !bridge.enabled} onClick={() => void rotateToken()}>{busy ? "Rotating…" : "Regenerate"}</button>
        </div>
      </section>

      <section className="bridge-config-card">
        <div className="bridge-config-heading">
          <div><strong>Environment configuration</strong><small>Add these values to Paseo's external provider-usage adapter.</small></div>
          <button className="button ghost" onClick={() => void copy(environment)}>Copy all</button>
        </div>
        <pre>{revealed ? environment : environment.replace(bridge.token, maskedToken)}</pre>
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

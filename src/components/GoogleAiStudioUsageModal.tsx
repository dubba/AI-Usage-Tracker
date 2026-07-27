import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { bridgeApi } from "../api";
import type { Account, LoginStatus } from "../types";

function savedProjectId(account: Account | null): string {
  const value = account?.providerAccountId ?? "";
  return value.startsWith("google-ai-studio-project:")
    ? value.slice("google-ai-studio-project:".length)
    : "";
}

export function GoogleAiStudioUsageModal({
  account,
  onClose,
  onConnected,
}: {
  account: Account | null;
  onClose: () => void;
  onConnected: (account: Account) => void;
}) {
  const [projectId, setProjectId] = useState("");
  const [status, setStatus] = useState<LoginStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setProjectId(savedProjectId(account));
    setStatus(null);
    setBusy(false);
    setError(null);
  }, [account]);

  useEffect(() => {
    if (!status || status.status !== "waiting") return;
    const timer = window.setInterval(async () => {
      try {
        const next = await bridgeApi.loginStatus(status.attemptId);
        setStatus(next);
        if (next.status === "complete" && next.account) {
          window.clearInterval(timer);
          onConnected(next.account);
        } else if (next.status === "failed") {
          window.clearInterval(timer);
          setBusy(false);
          setError(next.message ?? "Google Cloud usage authorization failed.");
        }
      } catch (cause) {
        window.clearInterval(timer);
        setBusy(false);
        setError(String(cause));
      }
    }, 900);
    return () => window.clearInterval(timer);
  }, [status, onConnected]);

  if (!account) return null;

  const connect = async () => {
    if (!projectId.trim()) {
      setError("Enter the Google Cloud project ID associated with this AI Studio API key.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const start = await bridgeApi.startGoogleAiStudioUsageLogin(account.id, projectId.trim());
      setStatus({
        attemptId: start.attemptId,
        status: "waiting",
        message: "Authorize read-only Cloud Monitoring access in your browser.",
        account: null,
      });
      await openUrl(start.authorizationUrl);
    } catch (cause) {
      setBusy(false);
      setError(String(cause));
    }
  };

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}>
      <section className="modal-card google-cloud-usage-modal" role="dialog" aria-modal="true" aria-labelledby="google-cloud-usage-title">
        <div className="modal-kicker">Google AI Studio quota usage</div>
        <h2 id="google-cloud-usage-title">Connect Google Cloud Usage</h2>
        <p>Authorize read-only Cloud Monitoring access to the project that owns this API key. The API key remains responsible only for model discovery.</p>

        <label className="field-label" htmlFor="google-cloud-project-id">Google Cloud project ID</label>
        <input
          id="google-cloud-project-id"
          className="text-input"
          value={projectId}
          onChange={(event) => {
            setProjectId(event.target.value.toLowerCase());
            setError(null);
          }}
          placeholder="example-project-123"
          autoComplete="off"
          spellCheck={false}
          disabled={busy}
          autoFocus
        />
        <div className="credential-note">Use the project ID, not its display name or numeric project number. The Google account must be able to view Cloud Monitoring data for this project.</div>

        <div className="guided-login-card google-cloud-scope-card">
          <strong>Read-only access</strong>
          <p>The authorization requests the <code>monitoring.read</code> scope. It cannot create resources, change quotas, or make Gemini requests.</p>
        </div>

        {status?.status === "waiting" ? <div className="login-status"><span className="spinner" />Waiting for Google authorization…</div> : null}
        {error ? <div className="error-panel modal-error">{error}</div> : null}
        <div className="modal-actions">
          <button className="button ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="button primary" onClick={() => void connect()} disabled={busy || !projectId.trim()}>
            {busy ? "Waiting for Google…" : "Connect Google Cloud Usage"}
          </button>
        </div>
      </section>
    </div>
  );
}

import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { bridgeApi } from "../api";
import type { Account, LoginStatus } from "../types";

type CloudProjectOption = {
  projectId: string;
  projectNumber: string;
  displayName: string;
};

type CloudSetupMessage = {
  projects: CloudProjectOption[];
  selectedProjectId: string | null;
};

type SetupStage = "signin" | "choose_project" | "monitoring_disabled";

const GOOGLE_CLOUD_AUTH_SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/cloud-platform",
].join(" ");

function compatibleGoogleAuthorizationUrl(value: string): string {
  const url = new URL(value);
  url.searchParams.set("scope", GOOGLE_CLOUD_AUTH_SCOPES);
  return url.toString();
}

function parseSetupMessage(message: string | null): CloudSetupMessage | null {
  if (!message) return null;
  try {
    const value = JSON.parse(message) as Partial<CloudSetupMessage>;
    if (!Array.isArray(value.projects)) return null;
    const projects = value.projects.filter((project): project is CloudProjectOption =>
      Boolean(project)
      && typeof project.projectId === "string"
      && typeof project.projectNumber === "string"
      && typeof project.displayName === "string",
    );
    return {
      projects,
      selectedProjectId: typeof value.selectedProjectId === "string" ? value.selectedProjectId : null,
    };
  } catch {
    return null;
  }
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
  const [status, setStatus] = useState<LoginStatus | null>(null);
  const [stage, setStage] = useState<SetupStage>("signin");
  const [projects, setProjects] = useState<CloudProjectOption[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setStatus(null);
    setStage("signin");
    setProjects([]);
    setSelectedProjectId("");
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
          setBusy(false);
          onConnected(next.account);
          return;
        }
        if (next.status === "failed") {
          window.clearInterval(timer);
          setBusy(false);
          setError(next.message ?? "Google usage connection failed.");
          return;
        }
        if (next.status === "choose_project" || next.status === "monitoring_disabled") {
          window.clearInterval(timer);
          setBusy(false);
          const setup = parseSetupMessage(next.message);
          if (!setup || !setup.projects.length) {
            setError("Google sign-in succeeded, but the project information could not be read.");
            return;
          }
          setProjects(setup.projects);
          setSelectedProjectId(setup.selectedProjectId ?? setup.projects[0].projectId);
          setStage(next.status);
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

  const start = async (projectId = "") => {
    setBusy(true);
    setError(null);
    try {
      const next = await bridgeApi.startGoogleAiStudioUsageLogin(account.id, projectId);
      setStatus({
        attemptId: next.attemptId,
        status: "waiting",
        message: null,
        account: null,
      });
      if (next.authorizationUrl) {
        await openUrl(compatibleGoogleAuthorizationUrl(next.authorizationUrl));
      }
    } catch (cause) {
      setBusy(false);
      setError(String(cause));
    }
  };

  const selectedProject = projects.find((project) => project.projectId === selectedProjectId) ?? null;

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}>
      <section className="modal-card google-cloud-usage-modal" role="dialog" aria-modal="true" aria-labelledby="google-cloud-usage-title">
        <div className="modal-kicker">Google AI Studio quota usage</div>
        <h2 id="google-cloud-usage-title">
          {stage === "choose_project" ? "Choose the API key project" : stage === "monitoring_disabled" ? "Enable Cloud Monitoring" : "Connect Google Usage"}
        </h2>

        {stage === "signin" ? (
          <>
            <p>Sign in once. The app will find the Google Cloud project that owns this API key and connect its reported Gemini quota usage automatically.</p>
            <div className="guided-login-card google-cloud-scope-card">
              <strong>Automatic Google Cloud setup</strong>
              <p>Google grants Cloud access to complete setup. The app uses it only to find the API key project, inspect or read Cloud Monitoring, and enable Monitoring when you explicitly approve that action. It does not change billing, quotas, IAM roles, or other services.</p>
            </div>
          </>
        ) : null}

        {stage === "choose_project" ? (
          <>
            <p>Google could not identify the API key’s project automatically. Choose it from the projects available to this Google account.</p>
            <label className="field-label" htmlFor="google-cloud-project-choice">Google Cloud project</label>
            <select
              id="google-cloud-project-choice"
              className="text-input"
              value={selectedProjectId}
              onChange={(event) => {
                setSelectedProjectId(event.target.value);
                setError(null);
              }}
              disabled={busy}
            >
              {projects.map((project) => (
                <option key={project.projectId} value={project.projectId}>
                  {project.displayName} ({project.projectId})
                </option>
              ))}
            </select>
            <div className="credential-note">Only projects this Google account can view are shown.</div>
          </>
        ) : null}

        {stage === "monitoring_disabled" ? (
          <>
            <p>
              The app found <strong>{selectedProject?.displayName ?? selectedProjectId}</strong>, but Cloud Monitoring is disabled for it.
            </p>
            <div className="guided-login-card google-cloud-scope-card">
              <strong>Confirm the one-time action</strong>
              <p>Clicking Enable authorizes the app to turn on Cloud Monitoring for this project. The app does not change quotas, billing, IAM roles, or other services.</p>
            </div>
          </>
        ) : null}

        {status?.status === "waiting" ? (
          <div className="login-status"><span className="spinner" />Waiting for Google…</div>
        ) : null}
        {error ? <div className="error-panel modal-error">{error}</div> : null}

        <div className="modal-actions">
          <button className="button ghost" onClick={onClose} disabled={busy}>Cancel</button>
          {stage === "signin" ? (
            <button className="button primary" onClick={() => void start()} disabled={busy}>
              {busy ? "Waiting for Google…" : "Sign in with Google"}
            </button>
          ) : null}
          {stage === "choose_project" ? (
            <button className="button primary" onClick={() => void start(selectedProjectId)} disabled={busy || !selectedProjectId}>
              {busy ? "Checking project…" : "Connect This Project"}
            </button>
          ) : null}
          {stage === "monitoring_disabled" ? (
            <button className="button primary" onClick={() => void start(`enable:${selectedProjectId}`)} disabled={busy || !selectedProjectId}>
              {busy ? "Waiting for Google…" : "Enable Cloud Monitoring"}
            </button>
          ) : null}
        </div>
      </section>
    </div>
  );
}

import { useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { bridgeApi, clearLoginAttempt, readLoginAttempt, rememberLoginAttempt } from "../api";
import type { Account, CloudProjectOption, LoginStatus } from "../types";

type SetupStage = "signin" | "choose_project" | "monitoring_disabled";

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
  const closeRequestedRef = useRef(false);

  useEffect(() => {
    closeRequestedRef.current = account == null;
    setStatus(null);
    setStage("signin");
    setProjects([]);
    setSelectedProjectId("");
    setBusy(false);
    setError(null);
    if (!account) return;
    const attemptId = readLoginAttempt();
    if (!attemptId) return;
    void bridgeApi.loginStatus(attemptId).then((next) => {
      if (closeRequestedRef.current) return;
      if (next.status === "choose_project" || next.status === "monitoring_disabled") {
        setStatus(next);
        setProjects(next.projects ?? []);
        setSelectedProjectId(next.selectedProjectId ?? next.projects?.[0]?.projectId ?? "");
        setStage(next.status);
      }
    }).catch(() => undefined);
  }, [account]);

  useEffect(() => {
    if (!status || status.status !== "waiting") return;
    const timer = window.setInterval(async () => {
      try {
        const next = await bridgeApi.loginStatus(status.attemptId);
        if (closeRequestedRef.current) return;
        setStatus(next);
        if (next.status === "complete" && next.account) {
          window.clearInterval(timer);
          clearLoginAttempt();
          setBusy(false);
          onConnected(next.account);
          return;
        }
        if (next.status === "failed") {
          window.clearInterval(timer);
          clearLoginAttempt();
          setBusy(false);
          setError(next.message ?? "Google usage connection failed.");
          return;
        }
        if (next.status === "choose_project" || next.status === "monitoring_disabled") {
          window.clearInterval(timer);
          setBusy(false);
          if (!next.projects?.length) {
            setError("Google sign-in succeeded, but the project information could not be read.");
            return;
          }
          setProjects(next.projects);
          setSelectedProjectId(next.selectedProjectId ?? next.projects[0].projectId);
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

  const closeModal = () => {
    closeRequestedRef.current = true;
    const attemptId = status?.attemptId;
    setStatus(null);
    setBusy(false);
    if (attemptId) {
      clearLoginAttempt();
      void bridgeApi.cancelLogin(attemptId);
    }
    onClose();
  };

  if (!account) return null;

  const start = async (projectId = "", enableMonitoring = false) => {
    setBusy(true);
    setError(null);
    try {
      const next = await bridgeApi.startGoogleAiStudioUsageLogin(account.id, projectId, enableMonitoring);
      if (closeRequestedRef.current) {
        await bridgeApi.cancelLogin(next.attemptId).catch(() => undefined);
        return;
      }
      rememberLoginAttempt(next.attemptId);
      setStatus({
        attemptId: next.attemptId,
        status: "waiting",
        message: null,
        account: null,
        projects: null,
        selectedProjectId: null,
      });
      if (next.authorizationUrl) {
        await openUrl(next.authorizationUrl);
      }
    } catch (cause) {
      if (!closeRequestedRef.current) {
        setBusy(false);
        setError(String(cause));
      }
    }
  };

  const selectedProject = projects.find((project) => project.projectId === selectedProjectId) ?? null;

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && closeModal()}>
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
          <button className="button ghost" onClick={closeModal}>Cancel</button>
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
            <button className="button primary" onClick={() => void start(selectedProjectId, true)} disabled={busy || !selectedProjectId}>
              {busy ? "Waiting for Google…" : "Enable Cloud Monitoring"}
            </button>
          ) : null}
        </div>
      </section>
    </div>
  );
}

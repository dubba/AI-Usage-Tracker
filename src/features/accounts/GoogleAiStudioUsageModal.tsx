import { useEffect, useRef, useState } from "react";
import { openSafeUrl } from "../../shared/lib/safeUrl";
import { bridgeApi, readLoginAttempt } from "../../shared/lib/api";
import { useAsyncAction } from "../../shared/hooks/useAsyncAction";
import { getLastLoginStatus, watchLoginAttempt } from "../../shared/lib/login-status";
import { useLoginAttempt, waitingStatus } from "../../shared/hooks/useLoginAttempt";
import type { Account, CloudProjectOption } from "../../types";
import { CustomDropdown } from "../../shared/ui/CustomDropdown";
import { useAutoDismissedError } from "../../shared/hooks/useAutoDismissedError";
import { useModalA11y } from "../../shared/hooks/useModalA11y";
import { useEscapeOrClosePolicy } from "../../shared/hooks/useModalClosePolicy";

import { ModalDialog } from "../../shared/ui/ModalDialog";

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
  const [stage, setStage] = useState<SetupStage>("signin");
  const [projects, setProjects] = useState<CloudProjectOption[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const { error, setError } = useAutoDismissedError(account?.id);
  const { busy, setBusy, run } = useAsyncAction({ source: "google-ai-studio", setError });
  const dialogRef = useRef<HTMLElement>(null);
  const { status, setStatus, attemptIdRef, closeRequestedRef, adopt, retry: retryAttempt, abandon } = useLoginAttempt({
    active: account != null,
    onStatus: (next) => {
      if (next.status === "complete" && next.account) {
        setBusy(false);
        onConnected(next.account);
        return;
      }
      if (next.status === "failed") {
        setBusy(false);
        setError(next.message ?? "Google usage connection failed.");
        return;
      }
      if (next.status === "choose_project" || next.status === "monitoring_disabled") {
        setBusy(false);
        if (!next.projects?.length) {
          setError("Google sign-in succeeded, but the project information could not be read.");
          return;
        }
        setProjects(next.projects);
        setSelectedProjectId(next.selectedProjectId ?? next.projects[0].projectId);
        setStage(next.status);
      }
    },
  });

  useEffect(() => {
    setStatus(null);
    setStage("signin");
    setProjects([]);
    setSelectedProjectId("");
    setBusy(false);
    setError(null);
    if (!account) return;
    const last = getLastLoginStatus();
    if (last && (last.status === "choose_project" || last.status === "monitoring_disabled")) {
      attemptIdRef.current = last.attemptId;
      setStatus(last);
      setProjects(last.projects ?? []);
      setSelectedProjectId(last.selectedProjectId ?? last.projects?.[0]?.projectId ?? "");
      setStage(last.status);
    }
    const attemptId = readLoginAttempt();
    if (attemptId) {
      attemptIdRef.current = attemptId;
      watchLoginAttempt(attemptId);
    }
  }, [account, setError, setBusy, setStatus, attemptIdRef]);

  const closeModal = () => {
    abandon();
    setBusy(false);
    onClose();
  };

  const handleEscape = useEscapeOrClosePolicy(Boolean(error), () => setError(null), closeModal);
  useModalA11y(dialogRef, account != null, handleEscape);

  if (!account) return null;

  const start = async (projectId = "", enableMonitoring = false) => {
    // Busy stays on after a successful start: the backend reports the result through the poll.
    await run(
      async () => {
        const next = await bridgeApi.startGoogleAiStudioUsageLogin(account.id, projectId, enableMonitoring);
        if (!(await adopt(next.attemptId, waitingStatus(next.attemptId, null)))) return;
        if (next.authorizationUrl) {
          await openSafeUrl(next.authorizationUrl);
        }
      },
      "Couldn't start the Google Cloud connection",
      { keepBusyOnSuccess: true, isCurrent: () => !closeRequestedRef.current },
    );
  };

  const retry = () => {
    const resumed = retryAttempt((attemptId) =>
      waitingStatus(attemptId, "Reconnecting to Google…", {
        projects: status?.projects ?? projects,
        selectedProjectId: selectedProjectId || null,
      }),
    );
    if (resumed) {
      setError(null);
      setBusy(true);
      return;
    }
    if (stage === "choose_project") {
      void start(selectedProjectId);
      return;
    }
    if (stage === "monitoring_disabled") {
      void start(selectedProjectId, true);
      return;
    }
    void start();
  };

  const selectedProject = projects.find((project) => project.projectId === selectedProjectId) ?? null;

  return (
    <ModalDialog dialogRef={dialogRef} labelledBy="google-cloud-usage-title" className="google-cloud-usage-modal" onClose={closeModal}>
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
          <CustomDropdown<string>
            id="google-cloud-project-choice"
            aria-label="Google Cloud project"
            value={selectedProjectId}
            options={projects.map((project) => ({
              value: project.projectId,
              label: project.displayName,
              detail: project.projectId,
            }))}
            onChange={(projectId) => {
              setSelectedProjectId(projectId);
              setError(null);
            }}
            disabled={busy}
          />
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
      <div className="modal-actions">
        <button type="button" className="button ghost" onClick={closeModal}>Cancel</button>
        {status?.status === "failed" ? (
          <button type="button" className="button primary" onClick={retry} disabled={busy}>
            Retry
          </button>
        ) : null}
        {status?.status !== "failed" && stage === "signin" ? (
          <button type="button" className="button primary" onClick={() => void start()} disabled={busy}>
            {busy ? "Waiting for Google…" : "Sign In with Google"}
          </button>
        ) : null}
        {status?.status !== "failed" && stage === "choose_project" ? (
          <button type="button" className="button primary" onClick={() => void start(selectedProjectId)} disabled={busy || !selectedProjectId}>
            {busy ? "Checking Project…" : "Connect This Project"}
          </button>
        ) : null}
        {status?.status !== "failed" && stage === "monitoring_disabled" ? (
          <button type="button" className="button primary" onClick={() => void start(selectedProjectId, true)} disabled={busy || !selectedProjectId}>
            {busy ? "Waiting for Google…" : "Enable Cloud Monitoring"}
          </button>
        ) : null}
      </div>
      {error ? <div className="error-panel modal-error" role="alert">{error}</div> : null}
    </ModalDialog>
  );
}

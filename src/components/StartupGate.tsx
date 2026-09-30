import { useCallback, useEffect, useState, type ReactNode } from "react";
import { loadStartupIssue, retryStartup } from "../startup";
import { CopyDiagnosticsButton } from "./CopyDiagnosticsButton";
import type { StartupIssue } from "../types";
import "../startup-gate.css";

type GateState =
  | { phase: "checking" }
  | { phase: "ready" }
  | { phase: "failed"; issue: StartupIssue; retrying: boolean };

/**
 * Shows what went wrong (with a Retry button) when the backend could not start,
 * instead of a dashboard whose every request fails.
 */
export function StartupGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<GateState>({ phase: "checking" });

  useEffect(() => {
    let cancelled = false;
    void loadStartupIssue().then((issue) => {
      if (!cancelled) setState(issue ? { phase: "failed", issue, retrying: false } : { phase: "ready" });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const retry = useCallback(async () => {
    setState((current) => (current.phase === "failed" ? { ...current, retrying: true } : current));
    const issue = await retryStartup();
    setState(issue ? { phase: "failed", issue, retrying: false } : { phase: "ready" });
  }, []);

  if (state.phase === "checking") return null;
  if (state.phase === "ready") return <>{children}</>;

  return (
    <main className="startup-gate" role="alert" aria-labelledby="startup-gate-title">
      <div className="startup-gate-card">
        <h1 id="startup-gate-title">AI Usage Tracker couldn't start</h1>
        <p className="startup-gate-message">{state.issue.message}</p>
        {state.issue.dataDir ? (
          <p className="startup-gate-path">
            Saved data folder: <code>{state.issue.dataDir}</code>
          </p>
        ) : null}
        <div className="startup-gate-actions">
          <button type="button" className="startup-gate-retry" onClick={() => void retry()} disabled={state.retrying}>
            {state.retrying ? "Retrying…" : "Try again"}
          </button>
          <CopyDiagnosticsButton className="startup-gate-secondary" />
        </div>
      </div>
    </main>
  );
}

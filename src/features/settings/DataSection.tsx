import { useEffect, useRef, useState } from "react";
import { bridgeApi } from "../../shared/lib/api";
import { errorMessage } from "../../shared/lib/errors";
import { CheckIcon, HistoryResetIcon, TrashIcon } from "../../shared/ui/icons";
import { ConfirmDialog } from "../../shared/ui/ConfirmDialog";
import { CopyDiagnosticsButton } from "./CopyDiagnosticsButton";

type ClearState = "idle" | "clearing" | "cleared";

/**
 * One click that runs `action` and says so: idle, clearing, then cleared for a moment. A failure
 * goes to `onFailure` (and `null` when a new attempt starts).
 */
function useClearAction(
  action: () => Promise<void>,
  failureText: string,
  onFailure: (message: string | null) => void,
) {
  const [state, setState] = useState<ClearState>("idle");
  const resetTimer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
    },
    [],
  );

  const run = async () => {
    setState("clearing");
    onFailure(null);
    try {
      await action();
      setState("cleared");
      resetTimer.current = window.setTimeout(() => setState("idle"), 2500);
    } catch (cause) {
      onFailure(`${failureText}: ${errorMessage(cause)}`);
      setState("idle");
    }
  };
  return [state, run] as const;
}

/**
 * Diagnostics, clearing the usage history, and deleting everything the app keeps on this device.
 *
 * Clearing the usage history discards only the recorded daily bars (accounts and sign-ins stay),
 * and runs on one click. Deleting signs out every account and cannot be undone, so it asks first,
 * naming what goes and what does not.
 */
export function DataSection({
  onAllDataDeleted,
}: {
  /** Runs once everything is deleted; the app reloads itself so no screen keeps showing removed data. */
  onAllDataDeleted: () => void;
}) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const [historyState, clearHistory] = useClearAction(
    () => bridgeApi.clearActivityHistory(),
    "Couldn't clear usage history",
    setFailure,
  );

  const deleteEverything = async () => {
    setDeleting(true);
    setFailure(null);
    try {
      await bridgeApi.deleteAllLocalData();
      onAllDataDeleted();
    } catch (cause) {
      setFailure(`Couldn't delete local data: ${errorMessage(cause)}`);
      setDeleting(false);
      setConfirmingDelete(false);
    }
  };

  return (
    <>
      <section className="settings-card">
        <h2 id="settings-section-data" className="settings-card-heading">Data &amp; Diagnostics</h2>
        <div className="settings-row">
          <div>
            <strong>Diagnostics</strong>
            <small>Bug report with tokens, cookies, and emails removed.</small>
          </div>
          <CopyDiagnosticsButton compact className="button ghost settings-changelog-button settings-update-action" />
        </div>
        <div className="settings-row">
          <div>
            <strong>Clear Usage History</strong>
            <small>Deletes your Usage chart history and restarts tracking. Accounts remain unchanged.</small>
          </div>
          <button
            type="button"
            className="button ghost settings-changelog-button settings-update-action"
            aria-label="Clear usage history"
            disabled={historyState === "clearing"}
            onClick={() => void clearHistory()}
          >
            {historyState === "cleared" ? (
              <CheckIcon className="settings-update-action-icon" />
            ) : (
              <HistoryResetIcon className="settings-update-action-icon" />
            )}
            <span>{historyState === "clearing" ? "Clearing…" : historyState === "cleared" ? "Cleared!" : "Clear"}</span>
          </button>
        </div>
        <div className="settings-row">
          <div>
            <strong className="settings-danger-title">Delete Local App Data</strong>
            <small>Remove all accounts, usage history, and settings from this device.</small>
          </div>
          <button
            type="button"
            className="button ghost bucket-delete-button settings-update-action"
            disabled={deleting}
            onClick={() => setConfirmingDelete(true)}
          >
            <TrashIcon className="settings-update-action-icon" />
            <span>Delete</span>
          </button>
        </div>
      </section>
      <span className="sr-only" role="status" aria-live="polite">
        {historyState === "cleared" ? "Usage history cleared." : ""}
      </span>
      {failure ? (
        <p className="settings-data-error" role="alert">
          {failure}
        </p>
      ) : null}
      <ConfirmDialog
        open={confirmingDelete}
        kicker="Delete local app data"
        title="Delete local app data?"
        body="Removes every account and its saved sign-in, usage snapshots, usage history, groups, alert settings, and app settings from this device, and replaces the local API token. Your provider accounts are not canceled, other linked devices keep their own copies, and this can't be undone."
        confirmLabel="Delete Everything"
        busyLabel="Deleting…"
        busy={deleting}
        onConfirm={() => void deleteEverything()}
        onCancel={() => setConfirmingDelete(false)}
      />
    </>
  );
}

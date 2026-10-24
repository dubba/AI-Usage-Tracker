import { useEffect, useRef, useState } from "react";
import { bridgeApi } from "../../shared/lib/api";
import { errorMessage } from "../../shared/lib/errors";
import { CheckIcon, TrashIcon } from "../../shared/ui/icons";
import { ConfirmDialog } from "../../shared/ui/ConfirmDialog";

type ClearState = "idle" | "clearing" | "cleared";

/**
 * Clearing cached usage and deleting everything the app keeps on this device.
 *
 * Clearing is harmless (usage is fetched again straight away), so it runs on one click. Deleting
 * signs out every account and cannot be undone, so it asks first, naming what goes and what does not.
 */
export function DataSection({
  onUsageCleared,
  onAllDataDeleted,
}: {
  /** Runs once the saved usage is gone: the app reloads the dashboard and fetches fresh usage. */
  onUsageCleared: () => void | Promise<void>;
  /** Runs once everything is deleted; the app reloads itself so no screen keeps showing removed data. */
  onAllDataDeleted: () => void;
}) {
  const [clearState, setClearState] = useState<ClearState>("idle");
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const resetTimer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
    },
    [],
  );

  const clearUsage = async () => {
    setClearState("clearing");
    setFailure(null);
    try {
      await bridgeApi.clearCachedUsage();
      await onUsageCleared();
      setClearState("cleared");
      resetTimer.current = window.setTimeout(() => setClearState("idle"), 2500);
    } catch (cause) {
      setFailure(`Couldn't clear cached usage: ${errorMessage(cause)}`);
      setClearState("idle");
    }
  };

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
      <h2 className="settings-section-title">Data</h2>
      <section className="settings-card">
        <div className="settings-row">
          <div>
            <strong>Clear Cached Usage</strong>
            <small>Removes stored usage snapshots but keeps your accounts. Fresh usage loads right away.</small>
          </div>
          <button
            type="button"
            className="button ghost settings-changelog-button"
            disabled={clearState === "clearing"}
            onClick={() => void clearUsage()}
          >
            <span>{clearState === "clearing" ? "Clearing…" : clearState === "cleared" ? "Cleared!" : "Clear"}</span>
            {clearState === "cleared" ? <CheckIcon /> : null}
          </button>
        </div>
        <div className="settings-row">
          <div>
            <strong className="settings-danger-title">Delete All Local Data</strong>
            <small>Removes accounts, saved sign-ins, usage snapshots, and settings from this device.</small>
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
        {clearState === "cleared" ? "Cached usage cleared." : ""}
      </span>
      {failure ? (
        <p className="settings-data-error" role="alert">
          {failure}
        </p>
      ) : null}
      <ConfirmDialog
        open={confirmingDelete}
        kicker="Delete all local data"
        title="Delete all local data?"
        body="Removes every account and its saved sign-in, usage snapshots, groups, alert settings, and app settings from this device, and replaces the local API token. Your provider accounts are not canceled, other linked devices keep their own copies, and this can't be undone."
        confirmLabel="Delete Everything"
        busyLabel="Deleting…"
        busy={deleting}
        onConfirm={() => void deleteEverything()}
        onCancel={() => setConfirmingDelete(false)}
      />
    </>
  );
}

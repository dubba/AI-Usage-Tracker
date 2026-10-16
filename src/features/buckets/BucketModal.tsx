import { useEffect, useMemo, useRef, useState } from "react";
import { bridgeApi } from "../../shared/lib/api";
import { errorMessage, friendlyMessage } from "../../shared/lib/errors";
import { TrashIcon } from "../../shared/ui/icons";
import { PROVIDER_META } from "../../shared/lib/providers";
import { ProviderIcon } from "../../shared/ui/ProviderIcon";
import type { Account, AccountBucket, Provider } from "../../types";
import { CustomDropdown } from "../../shared/ui/CustomDropdown";
import { useAutoDismissedError } from "../../shared/hooks/useAutoDismissedError";
import { useModalA11y } from "../../shared/hooks/useModalA11y";
import { backdropMouseDown, useModalClosePolicy } from "../../shared/hooks/useModalClosePolicy";
import { ModalCloseButton } from "../../shared/ui/ModalCloseButton";
import { ConfirmDialog } from "../../shared/ui/ConfirmDialog";
import { useVirtualKeyboard } from "../../shared/hooks/useVirtualKeyboard";

const ALL_PROVIDERS: { id: Provider; label: string }[] = (Object.keys(PROVIDER_META) as Provider[])
  .map((id) => ({ id, label: PROVIDER_META[id].name }))
  .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }));

export function BucketModal({
  open,
  bucket,
  initialConfirmDelete = false,
  accounts,
  onClose,
  onSaved,
  onDeleted,
}: {
  open: boolean;
  bucket: AccountBucket | null;
  initialProvider?: Provider | null;
  initialConfirmDelete?: boolean;
  accounts: Account[];
  onClose: () => void;
  onSaved: (bucket: AccountBucket) => void;
  onDeleted?: (bucketId: string) => void;
}) {
  const [name, setName] = useState("");
  const [selectedProvider, setSelectedProvider] = useState<Provider | "all">("all");
  const [selectedAccountIds, setSelectedAccountIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const { error, setError } = useAutoDismissedError(open);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  // The values shown when the dialog opened, for the unsaved-changes check.
  const [baseline, setBaseline] = useState({ name: "", provider: "all" as Provider | "all", accountIds: [] as string[] });
  const [isKeyboardOpen, setIsKeyboardOpen] = useVirtualKeyboard(open);
  const dialogRef = useRef<HTMLElement>(null);

  const handleClose = () => {
    setIsKeyboardOpen(false);
    document.documentElement.style.removeProperty("--visual-keyboard-height");
    onClose();
  };

  const sameIds = (a: string[], b: string[]) =>
    a.length === b.length && [...a].sort().join("") === [...b].sort().join("");
  const dirty =
    name !== baseline.name || selectedProvider !== baseline.provider || !sameIds(selectedAccountIds, baseline.accountIds);
  const nestedOpen = confirmingDelete || confirmingDiscard;

  // While busy nothing closes. Otherwise a clean form closes straight away; a
  // dirty form first asks whether to discard the unsaved changes.
  const requestClose = useModalClosePolicy(!busy, () => {
    if (dirty) {
      setConfirmingDiscard(true);
    } else {
      handleClose();
    }
  });
  const handleEscape = () => {
    if (error) {
      setError(null);
      return;
    }
    requestClose();
  };
  useModalA11y(dialogRef, open && !nestedOpen, handleEscape);

  useEffect(() => {
    if (open) {
      let initialName = "";
      let initialProviderChoice: Provider | "all";
      let initialIds: string[];
      if (bucket) {
        initialName = bucket.name;
        // Edit always starts unfiltered: a group whose accounts belong to one
        // provider must not hide every other provider from the picker. The
        // dropdown is a search aid, not a property of the group.
        initialProviderChoice = "all";
        initialIds = bucket.accountIds;
      } else {
        // Create always starts unfiltered, even if opened from a provider row.
        initialProviderChoice = "all";
        initialIds = [];
      }
      setName(initialName);
      setSelectedProvider(initialProviderChoice);
      setSelectedAccountIds(initialIds);
      setBaseline({ name: initialName, provider: initialProviderChoice, accountIds: initialIds });
      setError(null);
      setBusy(false);
      setConfirmingDiscard(false);
      setConfirmingDelete(Boolean(initialConfirmDelete && bucket));
    }
  }, [open, bucket, initialConfirmDelete, accounts, setError]);

  const filteredAccounts = useMemo(() => {
    if (selectedProvider === "all") return accounts;
    return accounts.filter((a) => a.provider === selectedProvider);
  }, [accounts, selectedProvider]);

  if (!open) return null;

  const toggleAccount = (id: string) => {
    setSelectedAccountIds((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id]
    );
  };

  const selectAllFiltered = () => {
    const ids = filteredAccounts.map((a) => a.id);
    const allSelected = ids.every((id) => selectedAccountIds.includes(id));
    if (allSelected) {
      setSelectedAccountIds((current) => current.filter((id) => !ids.includes(id)));
    } else {
      setSelectedAccountIds((current) => Array.from(new Set([...current, ...ids])));
    }
  };

  const handleSave = async (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Please enter a name for this group.");
      return;
    }

    // The saved provider comes only from the dropdown the user actually
    // touched ("all" stores null); it is no longer derived from membership,
    // so a single-account group does not pollute its own filter forever.
    const bucketProvider = selectedProvider === "all" ? null : selectedProvider;

    setBusy(true);
    setError(null);
    try {
      const saved = await bridgeApi.saveBucket(
        trimmed,
        bucketProvider,
        selectedAccountIds,
        bucket?.id
      );
      onSaved(saved);
    } catch (cause) {
      setError(friendlyMessage("Couldn't save this group", errorMessage(cause)));
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async () => {
    if (!bucket || !onDeleted) return;
    setBusy(true);
    setError(null);
    try {
      await bridgeApi.deleteBucket(bucket.id);
      onDeleted(bucket.id);
    } catch (cause) {
      setError(friendlyMessage("Couldn't delete this group", errorMessage(cause)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className={`modal-backdrop ${isKeyboardOpen ? "keyboard-open" : ""}`}
      role="presentation"
      onMouseDown={backdropMouseDown(requestClose)}
    >
      <section
        ref={dialogRef}
        className={`modal-card bucket-modal-card ${isKeyboardOpen ? "keyboard-open" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="bucket-modal-title"
        tabIndex={-1}
      >
        <ModalCloseButton onClose={requestClose} disabled={busy} />
        <div className="modal-kicker">Account Grouping</div>
        <h2 id="bucket-modal-title">{bucket ? "Edit Group" : "Create Group"}</h2>
        <p>Group accounts together in the sidebar to track their combined usage and limits. Groups can be empty.</p>

        <form onSubmit={handleSave} className="bucket-modal-form">
          <label className="field-group">
            <span className="field-label">Group Name</span>
            <input
              type="text"
              className="text-input"
              placeholder="e.g. Antigravity - Work or Grok Team A"
              value={name}
              autoFocus
              disabled={busy}
              onChange={(event) => setName(event.target.value)}
            />
          </label>

          <div className="field-group">
            <div className="bucket-account-heading">
              <span className="field-label">Select Accounts ({selectedAccountIds.length} selected)</span>
              <div className="bucket-filter-actions">
                <CustomDropdown<Provider | "all">
                  aria-label="Filter by provider"
                  value={selectedProvider}
                  disabled={busy}
                  options={[
                    { value: "all", label: "All Providers" },
                    ...ALL_PROVIDERS.map((item) => ({
                      value: item.id,
                      label: item.label,
                    })),
                  ]}
                  onChange={(val) => setSelectedProvider(val)}
                />
                <button type="button" className="button ghost compact-button" onClick={selectAllFiltered} disabled={busy || !filteredAccounts.length}>
                  {filteredAccounts.length && filteredAccounts.every((a) => selectedAccountIds.includes(a.id)) ? "Deselect All" : "Select All"}
                </button>
              </div>
            </div>

            <div className="bucket-account-picker-list">
              {filteredAccounts.length ? filteredAccounts.map((account) => {
                const isSelected = selectedAccountIds.includes(account.id);
                const sessionWindow = account.lastUsage?.windows[0];
                return (
                  <label key={account.id} className={`bucket-account-item ${isSelected ? "selected" : ""}`}>
                    <input
                      type="checkbox"
                      checked={isSelected}
                      disabled={busy}
                      onChange={() => toggleAccount(account.id)}
                    />
                    <span className={`bucket-account-provider-icon provider-${account.provider}`}>
                      <ProviderIcon provider={account.provider} />
                    </span>
                    <div className="bucket-account-info">
                      <strong className="bucket-account-label">{account.label}</strong>
                      <span className="bucket-account-email">{account.email ?? account.plan ?? account.provider}</span>
                    </div>
                    {sessionWindow?.remainingPercent != null ? (
                      <span className="bucket-account-percent">
                        {Math.round(sessionWindow.remainingPercent)}%
                      </span>
                    ) : null}
                  </label>
                );
              }) : (
                <div className="bucket-picker-empty">No accounts match the selected filter.</div>
              )}
            </div>
          </div>

          <footer className="modal-actions bucket-modal-actions">
            {bucket && onDeleted ? (
              <button
                type="button"
                className="button ghost bucket-delete-button"
                disabled={busy}
                onClick={() => setConfirmingDelete(true)}
              >
                <TrashIcon /> Delete Group
              </button>
            ) : null}
            <div className="bucket-modal-save-group">
              <button type="button" className="button ghost" disabled={busy} onClick={requestClose}>
                Cancel
              </button>
              <button type="submit" className="button primary" disabled={busy}>
                {busy ? "Saving…" : bucket ? "Save" : "Create Group"}
              </button>
            </div>
          </footer>

          {error ? <div className="error-panel modal-error modal-error-message" role="alert">{error}</div> : null}
        </form>
      </section>
      {bucket && onDeleted ? (
        <ConfirmDialog
          open={confirmingDelete}
          kicker="Delete group"
          title={<>Delete “{bucket.name}”?</>}
          body="Only the grouping is removed. The accounts stay connected and keep their own settings and alerts."
          confirmLabel="Delete Group"
          busyLabel="Deleting…"
          busy={busy}
          onConfirm={() => void handleDelete()}
          onCancel={() => setConfirmingDelete(false)}
        />
      ) : null}
      <ConfirmDialog
        open={confirmingDiscard}
        kicker="Unsaved changes"
        title="Discard changes?"
        body="Your changes to this group haven't been saved and will be lost."
        confirmLabel="Discard Changes"
        onConfirm={() => {
          setConfirmingDiscard(false);
          handleClose();
        }}
        onCancel={() => setConfirmingDiscard(false)}
      />
    </div>
  );
}

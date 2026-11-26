import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { bridgeApi } from "../../shared/lib/api";
import { useAsyncAction } from "../../shared/hooks/useAsyncAction";
import { AlertTriangleIcon, TrashIcon } from "../../shared/ui/icons";
import { PROVIDER_META } from "../../shared/lib/providers";
import { ProviderIcon } from "../../shared/ui/ProviderIcon";
import type { Account, AccountBucket, Provider } from "../../types";
import { CustomDropdown } from "../../shared/ui/CustomDropdown";
import { useScrollThumb } from "../../shared/hooks/useScrollThumb";
import { useDialogError } from "../../shared/hooks/useDialogError";
import { useModalA11y } from "../../shared/hooks/useModalA11y";
import { useModalClosePolicy, useEscapeOrClosePolicy } from "../../shared/hooks/useModalClosePolicy";
import { ModalDialog } from "../../shared/ui/ModalDialog";
import { ConfirmDialog } from "../../shared/ui/ConfirmDialog";
import { useVirtualKeyboard } from "../../shared/hooks/useVirtualKeyboard";
import { useUsageDisplayMode } from "../../shared/hooks/usePreferences";
import { displayPercent } from "../../shared/lib/usage-display";
import { cardWindows, isWindowExpired } from "../../shared/lib/usage-logic";
import { DialogError } from "../../shared/ui/DialogError";

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
  const [nameError, setNameError] = useState<string | null>(null);
  const [selectedProvider, setSelectedProvider] = useState<Provider | "all">("all");
  const [selectedAccountIds, setSelectedAccountIds] = useState<string[]>([]);
  const accountScrollRef = useRef<HTMLDivElement>(null);
  const { error, setError } = useDialogError(open);
  const { busy, setBusy, run } = useAsyncAction({ source: "buckets", setError });
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
  const [displayMode] = useUsageDisplayMode();

  // While busy nothing closes. Otherwise a clean form closes straight away; a
  // dirty form first asks whether to discard the unsaved changes.
  const requestClose = useModalClosePolicy(!busy, () => {
    if (dirty) {
      setConfirmingDiscard(true);
    } else {
      handleClose();
    }
  });
  const handleEscape = useEscapeOrClosePolicy(Boolean(error), () => setError(null), requestClose);
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
      setNameError(null);
      setSelectedProvider(initialProviderChoice);
      setSelectedAccountIds(initialIds);
      setBaseline({ name: initialName, provider: initialProviderChoice, accountIds: initialIds });
      setError(null);
      setBusy(false);
      setConfirmingDiscard(false);
      setConfirmingDelete(Boolean(initialConfirmDelete && bucket));
    }
  }, [open, bucket, initialConfirmDelete, accounts, setError, setBusy]);

  const filteredAccounts = useMemo(() => {
    if (selectedProvider === "all") return accounts;
    return accounts.filter((a) => a.provider === selectedProvider);
  }, [accounts, selectedProvider]);

  const accountThumb = useScrollThumb(accountScrollRef, open, filteredAccounts);

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
      setNameError("Please enter a name for this group.");
      return;
    }
    setNameError(null);

    // The saved provider comes only from the dropdown the user actually
    // touched ("all" stores null); it is no longer derived from membership,
    // so a single-account group does not pollute its own filter forever.
    const bucketProvider = selectedProvider === "all" ? null : selectedProvider;

    await run(async () => {
      const saved = await bridgeApi.saveBucket(trimmed, bucketProvider, selectedAccountIds, bucket?.id);
      onSaved(saved);
    }, "Couldn't save this group");
  };

  const handleDelete = async () => {
    if (!bucket || !onDeleted) return;
    await run(async () => {
      await bridgeApi.deleteBucket(bucket.id);
      onDeleted(bucket.id);
    }, "Couldn't delete this group");
  };

  return (
    <ModalDialog
      dialogRef={dialogRef}
      labelledBy="bucket-modal-title"
      className={`bucket-modal-card ${isKeyboardOpen ? "keyboard-open" : ""}`}
      backdropClassName={isKeyboardOpen ? "keyboard-open" : ""}
      onClose={requestClose}
      closeDisabled={busy}
    
      afterDialog={
        <>
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
        </>
      }
    >
      <div className="modal-kicker">Account Grouping</div>
      <h2 id="bucket-modal-title">{bucket ? "Edit Group" : "Create Group"}</h2>
      <p>Group accounts together in the sidebar to track their combined usage and limits. Groups can be empty.</p>

      <form onSubmit={handleSave} className="bucket-modal-form">
        <div className="field-group">
          <label className="field-label" htmlFor="bucket-name-input">Group Name</label>
          <input
            id="bucket-name-input"
            type="text"
            className={`text-input${nameError ? " has-error" : ""}`}
            placeholder="e.g. Antigravity - Work or Grok Team A"
            value={name}
            disabled={busy}
            aria-invalid={nameError ? true : undefined}
            aria-describedby={nameError ? "bucket-name-error" : undefined}
            onChange={(event) => {
              setName(event.target.value);
              if (nameError) setNameError(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !name.trim()) {
                event.preventDefault();
                setNameError("Please enter a name for this group.");
              }
            }}
          />
          {nameError ? (
            <div id="bucket-name-error" className="field-inline-error" role="alert">
              <AlertTriangleIcon aria-hidden="true" />
              <span>{nameError}</span>
            </div>
          ) : null}
        </div>

        <div className="field-group">
          <div className="bucket-account-heading">
            <span className="field-label">
              Select Accounts <span className="bucket-selected-count">({selectedAccountIds.length} selected)</span>
            </span>
            <button
              type="button"
              className="bucket-select-all-btn"
              onClick={selectAllFiltered}
              disabled={busy || !filteredAccounts.length}
            >
              {filteredAccounts.length && filteredAccounts.every((a) => selectedAccountIds.includes(a.id)) ? "Deselect All" : "Select All"}
            </button>
          </div>
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
          </div>

          <div className="bucket-account-picker-list">
            <div ref={accountScrollRef} className={`bucket-account-picker-scroll${accountThumb.overflows ? " has-overflow" : ""}`}>
              {accountThumb.overflows && (
                <div
                  ref={accountThumb.thumbRef as RefObject<HTMLDivElement>}
                  aria-hidden="true"
                  className="scroll-thumb"
                  onPointerDown={accountThumb.onThumbPointerDown}
                />
              )}
              {filteredAccounts.length ? filteredAccounts.map((account) => {
                const isSelected = selectedAccountIds.includes(account.id);
                const sessionWindow = cardWindows(account.lastUsage?.windows ?? [], account.provider)[0];
                return (
                  <label key={account.id} className={`bucket-account-item ${isSelected ? "selected" : ""}`}>
                    <input
                      type="checkbox"
                      checked={isSelected}
                      disabled={busy}
                      onChange={() => toggleAccount(account.id)}
                    />
                    <span className="bucket-account-check" aria-hidden="true" />
                    <span className={`bucket-account-provider-icon provider-${account.provider}`}>
                      <ProviderIcon provider={account.provider} />
                    </span>
                    <div className="bucket-account-info">
                      <strong className="bucket-account-label">{account.label}</strong>
                      <span className="bucket-account-email">{account.email ?? account.plan ?? account.provider}</span>
                    </div>
                    {sessionWindow?.remainingPercent != null && !isWindowExpired(sessionWindow.resetsAt) ? (
                      <span className="bucket-account-percent">
                        {Math.round(displayPercent(sessionWindow.remainingPercent, displayMode))}%
                      </span>
                    ) : null}
                  </label>
                );
              }) : (
                <div className="bucket-picker-empty">No accounts match the selected filter.</div>
              )}
            </div>
          </div>
        </div>

        <footer className={`modal-actions bucket-modal-actions${bucket && onDeleted ? "" : " is-split"}`}>
          {bucket && onDeleted ? (
            <>
              <button
                type="button"
                className="button ghost bucket-delete-button"
                disabled={busy}
                onClick={() => setConfirmingDelete(true)}
              >
                <TrashIcon /> Delete Group
              </button>
              <div className="bucket-modal-save-group">
                <button type="button" className="button ghost button-tertiary" disabled={busy} onClick={requestClose}>
                  Cancel
                </button>
                <button type="submit" className="button primary" disabled={busy}>
                  {busy ? "Saving…" : "Save"}
                </button>
              </div>
            </>
          ) : (
            <>
              <button type="button" className="button ghost button-tertiary" disabled={busy} onClick={requestClose}>
                Cancel
              </button>
              <div className="bucket-modal-save-group">
                <button type="submit" className="button primary" disabled={busy}>
                  {busy ? "Saving…" : "Create Group"}
                </button>
              </div>
            </>
          )}
        </footer>

        {error ? <DialogError className="modal-error-message" message={error} onDismiss={() => setError(null)} /> : null}
      </form>
    </ModalDialog>
  );
}

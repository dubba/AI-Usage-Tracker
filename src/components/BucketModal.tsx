import { useEffect, useMemo, useState } from "react";
import { bridgeApi } from "../api";
import { CloseIcon, TrashIcon } from "../icons";
import { ProviderIcon } from "./ProviderIcon";
import type { Account, AccountBucket, Provider } from "../types";
import { CustomDropdown } from "./CustomDropdown";

const ALL_PROVIDERS: { id: Provider; label: string }[] = [
  { id: "antigravity", label: "Antigravity" },
  { id: "grok", label: "Grok" },
  { id: "openai", label: "Codex/GPT" },
  { id: "anthropic", label: "Claude" },
  { id: "google_ai_studio", label: "AI Studio" },
  { id: "opencode_go", label: "OpenCode Go" },
];

export function BucketModal({
  open,
  bucket,
  initialProvider,
  accounts,
  onClose,
  onSaved,
  onDeleted,
}: {
  open: boolean;
  bucket: AccountBucket | null;
  initialProvider?: Provider | null;
  accounts: Account[];
  onClose: () => void;
  onSaved: (bucket: AccountBucket) => void;
  onDeleted?: (bucketId: string) => void;
}) {
  const [name, setName] = useState("");
  const [selectedProvider, setSelectedProvider] = useState<Provider | "all">("all");
  const [selectedAccountIds, setSelectedAccountIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      if (bucket) {
        setName(bucket.name);
        setSelectedProvider(bucket.provider ?? "all");
        setSelectedAccountIds(bucket.accountIds);
      } else {
        setName("");
        const provider = initialProvider ?? "all";
        setSelectedProvider(provider);
        if (provider !== "all") {
          setSelectedAccountIds(accounts.filter((a) => a.provider === provider).map((a) => a.id));
        } else {
          setSelectedAccountIds([]);
        }
      }
      setError(null);
      setBusy(false);
    }
  }, [open, bucket, initialProvider, accounts]);

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
    if (selectedAccountIds.length === 0) {
      setError("Please select at least one account for this group.");
      return;
    }

    // Determine bucket provider: if all selected accounts share the same provider, use it.
    const selectedAccounts = accounts.filter((a) => selectedAccountIds.includes(a.id));
    const firstProvider = selectedAccounts[0]?.provider;
    const isSingleProvider = selectedAccounts.every((a) => a.provider === firstProvider);
    const bucketProvider = isSingleProvider ? firstProvider : (selectedProvider === "all" ? null : selectedProvider);

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
      setError(String(cause));
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
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}>
      <section className="modal-card bucket-modal-card" role="dialog" aria-modal="true" aria-labelledby="bucket-modal-title">
        <header className="modal-card-header">
          <div className="modal-kicker">Account Grouping</div>
          <h2 id="bucket-modal-title">{bucket ? "Edit Group" : "Create Group"}</h2>
          <p>Combine accounts into an independent sidebar group to track their combined usage and limits.</p>
        </header>

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

          {error ? <div className="modal-error-message">{error}</div> : null}

          <footer className="modal-actions bucket-modal-actions">
            {bucket && onDeleted ? (
              <button
                type="button"
                className="button ghost bucket-delete-button"
                disabled={busy}
                onClick={handleDelete}
              >
                <TrashIcon /> Delete Group
              </button>
            ) : null}
            <div className="bucket-modal-save-group">
              <button type="button" className="button ghost" disabled={busy} onClick={onClose}>
                Cancel
              </button>
              <button type="submit" className="button primary" disabled={busy}>
                {busy ? "Saving…" : bucket ? "Save Changes" : "Create Group"}
              </button>
            </div>
          </footer>
        </form>
      </section>
    </div>
  );
}

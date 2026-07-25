import { useEffect, useMemo, useState } from "react";
import { clearCustomAccountEmail, getCustomAccountEmail, setCustomAccountEmail } from "../account-metadata";
import { bridgeApi } from "../api";
import { BellIcon, TrashIcon } from "../icons";
import type { Account, UsageAlertSetting, UsageWindow } from "../types";

const THRESHOLDS = [10, 20, 30, 40, 50];
const WINDOW_ORDER = ["five_hour", "weekly", "monthly"] as const;
type AlertWindowId = typeof WINDOW_ORDER[number];

function canonicalWindowId(window: UsageWindow): AlertWindowId | null {
  const id = window.id.toLowerCase().replaceAll("-", "_");
  const label = window.label.toLowerCase();
  if (id === "five_hour" || id === "rolling" || window.windowSeconds === 18_000 || label.includes("5 hour") || label.includes("five hour")) return "five_hour";
  if (id === "weekly" || window.windowSeconds === 604_800 || label.includes("weekly")) return "weekly";
  if (id === "monthly" || label.includes("monthly")) return "monthly";
  return null;
}

function windowLabel(windowId: AlertWindowId): string {
  switch (windowId) {
    case "five_hour": return "5 hour";
    case "weekly": return "Weekly";
    case "monthly": return "Monthly";
  }
}

function defaultSetting(windowId: AlertWindowId): UsageAlertSetting {
  return { windowId, enabled: false, thresholdPercent: 20 };
}

function validOptionalEmail(value: string): boolean {
  if (!value.trim()) return true;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

export function AccountAlertModal({
  account,
  onClose,
  onSaved,
}: {
  account: Account | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [settings, setSettings] = useState<UsageAlertSetting[]>([]);
  const [openCodeEmail, setOpenCodeEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const availableWindows = useMemo(() => {
    const available = new Set<AlertWindowId>();
    for (const window of account?.lastUsage?.windows ?? []) {
      const windowId = canonicalWindowId(window);
      if (windowId) available.add(windowId);
    }
    return WINDOW_ORDER.filter((windowId) => available.has(windowId));
  }, [account]);

  useEffect(() => {
    if (!account) {
      setSettings([]);
      setOpenCodeEmail("");
      setError(null);
      setLoading(false);
      setSaving(false);
      setRemoving(false);
      setConfirmRemove(false);
      return;
    }

    setOpenCodeEmail(account.provider === "opencode_go" ? getCustomAccountEmail(account.id) ?? "" : "");
    setConfirmRemove(false);
    let cancelled = false;
    setLoading(true);
    setError(null);
    void bridgeApi.getAccountAlerts(account.id)
      .then((saved) => {
        if (cancelled) return;
        setSettings(availableWindows.map((windowId) => saved.find((setting) => setting.windowId === windowId) ?? defaultSetting(windowId)));
      })
      .catch((cause) => {
        if (!cancelled) setError(String(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [account, availableWindows]);

  if (!account) return null;

  const updateSetting = (windowId: AlertWindowId, update: Partial<UsageAlertSetting>) => {
    setSettings((current) => current.map((setting) => setting.windowId === windowId ? { ...setting, ...update } : setting));
  };

  const save = async () => {
    if (account.provider === "opencode_go" && !validOptionalEmail(openCodeEmail)) {
      setError("Enter a valid email address or leave the field empty.");
      return;
    }

    setSaving(true);
    setError(null);
    try {
      await bridgeApi.saveAccountAlerts(account.id, settings);
      if (account.provider === "opencode_go") setCustomAccountEmail(account.id, openCodeEmail);
      onSaved();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setSaving(false);
    }
  };

  const removeAccount = async () => {
    setRemoving(true);
    setError(null);
    try {
      await bridgeApi.removeAccount(account.id);
      clearCustomAccountEmail(account.id);
      onSaved();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setRemoving(false);
    }
  };

  const busy = saving || removing;

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}>
      <section className="modal-card alert-settings-modal" role="dialog" aria-modal="true" aria-labelledby="alert-settings-title">
        <div className="modal-kicker">Account settings</div>
        <div className="alert-settings-heading">
          <span className="alert-settings-icon"><BellIcon /></span>
          <div>
            <h2 id="alert-settings-title">Settings for {account.label}</h2>
            <p>Manage this account’s display details, notifications, and connection.</p>
          </div>
        </div>

        {account.provider === "opencode_go" ? (
          <section className="account-settings-section">
            <div className="account-settings-section-heading">
              <strong>Account email</strong>
              <small>Optional. This appears under the OpenCode account name in the sidebar.</small>
            </div>
            <input
              className="text-input"
              type="email"
              inputMode="email"
              autoComplete="email"
              value={openCodeEmail}
              placeholder="name@example.com"
              disabled={busy}
              onChange={(event) => {
                setOpenCodeEmail(event.target.value);
                setError(null);
              }}
            />
          </section>
        ) : null}

        <section className="account-settings-section">
          <div className="account-settings-section-heading">
            <strong>Usage alerts</strong>
            <small>Choose when the operating system should notify you about remaining quota.</small>
          </div>

          {loading ? <div className="waiting-panel"><span className="spinner" />Loading alert settings…</div> : null}

          {!loading && availableWindows.length ? (
            <div className="alert-window-list">
              {availableWindows.map((windowId) => {
                const setting = settings.find((candidate) => candidate.windowId === windowId) ?? defaultSetting(windowId);
                return (
                  <div className={`alert-window-row ${setting.enabled ? "enabled" : ""}`} key={windowId}>
                    <label className="alert-window-toggle">
                      <input
                        type="checkbox"
                        checked={setting.enabled}
                        disabled={busy}
                        onChange={(event) => updateSetting(windowId, { enabled: event.target.checked })}
                      />
                      <span className="alert-checkbox" />
                      <span><strong>{windowLabel(windowId)}</strong><small>Notify once per quota period</small></span>
                    </label>
                    <label className="alert-threshold">
                      <span>At or below</span>
                      <select
                        value={setting.thresholdPercent}
                        disabled={!setting.enabled || busy}
                        onChange={(event) => updateSetting(windowId, { thresholdPercent: Number(event.target.value) })}
                      >
                        {THRESHOLDS.map((threshold) => <option value={threshold} key={threshold}>{threshold}% remaining</option>)}
                      </select>
                    </label>
                  </div>
                );
              })}
            </div>
          ) : null}

          {!loading && !availableWindows.length ? (
            <div className="alert-empty-state compact-alert-empty">
              <BellIcon />
              <strong>No alert windows detected yet</strong>
              <span>Use Refresh all once so the app can detect this account’s available limits.</span>
            </div>
          ) : null}
        </section>

        <section className="account-settings-section danger-settings-section">
          <div className="account-settings-section-heading">
            <strong>Remove account</strong>
            <small>Deletes this account and its stored provider credentials from this computer.</small>
          </div>
          {confirmRemove ? (
            <div className="remove-account-confirmation">
              <span>Remove <strong>{account.label}</strong>?</span>
              <div>
                <button type="button" className="button ghost" onClick={() => setConfirmRemove(false)} disabled={busy}>Cancel</button>
                <button type="button" className="button danger-button" onClick={() => void removeAccount()} disabled={busy}>
                  <TrashIcon />{removing ? "Removing…" : "Remove account"}
                </button>
              </div>
            </div>
          ) : (
            <button type="button" className="button ghost danger-button" onClick={() => setConfirmRemove(true)} disabled={busy}>
              <TrashIcon />Remove account
            </button>
          )}
        </section>

        <div className="credential-note alert-notification-note">
          Alerts use the operating system notification system and fire only once for each quota period.
        </div>
        {error ? <div className="error-panel modal-error">{error}</div> : null}
        <div className="modal-actions">
          <button className="button ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="button primary" onClick={() => void save()} disabled={loading || busy}>{saving ? "Saving…" : "Save settings"}</button>
        </div>
      </section>
    </div>
  );
}

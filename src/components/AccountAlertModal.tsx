import { useEffect, useMemo, useRef, useState } from "react";
import { bridgeApi } from "../api";
import { BellIcon } from "../icons";
import type { Account, UsageAlertSetting, UsageWindow } from "../types";
import { CustomDropdown } from "./CustomDropdown";
import { useModalA11y } from "./useModalA11y";

const THRESHOLDS = [10, 20, 30, 40, 50];
const WINDOW_ORDER = ["five_hour", "weekly"] as const;
type AlertWindowId = typeof WINDOW_ORDER[number];

function canonicalWindowId(window: UsageWindow): AlertWindowId | null {
  const id = window.id.toLowerCase().replaceAll("-", "_");
  const label = window.label.toLowerCase();
  if (id === "five_hour" || id === "rolling" || window.windowSeconds === 18_000 || label.includes("5 hour") || label.includes("five hour")) return "five_hour";
  if (id === "weekly" || window.windowSeconds === 604_800 || label.includes("weekly") || label.includes("7 day") || label.includes("seven day")) return "weekly";
  return null;
}

function windowLabel(windowId: AlertWindowId): string {
  return windowId === "five_hour" ? "5 hour" : "Weekly";
}

function defaultSetting(windowId: AlertWindowId): UsageAlertSetting {
  return { windowId, enabled: false, thresholdPercent: 20 };
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
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLElement>(null);
  useModalA11y(dialogRef, account != null, onClose);

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
      setError(null);
      setLoading(false);
      setSaving(false);
      return;
    }

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
    setSaving(true);
    setError(null);
    try {
      await bridgeApi.saveAccountAlerts(account.id, settings);
      onSaved();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section ref={dialogRef} className="modal-card alert-settings-modal notification-only-modal" role="dialog" aria-modal="true" aria-labelledby="alert-settings-title" tabIndex={-1}>
        <div className="modal-kicker">Account alerts</div>
        <div className="alert-settings-heading">
          <span className="alert-settings-icon"><BellIcon /></span>
          <div>
            <h2 id="alert-settings-title">Usage notifications</h2>
            <p>Choose when to notify you about the 5-hour and weekly limits for <strong>{account.label}</strong>.</p>
          </div>
        </div>

        <section className="account-settings-section">
          {loading ? <div className="waiting-panel"><span className="spinner" />Loading notification settings…</div> : null}

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
                        disabled={saving}
                        onChange={(event) => updateSetting(windowId, { enabled: event.target.checked })}
                      />
                      <span className="alert-checkbox" />
                      <span><strong>{windowLabel(windowId)}</strong><small>Notify once per quota period</small></span>
                    </label>
                    <div className="alert-threshold">
                      <span>At or below</span>
                      <CustomDropdown<number>
                        value={setting.thresholdPercent}
                        disabled={!setting.enabled || saving}
                        options={THRESHOLDS.map((threshold) => ({
                          value: threshold,
                          label: `${threshold}% remaining`,
                        }))}
                        onChange={(threshold) => updateSetting(windowId, { thresholdPercent: threshold })}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          ) : null}

          {!loading && !availableWindows.length ? (
            <div className="alert-empty-state compact-alert-empty">
              <BellIcon />
              <strong>No 5-hour or weekly limits detected yet</strong>
              <span>Refresh this account so the app can detect its available usage windows.</span>
            </div>
          ) : null}
        </section>

        <div className="credential-note alert-notification-note">
          Alerts use the operating system notification system and fire only once for each quota period.
        </div>
        {error ? <div className="error-panel modal-error">{error}</div> : null}
        <div className="modal-actions">
          <button className="button ghost" onClick={onClose}>Cancel</button>
          <button className="button primary" onClick={() => void save()} disabled={loading || saving || !availableWindows.length}>{saving ? "Saving…" : "Save Notifications"}</button>
        </div>
      </section>
    </div>
  );
}

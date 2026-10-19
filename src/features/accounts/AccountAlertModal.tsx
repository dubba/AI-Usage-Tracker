import { useEffect, useMemo, useRef, useState } from "react";
import { bridgeApi } from "../../shared/lib/api";
import { useAsyncAction } from "../../shared/hooks/useAsyncAction";
import { describeError } from "../../shared/lib/errors";
import { BellIcon } from "../../shared/ui/icons";
import type { Account, UsageAlertSetting, UsageWindow } from "../../types";
import { CustomDropdown } from "../../shared/ui/CustomDropdown";
import { useAutoDismissedError } from "../../shared/hooks/useAutoDismissedError";
import { useModalA11y } from "../../shared/hooks/useModalA11y";
import { useModalClosePolicy, useEscapeOrClosePolicy } from "../../shared/hooks/useModalClosePolicy";
import { ModalDialog } from "../../shared/ui/ModalDialog";

const THRESHOLDS = [10, 20, 30, 40, 50];
const WINDOW_ORDER = ["five_hour", "weekly", "monthly"] as const;
type AlertWindowId = typeof WINDOW_ORDER[number];

function canonicalWindowId(window: UsageWindow): AlertWindowId | null {
  return window.kind;
}

function windowLabel(windowId: AlertWindowId): string {
  switch (windowId) {
    case "five_hour":
      return "5 hour";
    case "weekly":
      return "Weekly";
    case "monthly":
      return "30-day";
  }
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
  const { error, setError } = useAutoDismissedError(account?.id);
  const { busy: saving, setBusy: setSaving, run } = useAsyncAction({ source: "alerts", setError });
  const dialogRef = useRef<HTMLElement>(null);
  const requestClose = useModalClosePolicy(!saving, onClose);
  const handleEscape = useEscapeOrClosePolicy(Boolean(error), () => setError(null), requestClose);
  useModalA11y(dialogRef, account != null, handleEscape);

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
        if (!cancelled) setError(describeError("alerts", "Couldn't load the alert settings", cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [account, availableWindows, setError, setSaving]);

  if (!account) return null;

  const updateSetting = (windowId: AlertWindowId, update: Partial<UsageAlertSetting>) => {
    setSettings((current) => current.map((setting) => setting.windowId === windowId ? { ...setting, ...update } : setting));
  };

  const save = async () => {
    await run(async () => {
      await bridgeApi.saveAccountAlerts(account.id, settings);
      onSaved();
    }, "Couldn't save the alert settings");
  };

  return (
    <ModalDialog dialogRef={dialogRef} labelledBy="alert-settings-title" className="alert-settings-modal notification-only-modal" onClose={requestClose} closeDisabled={saving}>
      <div className="modal-kicker">Account alerts</div>
      <h2 id="alert-settings-title">Usage Notifications</h2>
      <p>Choose when to notify you about the 5-hour, weekly, and 30-day limits for <strong>{account.label}</strong>.</p>

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
                      aria-label="Alert threshold"
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
            <strong>No 5-hour, weekly, or 30-day limits detected yet</strong>
            <span>Refresh this account so the app can detect its available usage windows.</span>
          </div>
        ) : null}
      </section>

      <div className="credential-note alert-notification-note">
        Alerts use your OS notifications and are sent only once per quota period.
      </div>
      <div className="modal-actions">
        <button type="button" className="button ghost" onClick={requestClose} disabled={saving}>Cancel</button>
        <button type="button" className="button primary" onClick={() => void save()} disabled={loading || saving || !availableWindows.length}>{saving ? "Saving…" : "Save Notifications"}</button>
      </div>
      {error ? <div className="error-panel modal-error" role="alert">{error}</div> : null}
    </ModalDialog>
  );
}

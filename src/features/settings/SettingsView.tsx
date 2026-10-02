import { useState } from "react";
import {
  ExternalLinkIcon,
  MenuIcon,
} from "../../shared/ui/icons";
import { CopyDiagnosticsButton } from "./CopyDiagnosticsButton";
import { CustomDropdown } from "../../shared/ui/CustomDropdown";
import { UpdateNotesModal } from "./UpdateNotesModal";
import type {
  AppSettings,
  AppUpdateProgress,
  AppUpdateStatus,
  BridgeStatus,
  UpdateBusy,
} from "../../types";
import { FALLBACK_APP_VERSION } from "../../shared/lib/constants";
import { isMobileUserAgent } from "../../shared/lib/platform";
import { UpdateProgressBar, updateInstallLabel } from "./UpdateProgressBar";

const ACCOUNT_REFRESH_OPTIONS = [5, 10, 15, 30, 45, 60] as const;
const CHANGELOG_URL = "https://github.com/dubba/AI-Usage-Tracker/blob/main/CHANGELOG.md";

export function SettingsView({
  autostart,
  onToggleAutostart,
  appSettings,
  settingsBusy,
  onAccountRefreshMinutesChange,
  onAutomaticUpdatesChange,
  onIncludeBetaUpdatesChange,
  installedVersion,
  update,
  updateBusy,
  updateProgress,
  updateError,
  updateMessage,
  onCheckForUpdate,
  onInstallUpdate,
  onToggleSidebar,
  onOpenPairing,
  onOpenLink,
  bridge,
  bridgeBusy,
  onToggleBridge,
  onViewBridgeWindow,
}: {
  autostart: boolean;
  onToggleAutostart: () => void;
  appSettings: AppSettings | null;
  settingsBusy: boolean;
  onAccountRefreshMinutesChange: (minutes: number) => void;
  onAutomaticUpdatesChange: (enabled: boolean) => void;
  onIncludeBetaUpdatesChange: (enabled: boolean) => void;
  installedVersion: string;
  update: AppUpdateStatus | null;
  updateBusy: UpdateBusy;
  updateProgress: AppUpdateProgress | null;
  updateError: string | null;
  updateMessage?: string | null;
  onCheckForUpdate: () => void;
  onInstallUpdate: () => void;
  onToggleSidebar?: () => void;
  onOpenPairing?: () => void;
  onOpenLink: (url: string) => void;
  bridge: BridgeStatus | null;
  bridgeBusy: boolean;
  onToggleBridge: (enabled: boolean) => void;
  onViewBridgeWindow: () => void;
}) {
  const [updateNotesOpen, setUpdateNotesOpen] = useState(false);
  const automaticUpdates = appSettings?.automaticUpdatesEnabled ?? true;
  const includeBetaUpdates = appSettings?.includeBetaUpdates ?? false;
  return (
    <div className="content-scroll dashboard-content settings-style-content">
      <header className="dashboard-header">
        <div>
          <div className="dashboard-title-row">
            {onToggleSidebar ? (
              <button
                type="button"
                className="mobile-sidebar-toggle-btn"
                onClick={onToggleSidebar}
                aria-label="Toggle navigation menu"
                data-tooltip="Toggle navigation menu"
              >
                <MenuIcon />
              </button>
            ) : null}
            <h1 className="eyebrow">App Settings</h1>
          </div>
        </div>
      </header>
      <div className="dashboard-scroll">
      <section className="settings-card">
        <div className="settings-row">
          <div>
            <strong>Device Transfer</strong>
            <small>Sync accounts & credentials across devices securely.</small>
          </div>
          <button
            type="button"
            className="button primary"
            onClick={onOpenPairing}
          >
            Link Devices
          </button>
        </div>
      </section>
      <section className="settings-card">
        <div className="settings-row">
          <div>
            <strong>{isMobileUserAgent() ? "Start on Device Boot" : "Start at Login"}</strong>
            <small>{isMobileUserAgent() ? "Start app automatically at device startup." : "Start app automatically at login."}</small>
          </div>
          <button className={`toggle ${autostart ? "on" : ""}`} onClick={onToggleAutostart} aria-pressed={autostart}><span /></button>
        </div>
        <div className="settings-row settings-updates-group-row">
          <div className="settings-updates-group-header">
            <div>
              <strong>Automatically Update App</strong>
            </div>
            <button
              type="button"
              className={`toggle ${automaticUpdates ? "on" : ""}`}
              disabled={!appSettings || settingsBusy}
              aria-label={automaticUpdates ? "Disable automatic updates" : "Enable automatic updates"}
              aria-pressed={automaticUpdates}
              onClick={() => onAutomaticUpdatesChange(!automaticUpdates)}
            >
              <span />
            </button>
          </div>

          <div className="settings-updates-group-header settings-updates-beta-row">
            <div>
              <strong>Include Beta Releases</strong>
            </div>
            <button
              type="button"
              className={`toggle ${includeBetaUpdates ? "on" : ""}`}
              disabled={!appSettings || settingsBusy}
              aria-label={includeBetaUpdates ? "Exclude beta releases from update checks" : "Include beta releases in update checks"}
              aria-pressed={includeBetaUpdates}
              onClick={() => onIncludeBetaUpdatesChange(!includeBetaUpdates)}
            >
              <span />
            </button>
          </div>

          <div className="settings-updates-subcard">
            <div className="settings-updates-subcard-info">
              <span className="settings-installed-version mono">
                {`Current Version: ${String(update?.currentVersion || installedVersion || FALLBACK_APP_VERSION).replace(/^v/i, "")}`}
              </span>
              {updateBusy === "downloading" || updateBusy === "verifying" || updateBusy === "installing" ? null : (
              <div className={`settings-updates-subcard-status ${!updateBusy && update?.available ? "update-available" : ""}`}>
                {updateBusy === "checking" ? (
                  <span>Checking for updates…</span>
                ) : update?.available && update.availableVersion ? (
                  <>
                    <span className="status-indicator-dot red" aria-hidden="true" />
                    <span>{`Version ${update.availableVersion.replace(/^v/i, "")} available`}</span>
                  </>
                ) : (
                  <>
                    <span className="status-indicator-dot green" aria-hidden="true" />
                    <span>Up to date</span>
                  </>
                )}
              </div>
              )}
              {!updateBusy && update?.available && update.availableVersion ? (
                <button
                  type="button"
                  className="settings-view-changelog-link"
                  onClick={() => setUpdateNotesOpen(true)}
                >
                  {`View what changed in v${update.availableVersion.replace(/^v/i, "")}`}
                </button>
              ) : null}
            </div>
            {update?.available ? (
              <button
                type="button"
                className="button danger settings-update-action settings-update-action-danger"
                disabled={updateBusy !== null}
                onClick={onInstallUpdate}
              >
                {updateInstallLabel(updateBusy)}
              </button>
            ) : (
              <button
                type="button"
                className="button primary settings-update-action"
                disabled={updateBusy !== null}
                onClick={onCheckForUpdate}
              >
                {updateBusy === "checking" ? "Checking…" : "Check Now"}
              </button>
            )}
            <UpdateProgressBar busy={updateBusy} percent={updateProgress?.percent ?? null} />
            {updateMessage ? <div className="info-panel settings-update-info">{updateMessage}</div> : null}
            {updateError ? <div className="error-panel settings-update-error">{updateError}</div> : null}
          </div>
        </div>
        <div className="settings-row">
          <div>
            <strong>Account Updates</strong>
            <small>Set how often the app updates your AI usage.</small>
          </div>
          <div className="settings-account-refresh">
            <CustomDropdown<number>
              value={
                appSettings?.accountRefreshMinutes != null &&
                (ACCOUNT_REFRESH_OPTIONS as readonly number[]).includes(appSettings.accountRefreshMinutes)
                  ? appSettings.accountRefreshMinutes
                  : 15
              }
              disabled={!appSettings || settingsBusy}
              options={ACCOUNT_REFRESH_OPTIONS.map((minutes) => ({
                value: minutes,
                label: `${minutes} minutes`,
              }))}
              onChange={(minutes) => onAccountRefreshMinutesChange(minutes)}
            />
          </div>
        </div>
        <div className="settings-row">
          <div>
            <strong>Change Log</strong>
            <small>View full history of app changes.</small>
          </div>
          <button
            type="button"
            className="button ghost settings-changelog-button"
            aria-label="View change log (opens in a new window)"
            data-tooltip="Opens in a new window"
            onClick={() => onOpenLink(CHANGELOG_URL)}
          >
            <span>View</span>
            <ExternalLinkIcon />
          </button>
        </div>
      </section>
      <section className="settings-card">
        <div className="settings-row">
          <div>
            <strong>Enable Paseo Bridge</strong>
            <small>Allows local HTTP tools to access quota usage & notification status.</small>
          </div>
          <button
            type="button"
            className={`toggle ${bridge?.enabled ? "on" : ""}`}
            disabled={bridgeBusy}
            aria-label={bridge?.enabled ? "Disable Paseo bridge" : "Enable Paseo bridge"}
            aria-pressed={Boolean(bridge?.enabled)}
            onClick={() => onToggleBridge(!bridge?.enabled)}
          >
            <span />
          </button>
        </div>
        <div className="settings-row">
          <div>
            <strong>Integration Window</strong>
            <small>View local bridge status, auth tokens and connection URL.</small>
          </div>
          <button
            type="button"
            className="button ghost settings-changelog-button"
            aria-label="View integration window (opens in a new window)"
            data-tooltip="Opens in a new window"
            disabled={bridgeBusy}
            onClick={onViewBridgeWindow}
          >
            <span>View</span>
            <ExternalLinkIcon />
          </button>
        </div>
      </section>
      {bridge?.error ? <div className="error-panel api-integration-error">{bridge.error}</div> : null}
      <section className="settings-card">
        <div className="settings-row">
          <div>
            <strong>Diagnostics</strong>
            <small>Copy bug report with tokens, cookies and emails removed.</small>
          </div>
          <CopyDiagnosticsButton compact className="button primary" />
        </div>
      </section>
      </div>
      <UpdateNotesModal
        open={updateNotesOpen}
        version={update?.availableVersion ?? null}
        releaseDate={update?.date}
        releaseNotes={update?.body}
        onClose={() => setUpdateNotesOpen(false)}
        onInstallUpdate={onInstallUpdate}
        onOpenLink={onOpenLink}
        updateBusy={updateBusy}
        updatePercent={updateProgress?.percent ?? null}
      />
    </div>
  );
}

import { useState } from "react";
import {
  ChevronIcon,
  ExternalLinkIcon,
  MenuIcon,
} from "../../shared/ui/icons";
import { CopyDiagnosticsButton } from "./CopyDiagnosticsButton";
import { CustomDropdown } from "../../shared/ui/CustomDropdown";
import type {
  AppSettings,
  AppUpdateProgress,
  AppUpdateStatus,
  BridgeStatus,
  UpdateBusy,
} from "../../types";
import { FALLBACK_APP_VERSION, SIDEBAR_ID } from "../../shared/lib/constants";
import { isIOS, isMobileDevice } from "../../shared/lib/platform";
import { SHORTCUTS, isMacPlatform, shortcutLabel } from "../shortcuts/shortcuts";
import { UpdateProgressBar, updateInstallLabel } from "./UpdateProgressBar";
import { useThemePreference } from "../../shared/hooks/useThemePreference";
import type { ThemePreference } from "../../shared/lib/theme";

const ACCOUNT_REFRESH_OPTIONS = [5, 10, 15, 30, 45, 60] as const;
const THEME_OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
  { value: "system", label: "System" },
];
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
  sidebarOpen,
  onOpenPairing,
  onOpenLink,
  bridge,
  bridgeBusy,
  onToggleBridge,
  onViewBridgeWindow,
  onOpenUpdateNotes,
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
  sidebarOpen?: boolean;
  onOpenPairing?: () => void;
  onOpenLink: (url: string) => void;
  bridge: BridgeStatus | null;
  bridgeBusy: boolean;
  onToggleBridge: (enabled: boolean) => void;
  onViewBridgeWindow: () => void;
  onOpenUpdateNotes?: () => void;
}) {
  const automaticUpdates = appSettings?.automaticUpdatesEnabled ?? true;
  const includeBetaUpdates = appSettings?.includeBetaUpdates ?? false;
  const [themePreference, setThemePreference] = useThemePreference();
  const [advancedOpen, setAdvancedOpen] = useState(false);
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
                aria-expanded={sidebarOpen ?? false}
                aria-controls={SIDEBAR_ID}
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
        <h2 className="settings-section-title">General</h2>
        <section className="settings-card">
          <div className="settings-row">
            <div>
              <strong>Appearance</strong>
              <small>Dark, light, or match your device.</small>
            </div>
            <div className="settings-account-refresh">
              <CustomDropdown<ThemePreference>
                id="setting-theme"
                value={themePreference}
                options={THEME_OPTIONS}
                onChange={setThemePreference}
              />
            </div>
          </div>
          <div className="settings-row">
            <div>
              <strong id="setting-autostart-label">Launch at Startup</strong>
              <small>Start the app when your device starts.</small>
            </div>
            <button type="button" role="switch" aria-checked={autostart} aria-labelledby="setting-autostart-label" className={`toggle ${autostart ? "on" : ""}`} onClick={onToggleAutostart}><span /></button>
          </div>
          <div className="settings-row">
            <div>
              <strong>Account Updates</strong>
              <small>How often usage is refreshed.</small>
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
        </section>

        <h2 className="settings-section-title">Updates</h2>
        <section className="settings-card">
          <div className="settings-row settings-updates-group-row">
            <div className="settings-updates-group-header">
              <div>
                <strong id="setting-auto-update-label">Automatic Updates</strong>
                <small>Check for new versions automatically.</small>
              </div>
              <button
                type="button"
                className={`toggle ${automaticUpdates ? "on" : ""}`}
                disabled={!appSettings || settingsBusy}
                role="switch"
                aria-checked={automaticUpdates}
                aria-labelledby="setting-auto-update-label"
                onClick={() => onAutomaticUpdatesChange(!automaticUpdates)}
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
                {!updateBusy && update?.available && update.availableVersion && onOpenUpdateNotes ? (
                  <button
                    type="button"
                    className="settings-view-changelog-link"
                    onClick={onOpenUpdateNotes}
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
                  {updateInstallLabel(updateBusy, isIOS())}
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

            <div className="settings-updates-group-header settings-updates-beta-row">
              <div>
                <strong id="setting-beta-label">Include Beta Releases</strong>
              </div>
              <button
                type="button"
                className={`toggle ${includeBetaUpdates ? "on" : ""}`}
                disabled={!appSettings || settingsBusy}
                role="switch"
                aria-checked={includeBetaUpdates}
                aria-labelledby="setting-beta-label"
                onClick={() => onIncludeBetaUpdatesChange(!includeBetaUpdates)}
              >
                <span />
              </button>
            </div>
          </div>
          <div className="settings-row">
            <div>
              <strong>Change Log</strong>
              <small>Full history of app changes.</small>
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

        <h2 className="settings-section-title">Devices</h2>
        <section className="settings-card">
          <div className="settings-row">
            <div>
              <strong>Device Transfer</strong>
              <small>Sync accounts and credentials to another device securely.</small>
            </div>
            <button
              type="button"
              className="button ghost settings-changelog-button"
              onClick={onOpenPairing}
            >
              Link Devices
            </button>
          </div>
        </section>

        <h2 className="settings-section-title">
          <button
            type="button"
            className="settings-advanced-toggle"
            onClick={() => setAdvancedOpen((prev) => !prev)}
            aria-expanded={advancedOpen}
            aria-controls="settings-advanced-content"
          >
            <span>Advanced</span>
            <ChevronIcon className={`settings-advanced-chevron ${advancedOpen ? "open" : ""}`} />
          </button>
        </h2>

        {advancedOpen ? (
          <div id="settings-advanced-content" className="settings-advanced-group">
            <section className="settings-card">
              <div className="settings-row">
                <div>
                  <strong>Diagnostics</strong>
                  <small>Bug report with tokens, cookies, and emails removed.</small>
                </div>
                <CopyDiagnosticsButton compact className="button ghost settings-changelog-button" />
              </div>
            </section>
            {!isMobileDevice() ? (
              <section className="settings-card">
                <div className="settings-row">
                  <div>
                    <strong id="setting-bridge-label">Paseo Bridge</strong>
                    <small>Allows local HTTP tools to access quota usage & notification status.</small>
                  </div>
                  <button
                    type="button"
                    className={`toggle ${bridge?.enabled ? "on" : ""}`}
                    disabled={bridgeBusy}
                    role="switch"
                    aria-checked={Boolean(bridge?.enabled)}
                    aria-labelledby="setting-bridge-label"
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
            ) : null}
            {!isMobileDevice() && bridge?.error ? <div className="error-panel api-integration-error">{bridge.error}</div> : null}
            {!isMobileDevice() ? (
              <section className="settings-card settings-shortcuts-card" aria-labelledby="settings-shortcuts-heading">
                <div className="settings-row settings-shortcuts-row">
                  <div>
                    <strong id="settings-shortcuts-heading">Keyboard Shortcuts</strong>
                    <ul className="settings-shortcuts">
                      {SHORTCUTS.map((shortcut) => (
                        <li key={shortcut.action}>
                          <span>{shortcut.label}</span>
                          <kbd>{shortcutLabel(shortcut.key, isMacPlatform())}</kbd>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              </section>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

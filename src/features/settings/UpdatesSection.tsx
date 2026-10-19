import { ArrowUpCircleIcon, DownloadCloudIcon, ExternalLinkIcon } from "../../shared/ui/icons";
import { ToggleSwitch } from "../../shared/ui/ToggleSwitch";
import { FALLBACK_APP_VERSION } from "../../shared/lib/constants";
import { isIOS } from "../../shared/lib/platform";
import { useAppSettingsState, useAppUpdateState } from "./settings-context";
import { UpdateErrorMessage } from "./UpdateErrorMessage";
import { UpdateProgressBar, updateInstallLabel } from "./UpdateProgressBar";

const CHANGELOG_URL = "https://github.com/dubba/AI-Usage-Tracker/blob/main/CHANGELOG.md";

/** Automatic and beta updates, the current version, checking and installing, and the change log link. */
export function UpdatesSection({
  onOpenLink,
  onOpenUpdateNotes,
}: {
  onOpenLink: (url: string) => void;
  onOpenUpdateNotes?: () => void;
}) {
  const { appSettings, automaticUpdatesBusy, includeBetaUpdatesBusy, saveAutomaticUpdatesEnabled, saveIncludeBetaUpdates } =
    useAppSettingsState();
  const {
    installedVersion,
    appUpdate: update,
    updateBusy,
    updateProgress,
    updateError,
    updateMessage,
    checkForUpdate,
    installUpdate,
  } = useAppUpdateState();
  const automaticUpdates = appSettings?.automaticUpdatesEnabled ?? true;
  const includeBetaUpdates = appSettings?.includeBetaUpdates ?? false;

  return (
    <>
      <h2 className="settings-section-title">Updates</h2>
      <section className="settings-card">
        <div className="settings-row settings-updates-group-row">
          <div className="settings-updates-group-header">
            <div>
              <strong id="setting-auto-update-label">Automatic Updates</strong>
              <small>Check for new versions automatically.</small>
            </div>
            <ToggleSwitch
              checked={automaticUpdates}
              labelledBy="setting-auto-update-label"
              disabled={!appSettings || automaticUpdatesBusy}
              onChange={(enabled) => void saveAutomaticUpdatesEnabled(enabled)}
            />
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
            </div>
            {update?.available ? (
              <button
                type="button"
                className="button danger settings-update-action settings-update-action-danger"
                disabled={updateBusy !== null}
                onClick={() => void installUpdate()}
              >
                <DownloadCloudIcon className="settings-update-action-icon" />
                <span>{updateInstallLabel(updateBusy, isIOS())}</span>
              </button>
            ) : (
              <button
                type="button"
                className="button primary settings-update-action"
                disabled={updateBusy !== null}
                onClick={() => void checkForUpdate(true)}
              >
                <ArrowUpCircleIcon className="settings-update-action-icon" />
                <span>{updateBusy === "checking" ? "Checking…" : "Check Now"}</span>
              </button>
            )}
            {!updateBusy && update?.available && update.availableVersion && onOpenUpdateNotes ? (
              <div className="settings-updates-subcard-link-row">
                <button type="button" className="settings-view-changelog-link" onClick={onOpenUpdateNotes}>
                  {`View what changed in v${update.availableVersion.replace(/^v/i, "")}`}
                </button>
              </div>
            ) : null}
            <UpdateProgressBar busy={updateBusy} percent={updateProgress?.percent ?? null} />
            {updateMessage ? <div className="info-panel settings-update-info">{updateMessage}</div> : null}
            {updateError ? <UpdateErrorMessage error={updateError} onOpenLink={onOpenLink} /> : null}
          </div>

          <div className="settings-updates-group-header settings-updates-beta-row">
            <div>
              <strong id="setting-beta-label">Include Beta Releases</strong>
            </div>
            <ToggleSwitch
              checked={includeBetaUpdates}
              labelledBy="setting-beta-label"
              disabled={!appSettings || includeBetaUpdatesBusy}
              onChange={(enabled) => void saveIncludeBetaUpdates(enabled)}
            />
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
            aria-label="View change log (opens in web browser)"
            data-tooltip="Opens in web browser"
            onClick={() => onOpenLink(CHANGELOG_URL)}
          >
            <span>View</span>
            <ExternalLinkIcon />
          </button>
        </div>
      </section>
    </>
  );
}

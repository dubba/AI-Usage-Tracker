use super::*;

/// Only the updater's dedicated "no latest.json / no release metadata" variant
/// is treated as a missing updater manifest. Other errors whose messages happen
/// to contain "not found" (missing platform package, temp dir, archive binary,
/// etc.) are reported to the UI.
#[cfg(any(test, desktop))]
pub(super) fn updater_error_is_no_release(error: &tauri_plugin_updater::Error) -> bool {
    matches!(error, tauri_plugin_updater::Error::ReleaseNotFound)
}

/// Updater for the desktop app. With beta releases enabled it is pointed at the
/// newest release's own `latest.json`, because the configured
/// `releases/latest/download/latest.json` endpoint ignores pre-releases. If the
/// release list is unreachable it falls back to the configured stable endpoint.
#[cfg(desktop)]
pub(super) async fn desktop_updater(
    app: &AppHandle,
    state: &AppState,
) -> Result<tauri_plugin_updater::Updater, tauri_plugin_updater::Error> {
    if beta_updates_wanted(state) {
        if let Ok(release) = fetch_github_latest_release(true, required_update_asset()).await {
            let manifest = format!(
                "https://github.com/dubba/AI-Usage-Tracker/releases/download/{}/latest.json",
                release.tag
            );
            if let Ok(url) = manifest.parse::<tauri::Url>() {
                return app.updater_builder().endpoints(vec![url])?.build();
            }
        }
    }
    app.updater()
}

/// Upper bound for the updater manifest fetch in `check_for_app_update` and
/// `install_app_update`. The updater plugin's HTTP client has no timeout of
/// its own, so without this a stalled connection would leave the Settings
/// update button spinning on "Downloading…" forever.
pub(super) const UPDATER_CHECK_TIMEOUT: Duration = Duration::from_secs(30);

/// Upper bound for the whole download-and-install step. Aborting here is safe:
/// the updater only touches the running app after the full package is
/// downloaded and signature-verified.
pub(super) const UPDATER_INSTALL_TIMEOUT: Duration = Duration::from_secs(15 * 60);

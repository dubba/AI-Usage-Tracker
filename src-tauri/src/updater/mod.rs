#[cfg(target_os = "android")]
use crate::apk_install;
use crate::{model::AppUpdateStatus, state::AppState};
use serde::Serialize;
use std::{sync::Arc, time::Duration};
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;
#[cfg(desktop)]
use tauri_plugin_updater::UpdaterExt;
#[cfg(target_os = "android")]
use tokio::io::AsyncWriteExt;

#[cfg(any(target_os = "android", test))]
mod android;
mod desktop;
mod github;
mod version;

#[cfg(any(target_os = "android", test))]
use android::*;
use desktop::*;
use github::*;
use version::*;

#[cfg(test)]
mod tests;

#[derive(Clone, Serialize)]
struct AppUpdateProgress {
    phase: &'static str,
    downloaded: u64,
    total: Option<u64>,
    percent: Option<u8>,
}

fn update_download_percent(downloaded: u64, total: Option<u64>) -> Option<u8> {
    let total = total.filter(|value| *value > 0)?;
    Some(((downloaded.min(total).saturating_mul(100)) / total) as u8)
}

fn emit_update_progress(app: &AppHandle, phase: &'static str, downloaded: u64, total: Option<u64>) {
    let payload = AppUpdateProgress {
        phase,
        downloaded,
        total,
        percent: update_download_percent(downloaded, total),
    };
    let _ = app.emit("app-update-progress", payload);
}

fn show_update_available_notification(
    app: &AppHandle,
    version: &str,
    ready_to: &str,
) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        let _ = (app, ready_to);
        apk_install::show_update_available(version)
    }
    #[cfg(not(target_os = "android"))]
    {
        let title = "AI Usage Tracker update available";
        let body = format!("Version {version} is ready to {ready_to}.");
        app.notification()
            .builder()
            .title(title)
            .body(body)
            .show()
            .map_err(|error| error.to_string())
    }
}

/// Tells the user about `version` once, when the check was not silent, automatic updates are on
/// and that version has not been announced yet. `ready_to` is the verb in the notification:
/// "install" when the app can install it itself, "download" when the user fetches it.
fn notify_update_available(
    app: &AppHandle,
    state: &AppState,
    notify: bool,
    version: &str,
    ready_to: &str,
) {
    if notify
        && state.settings.automatic_updates_enabled()
        && state.settings.update_notification_needed(version)
        && show_update_available_notification(app, version, ready_to).is_ok()
    {
        let _ = state.settings.mark_update_notified(version);
    }
}

fn status_from_github_latest(
    current_version: String,
    latest: GitHubLatestRelease,
    app: &AppHandle,
    state: &AppState,
    notify: bool,
) -> AppUpdateStatus {
    if !is_newer_version(&latest.version, &current_version) {
        return AppUpdateStatus::up_to_date(current_version);
    }

    notify_update_available(app, state, notify, &latest.version, "download");

    AppUpdateStatus::available(
        current_version,
        latest.version,
        latest.published_at,
        latest.body,
    )
}

/// The release notes and publish date for the update window. The signed manifest's `notes` have
/// been empty since v0.4.1, so when they are, and GitHub's latest release is the same version, the
/// window shows that release's body and its ISO publish date instead. Anything else stays as the
/// manifest gave it, so a different version's notes are never shown.
fn notes_for_update(
    manifest_body: Option<String>,
    manifest_date: Option<String>,
    version: &str,
    github: Option<&GitHubLatestRelease>,
) -> (Option<String>, Option<String>) {
    if manifest_body
        .as_deref()
        .is_some_and(|body| !body.trim().is_empty())
    {
        return (manifest_body, manifest_date);
    }
    let bare = |value: &str| value.trim().trim_start_matches(['v', 'V']).to_string();
    let Some(release) = github.filter(|release| bare(&release.version) == bare(version)) else {
        return (manifest_body, manifest_date);
    };
    match release
        .body
        .as_deref()
        .filter(|body| !body.trim().is_empty())
    {
        Some(body) => (
            Some(body.to_string()),
            release.published_at.clone().or(manifest_date),
        ),
        None => (manifest_body, manifest_date),
    }
}

pub static PENDING_UPDATE_NOTICE: parking_lot::Mutex<Option<String>> =
    parking_lot::Mutex::new(None);

#[tauri::command]
pub async fn get_pending_update_notice() -> Result<Option<String>, String> {
    Ok(PENDING_UPDATE_NOTICE.lock().take())
}

#[tauri::command]
pub async fn check_for_app_update(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    notify: Option<bool>,
) -> Result<AppUpdateStatus, String> {
    let notify = notify.unwrap_or(true);
    let current_version = app.package_info().version.to_string();

    #[cfg(desktop)]
    {
        // The updater client has no request timeout of its own; bound the
        // manifest fetch so a stalled connection falls through to the GitHub
        // Releases fallback below instead of hanging "Checking…" forever.
        match desktop_updater(&app, state.inner().as_ref()).await {
            Ok(updater) => match tokio::time::timeout(UPDATER_CHECK_TIMEOUT, updater.check()).await
            {
                Ok(Ok(Some(update))) => {
                    let available_version = update.version.to_string();
                    notify_update_available(
                        &app,
                        state.inner().as_ref(),
                        notify,
                        &available_version,
                        "install",
                    );

                    // latest.json carries no release notes, so ask GitHub for them. The GitHub
                    // client has its own timeout, and a failure just leaves the notes empty.
                    let manifest_has_notes = update
                        .body
                        .as_deref()
                        .is_some_and(|body| !body.trim().is_empty());
                    let github = if manifest_has_notes {
                        None
                    } else {
                        fetch_github_latest_release(
                            beta_updates_wanted(state.inner().as_ref()),
                            required_update_asset(),
                        )
                        .await
                        .ok()
                    };
                    let (body, date) = notes_for_update(
                        update.body,
                        update.date.map(|date| date.to_string()),
                        &available_version,
                        github.as_ref(),
                    );
                    return Ok(AppUpdateStatus::available(
                        current_version,
                        available_version,
                        date,
                        body,
                    ));
                }
                Ok(Ok(None)) => {}
                Ok(Err(error)) if updater_error_is_no_release(&error) => {}
                Ok(Err(error)) => {
                    return Ok(AppUpdateStatus::failed(
                        current_version,
                        format!("Unable to check for updates: {error}"),
                    ));
                }
                Err(_) => {
                    crate::diagnostics::info(
                        "App update manifest fetch timed out; using GitHub Releases fallback.",
                    );
                }
            },
            Err(error) => {
                return Ok(AppUpdateStatus::failed(
                    current_version,
                    format!("Unable to initialize the updater: {error}"),
                ));
            }
        }
    }

    // Mobile always uses GitHub Releases. Desktop falls back here when latest.json
    // was not published, so Check Now still sees a newer tag.
    match fetch_github_latest_release(
        beta_updates_wanted(state.inner().as_ref()),
        required_update_asset(),
    )
    .await
    {
        Ok(latest) => Ok(status_from_github_latest(
            current_version,
            latest,
            &app,
            state.inner().as_ref(),
            notify,
        )),
        Err(error) => Ok(AppUpdateStatus::failed(current_version, error)),
    }
}

#[tauri::command]
pub async fn install_app_update(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    #[cfg(desktop)]
    {
        if let Ok(updater) = desktop_updater(&app, state.inner().as_ref()).await {
            // Bound the manifest fetch: the updater client has no timeout, and
            // a stall here used to leave Settings stuck on "Downloading…".
            // On timeout (or when no updater artifact is published) fall
            // through to the releases-page fallback below.
            let checked = tokio::time::timeout(UPDATER_CHECK_TIMEOUT, updater.check()).await;
            if let Ok(Ok(Some(update))) = checked {
                emit_update_progress(&app, "downloading", 0, None);
                let downloaded = std::sync::atomic::AtomicU64::new(0);
                // Bound the whole download+install as well so a mid-download
                // stall surfaces as an error instead of an eternal spinner.
                let result = tokio::time::timeout(
                    UPDATER_INSTALL_TIMEOUT,
                    update.download_and_install(
                        |chunk, total| {
                            let so_far = downloaded
                                .fetch_add(chunk as u64, std::sync::atomic::Ordering::Relaxed)
                                + chunk as u64;
                            emit_update_progress(&app, "downloading", so_far, total);
                        },
                        || {
                            emit_update_progress(&app, "installing", 0, None);
                        },
                    ),
                )
                .await;
                match result {
                    Ok(Ok(())) => {
                        app.restart();
                        #[allow(unreachable_code)]
                        return Ok(());
                    }
                    Ok(Err(error)) => {
                        return Err(format!("Unable to install the update: {error}"));
                    }
                    Err(_) => {
                        return Err(
                            "The update download timed out. Check your connection and try again, or download the installer from the releases page.".into(),
                        );
                    }
                }
            }
        }
    }

    #[cfg(target_os = "android")]
    {
        // Run in its own task so a panic comes back as an error. A panicking
        // command never answers the invoke, which leaves Settings stuck on
        // "Downloading…" with no way out but restarting the app.
        let include_beta = beta_updates_wanted(state.inner().as_ref());
        return tauri::async_runtime::spawn(install_android_apk(app, include_beta))
            .await
            .unwrap_or_else(|_| {
                apk_install::clear_update_notification();
                Err("The update failed unexpectedly. Please try again.".into())
            });
    }

    #[cfg(target_os = "ios")]
    {
        // On iOS / SideStore, in-place app replacement is not allowed from within
        // the app sandbox. Try launching SideStore so the user can refresh/update,
        // or open the GitHub releases page as a fallback.
        let sidestore_url = "sidestore://";
        if app.opener().open_url(sidestore_url, None::<&str>).is_err() {
            open_release_page(&app, state.inner().as_ref()).await?;
        }
        return Ok(());
    }

    #[cfg(all(not(target_os = "android"), not(target_os = "ios")))]
    {
        open_release_page(&app, state.inner().as_ref()).await?;
    }
    Ok(())
}

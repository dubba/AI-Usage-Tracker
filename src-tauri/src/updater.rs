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
use tokio::io::AsyncWriteExt;

const GITHUB_RELEASES_PAGE_URL: &str = "https://github.com/dubba/AI-Usage-Tracker/releases/latest";

const GITHUB_RELEASES_TAG_PAGE_URL: &str =
    "https://github.com/dubba/AI-Usage-Tracker/releases/tag/";

const GITHUB_RELEASES_LIST_URL: &str =
    "https://api.github.com/repos/dubba/AI-Usage-Tracker/releases?per_page=30";

const GITHUB_LATEST_RELEASE_URL: &str =
    "https://api.github.com/repos/dubba/AI-Usage-Tracker/releases/latest";

fn split_version(v: &str) -> (Vec<u64>, Option<String>) {
    let v = v.trim().trim_start_matches(['v', 'V']);
    let numeric_end = v
        .char_indices()
        .find(|(_, ch)| !ch.is_ascii_digit() && *ch != '.')
        .map(|(i, _)| i)
        .unwrap_or(v.len());
    let numeric = v[..numeric_end]
        .split('.')
        .filter_map(|part| {
            if part.is_empty() {
                None
            } else {
                part.parse::<u64>().ok()
            }
        })
        .collect();
    let pre = v[numeric_end..]
        .trim_start_matches(|ch: char| !ch.is_ascii_alphanumeric())
        .to_ascii_lowercase();
    (numeric, if pre.is_empty() { None } else { Some(pre) })
}

fn compare_prerelease(cand: &str, curr: &str) -> bool {
    let cand_tokens: Vec<&str> = cand
        .split(['.', '-', '_'])
        .filter(|s| !s.is_empty())
        .collect();
    let curr_tokens: Vec<&str> = curr
        .split(['.', '-', '_'])
        .filter(|s| !s.is_empty())
        .collect();
    let min_len = cand_tokens.len().min(curr_tokens.len());
    for i in 0..min_len {
        let c = cand_tokens[i];
        let u = curr_tokens[i];
        if c == u {
            continue;
        }
        let c_num = c.parse::<u64>();
        let u_num = u.parse::<u64>();
        match (c_num, u_num) {
            (Ok(cn), Ok(un)) => return cn > un,
            (Ok(_), Err(_)) => return false,
            (Err(_), Ok(_)) => return true,
            (Err(_), Err(_)) => return c > u,
        }
    }
    cand_tokens.len() > curr_tokens.len()
}

fn is_newer_version(candidate: &str, current: &str) -> bool {
    let (cand_parts, cand_pre) = split_version(candidate);
    let (curr_parts, curr_pre) = split_version(current);
    let max_len = cand_parts.len().max(curr_parts.len());
    for i in 0..max_len {
        let cand = cand_parts.get(i).copied().unwrap_or(0);
        let curr = curr_parts.get(i).copied().unwrap_or(0);
        if cand != curr {
            return cand > curr;
        }
    }
    match (cand_pre.as_deref(), curr_pre.as_deref()) {
        (None, Some(_)) => true,
        (Some(_), None) => false,
        (None, None) => false,
        (Some(cand), Some(curr)) => compare_prerelease(cand, curr),
    }
}

/// Only the updater's dedicated "no latest.json / no release metadata" variant
/// is treated as a missing updater manifest. Other errors whose messages happen
/// to contain "not found" (missing platform package, temp dir, archive binary,
/// etc.) are reported to the UI.
#[cfg(any(test, desktop))]
fn updater_error_is_no_release(error: &tauri_plugin_updater::Error) -> bool {
    matches!(error, tauri_plugin_updater::Error::ReleaseNotFound)
}

fn github_latest_http_is_inaccessible(status: reqwest::StatusCode) -> bool {
    matches!(
        status,
        reqwest::StatusCode::NOT_FOUND
            | reqwest::StatusCode::UNAUTHORIZED
            | reqwest::StatusCode::FORBIDDEN
    )
}

struct GitHubLatestRelease {
    version: String,
    tag: String,
    published_at: Option<String>,
    body: Option<String>,
    #[cfg_attr(not(target_os = "android"), allow(dead_code))]
    apk_url: Option<String>,
    #[cfg_attr(not(target_os = "android"), allow(dead_code))]
    apk_sha256_url: Option<String>,
}

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
fn is_expected_apk_name(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    name.ends_with(".apk")
        && !name.contains("unsigned")
        && name
            .replace(['.', '_', ' '], "-")
            .contains("ai-usage-tracker")
}

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
fn apk_assets_from_github(json: &serde_json::Value) -> (Option<String>, Option<String>) {
    let Some(assets) = json.get("assets").and_then(|value| value.as_array()) else {
        return (None, None);
    };
    let mut apk_url = None;
    let mut apk_fallback = None;
    let mut apk_name = None;
    let mut sha_by_name = std::collections::HashMap::new();
    for asset in assets {
        let Some(name) = asset.get("name").and_then(|value| value.as_str()) else {
            continue;
        };
        let Some(url) = asset
            .get("browser_download_url")
            .and_then(|value| value.as_str())
            .map(str::to_string)
        else {
            continue;
        };
        let lower = name.to_ascii_lowercase();
        if lower.ends_with(".apk.sha256") || lower.ends_with(".apk.sha256.txt") {
            let stem = lower
                .trim_end_matches(".txt")
                .trim_end_matches(".sha256")
                .to_string();
            sha_by_name.insert(stem, url);
            continue;
        }
        if !is_expected_apk_name(name) {
            continue;
        }
        let has_arch =
            lower.contains("arm") || lower.contains("x86") || lower.contains("universal");
        if !has_arch && apk_url.is_none() {
            apk_url = Some(url);
            apk_name = Some(lower);
        } else if apk_fallback.is_none() {
            apk_fallback = Some((url, lower));
        }
    }
    let (url, name) = match (apk_url, apk_name) {
        (Some(url), Some(name)) => (Some(url), Some(name)),
        _ => match apk_fallback {
            Some((url, name)) => (Some(url), Some(name)),
            None => (None, None),
        },
    };
    let sha = name.and_then(|name| sha_by_name.remove(&name));
    (url, sha)
}

/// Picks the newest non-draft release from a GitHub `/releases` listing,
/// pre-releases included. GitHub's `/releases/latest` never returns a
/// pre-release, so beta builds are only visible through the listing.
///
/// `required_asset` skips releases that do not carry an asset with that exact
/// name, so a beta published without desktop installers is never offered to
/// desktop users.
fn newest_release_in_listing<'a>(
    listing: &'a serde_json::Value,
    required_asset: Option<&str>,
) -> Option<&'a serde_json::Value> {
    let mut best: Option<(&serde_json::Value, &str)> = None;
    for release in listing.as_array()? {
        if release.get("draft").and_then(|value| value.as_bool()) == Some(true) {
            continue;
        }
        if let Some(name) = required_asset {
            let has_asset = release
                .get("assets")
                .and_then(|value| value.as_array())
                .is_some_and(|assets| {
                    assets.iter().any(|asset| {
                        asset.get("name").and_then(|value| value.as_str()) == Some(name)
                    })
                });
            if !has_asset {
                continue;
            }
        }
        let version = release
            .get("tag_name")
            .and_then(|value| value.as_str())
            .unwrap_or("")
            .trim()
            .trim_start_matches(['v', 'V']);
        if version.is_empty() {
            continue;
        }
        if best.is_none_or(|(_, best_version)| is_newer_version(version, best_version)) {
            best = Some((release, version));
        }
    }
    best.map(|(release, _)| release)
}

async fn fetch_github_latest_release(
    include_prereleases: bool,
    required_asset: Option<&str>,
) -> Result<GitHubLatestRelease, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .build()
        .map_err(|error| format!("Unable to check for updates: {error}"))?;

    let response = client
        .get(if include_prereleases {
            GITHUB_RELEASES_LIST_URL
        } else {
            GITHUB_LATEST_RELEASE_URL
        })
        .header("User-Agent", "AI-Usage-Tracker")
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|error| format!("Unable to check for updates: {error}"))?;

    let status = response.status();
    if github_latest_http_is_inaccessible(status) {
        return Err(format!(
            "Unable to check for updates: GitHub returned HTTP {status}. In-app checks only work when the GitHub repository is public."
        ));
    }
    if !status.is_success() {
        return Err(format!(
            "Unable to check for updates: GitHub returned HTTP {status}"
        ));
    }

    let body = response
        .json::<serde_json::Value>()
        .await
        .map_err(|error| format!("Unable to check for updates: {error}"))?;
    let json = if include_prereleases {
        newest_release_in_listing(&body, required_asset)
            .ok_or("Unable to check for updates: GitHub returned no matching releases.")?
    } else {
        &body
    };
    let tag = json
        .get("tag_name")
        .and_then(|value| value.as_str())
        .unwrap_or("");
    let version = tag.trim().trim_start_matches(['v', 'V']);
    if version.is_empty() {
        return Err(
            "Unable to check for updates: latest GitHub release has no version tag.".into(),
        );
    }

    let (apk_url, apk_sha256_url) = apk_assets_from_github(json);
    Ok(GitHubLatestRelease {
        version: version.to_string(),
        tag: tag.trim().to_string(),
        published_at: json
            .get("published_at")
            .and_then(|value| value.as_str())
            .map(str::to_string),
        body: json
            .get("body")
            .and_then(|value| value.as_str())
            .map(str::to_string),
        apk_url,
        apk_sha256_url,
    })
}

/// Beta releases are an opt-in on every platform. Betas are published as
/// GitHub pre-releases, which `/releases/latest` never returns.
fn beta_updates_wanted(state: &AppState) -> bool {
    state.settings.include_beta_updates()
}

/// Desktop can only install releases that publish the signed updater manifest.
/// Android installs straight from the APK listed on the release.
fn required_update_asset() -> Option<&'static str> {
    cfg!(desktop).then_some("latest.json")
}

/// Updater for the desktop app. With beta releases enabled it is pointed at the
/// newest release's own `latest.json`, because the configured
/// `releases/latest/download/latest.json` endpoint ignores pre-releases. If the
/// release list is unreachable it falls back to the configured stable endpoint.
#[cfg(desktop)]
async fn desktop_updater(
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

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
async fn fetch_apk_sha256(url: &str) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|error| format!("Unable to verify the update checksum: {error}"))?;
    let response = client
        .get(url)
        .header("User-Agent", "AI-Usage-Tracker")
        .send()
        .await
        .map_err(|error| format!("Unable to verify the update checksum: {error}"))?;
    if !response.status().is_success() {
        return Err("Unable to download the update checksum.".into());
    }
    let body = response
        .text()
        .await
        .map_err(|error| format!("Unable to read the update checksum: {error}"))?;
    parse_sha256_digest(&body).ok_or_else(|| "The published update checksum is invalid.".into())
}

fn parse_sha256_digest(body: &str) -> Option<String> {
    let token = body
        .split_whitespace()
        .next()?
        .trim()
        .trim_start_matches("sha256:")
        .to_ascii_lowercase();
    if token.len() == 64 && token.chars().all(|ch| ch.is_ascii_hexdigit()) {
        Some(token)
    } else {
        None
    }
}

const MAX_APK_BYTES: u64 = 250 * 1024 * 1024;

/// Upper bound for the updater manifest fetch in `check_for_app_update` and
/// `install_app_update`. The updater plugin's HTTP client has no timeout of
/// its own, so without this a stalled connection would leave the Settings
/// update button spinning on "Downloading…" forever.
const UPDATER_CHECK_TIMEOUT: Duration = Duration::from_secs(30);

/// Upper bound for the whole download-and-install step. Aborting here is safe:
/// the updater only touches the running app after the full package is
/// downloaded and signature-verified.
const UPDATER_INSTALL_TIMEOUT: Duration = Duration::from_secs(15 * 60);

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

#[cfg(target_os = "android")]
fn notify_android_download_progress(percent: Option<u8>) {
    match percent {
        Some(value) => apk_install::show_download_progress(i32::from(value), false),
        None => apk_install::show_download_progress(0, true),
    }
}

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
async fn download_android_apk(
    app: &AppHandle,
    url: &str,
    dest: &std::path::Path,
) -> Result<String, String> {
    use sha2::{Digest, Sha256};

    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(20))
        .timeout(Duration::from_secs(15 * 60))
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(|error| format!("Unable to download the update: {error}"))?;
    let mut response = client
        .get(url)
        .header("User-Agent", "AI-Usage-Tracker")
        .send()
        .await
        .map_err(|error| format!("Unable to download the update: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "Unable to download the update: GitHub returned HTTP {}",
            response.status()
        ));
    }
    let total = response.content_length();
    if total.is_some_and(|size| size > MAX_APK_BYTES) {
        return Err("The update package is larger than expected.".into());
    }

    if let Some(parent) = dest.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|error| format!("Unable to save the update: {error}"))?;
    }
    let mut file = tokio::fs::File::create(dest)
        .await
        .map_err(|error| format!("Unable to save the update: {error}"))?;
    let mut hasher = Sha256::new();
    let mut downloaded: u64 = 0;
    let mut header = Vec::new();
    let mut last_emit = std::time::Instant::now()
        .checked_sub(Duration::from_secs(1))
        .unwrap_or_else(std::time::Instant::now);

    emit_update_progress(app, "downloading", 0, total);
    #[cfg(target_os = "android")]
    notify_android_download_progress(update_download_percent(0, total));

    let download = async {
        loop {
            let chunk = response
                .chunk()
                .await
                .map_err(|error| format!("Unable to download the update: {error}"))?;
            let Some(chunk) = chunk else {
                break;
            };
            downloaded = downloaded.saturating_add(chunk.len() as u64);
            if downloaded > MAX_APK_BYTES {
                return Err("The update package is larger than expected.".into());
            }
            if header.len() < 4 {
                let take = (4 - header.len()).min(chunk.len());
                header.extend_from_slice(&chunk[..take]);
                if header.len() >= 4 && !header.starts_with(b"PK") {
                    return Err("Downloaded update is not a valid Android package.".into());
                }
            }
            hasher.update(&chunk);
            file.write_all(&chunk)
                .await
                .map_err(|error| format!("Unable to save the update: {error}"))?;
            if last_emit.elapsed() >= Duration::from_millis(200)
                || total.is_some_and(|size| downloaded >= size)
            {
                last_emit = std::time::Instant::now();
                emit_update_progress(app, "downloading", downloaded, total);
                #[cfg(target_os = "android")]
                notify_android_download_progress(update_download_percent(downloaded, total));
            }
        }
        file.flush()
            .await
            .map_err(|error| format!("Unable to save the update: {error}"))?;
        if downloaded < 1024 || !header.starts_with(b"PK") {
            return Err("Downloaded update is not a valid Android package.".into());
        }
        Ok(())
    };

    match download.await {
        Ok(()) => {
            emit_update_progress(app, "downloading", downloaded, total.or(Some(downloaded)));
            #[cfg(target_os = "android")]
            apk_install::show_download_progress(100, false);
            Ok(hasher
                .finalize()
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect())
        }
        Err(error) => {
            let _ = tokio::fs::remove_file(dest).await;
            #[cfg(target_os = "android")]
            apk_install::clear_update_notification();
            Err(error)
        }
    }
}

fn show_update_available_notification(app: &AppHandle, version: &str) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        let _ = app;
        apk_install::show_update_available(version)
    }
    #[cfg(not(target_os = "android"))]
    {
        let title = "AI Usage Tracker update available";
        let body = format!("Version {version} is ready to download.");
        app.notification()
            .builder()
            .title(title)
            .body(body)
            .show()
            .map_err(|error| error.to_string())
    }
}

fn status_from_github_latest(
    current_version: String,
    latest: GitHubLatestRelease,
    app: &AppHandle,
    state: &AppState,
) -> AppUpdateStatus {
    if !is_newer_version(&latest.version, &current_version) {
        return AppUpdateStatus::up_to_date(current_version);
    }

    if state.settings.automatic_updates_enabled()
        && state.settings.update_notification_needed(&latest.version)
    {
        let shown = show_update_available_notification(app, &latest.version);
        if shown.is_ok() {
            let _ = state.settings.mark_update_notified(&latest.version);
        }
    }

    AppUpdateStatus::available(
        current_version,
        latest.version,
        latest.published_at,
        latest.body,
    )
}

pub static PENDING_UPDATE_NOTICE: parking_lot::Mutex<Option<String>> =
    parking_lot::Mutex::new(None);

#[cfg(target_os = "android")]
#[no_mangle]
pub extern "C" fn Java_com_yajinni_paseousagebridge_MainActivity_setPendingUpdateNotice(
    mut env: jni::JNIEnv,
    _class: jni::objects::JClass,
    version: jni::objects::JString,
) {
    if let Ok(ver_str) = env.get_string(&version) {
        let ver_val = ver_str.to_string_lossy().into_owned();
        *PENDING_UPDATE_NOTICE.lock() = Some(ver_val.clone());
        if let Some(app) = crate::commands::pairing::GLOBAL_APP_HANDLE.lock().as_ref() {
            let _ = app.emit("open-update-notes", ver_val);
        }
    }
}

#[tauri::command]
pub async fn get_pending_update_notice() -> Result<Option<String>, String> {
    Ok(PENDING_UPDATE_NOTICE.lock().take())
}

#[tauri::command]
pub async fn check_for_app_update(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
) -> Result<AppUpdateStatus, String> {
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
                    if state.settings.automatic_updates_enabled()
                        && state
                            .settings
                            .update_notification_needed(&available_version)
                    {
                        let shown = app
                            .notification()
                            .builder()
                            .title("AI Usage Tracker update available")
                            .body(format!("Version {available_version} is ready to install."))
                            .show();
                        if shown.is_ok() {
                            let _ = state.settings.mark_update_notified(&available_version);
                        }
                    }

                    return Ok(AppUpdateStatus::available(
                        current_version,
                        available_version,
                        update.date.map(|date| date.to_string()),
                        update.body,
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
        )),
        Err(error) => Ok(AppUpdateStatus::failed(current_version, error)),
    }
}

#[cfg(target_os = "android")]
async fn install_android_apk(app: AppHandle, include_beta: bool) -> Result<(), String> {
    let latest = fetch_github_latest_release(include_beta, required_update_asset()).await?;
    let apk_url = latest
        .apk_url
        .ok_or_else(|| "The latest GitHub release does not include an Android APK.".to_string())?;
    // cacheDir/updates is a FileProvider root; JNI avoids the path-plugin round trip.
    let dest = apk_install::update_download_path()?;
    let digest = download_android_apk(&app, &apk_url, &dest).await?;
    emit_update_progress(&app, "verifying", 0, None);
    let Some(sha_url) = latest.apk_sha256_url.as_deref() else {
        // Fail closed: without a published digest we cannot confirm the
        // download is the release we pointed the user at.
        let _ = tokio::fs::remove_file(&dest).await;
        apk_install::clear_update_notification();
        return Err(
            "The latest release does not include a checksum for the update package.".into(),
        );
    };
    let expected = fetch_apk_sha256(sha_url).await?;
    if expected != digest {
        let _ = tokio::fs::remove_file(&dest).await;
        apk_install::clear_update_notification();
        return Err("The downloaded update did not match the published checksum.".into());
    }
    apk_install::verify_apk_signature(&dest).map_err(|error| {
        apk_install::clear_update_notification();
        error
    })?;
    emit_update_progress(&app, "installing", 0, None);
    apk_install::show_installing();
    apk_install::prompt_apk_install(&dest).map_err(|error| {
        apk_install::clear_update_notification();
        error
    })?;
    apk_install::clear_update_notification();
    Ok(())
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

    #[cfg(not(target_os = "android"))]
    {
        // With betas enabled, open the page of the release being offered rather
        // than /releases/latest, which only ever shows the newest stable one.
        let page = if beta_updates_wanted(state.inner().as_ref()) {
            fetch_github_latest_release(true, required_update_asset())
                .await
                .map(|release| format!("{GITHUB_RELEASES_TAG_PAGE_URL}{}", release.tag))
                .unwrap_or_else(|_| GITHUB_RELEASES_PAGE_URL.to_string())
        } else {
            GITHUB_RELEASES_PAGE_URL.to_string()
        };
        app.opener()
            .open_url(page, None::<&str>)
            .map_err(|error| format!("Unable to open download page: {error}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn beta_listing_picks_the_newest_release_and_skips_drafts() {
        let listing = serde_json::json!([
            { "tag_name": "v0.3.11-beta.1", "draft": true },
            { "tag_name": "v0.3.10-beta.1", "prerelease": true },
            { "tag_name": "v0.3.9", "prerelease": false },
            { "tag_name": "v0.3.10-beta.2", "prerelease": true }
        ]);
        let newest = newest_release_in_listing(&listing, None).unwrap();
        assert_eq!(newest["tag_name"], "v0.3.10-beta.2");

        let stable_wins = serde_json::json!([
            { "tag_name": "v0.3.10-beta.2" },
            { "tag_name": "v0.3.10" }
        ]);
        assert_eq!(
            newest_release_in_listing(&stable_wins, None).unwrap()["tag_name"],
            "v0.3.10"
        );
        assert!(newest_release_in_listing(&serde_json::json!([]), None).is_none());
    }

    #[test]
    fn beta_listing_can_require_a_desktop_updater_manifest() {
        let listing = serde_json::json!([
            { "tag_name": "v0.3.10-beta.1", "assets": [{ "name": "app.apk" }] },
            { "tag_name": "v0.3.9", "assets": [{ "name": "latest.json" }, { "name": "app.apk" }] }
        ]);
        assert_eq!(
            newest_release_in_listing(&listing, Some("latest.json")).unwrap()["tag_name"],
            "v0.3.9"
        );
        assert_eq!(
            newest_release_in_listing(&listing, None).unwrap()["tag_name"],
            "v0.3.10-beta.1"
        );
        assert!(newest_release_in_listing(&listing, Some("missing.json")).is_none());
    }

    #[test]
    fn version_comparison_detects_newer_versions() {
        assert!(is_newer_version("0.3.3", "0.3.2"));
        assert!(is_newer_version("v0.3.3", "0.3.2"));
        assert!(is_newer_version("1.0.0", "0.9.9"));
        assert!(is_newer_version("0.4.0", "0.3.9"));
        assert!(is_newer_version("0.3.3.1", "0.3.3"));

        assert!(!is_newer_version("0.3.2", "0.3.3"));
        assert!(!is_newer_version("0.3.3", "0.3.3"));
        assert!(!is_newer_version("v0.3.3", "v0.3.3"));
        assert!(!is_newer_version("0.2.9", "0.3.0"));

        assert!(is_newer_version("0.3.6", "0.3.6-unrel"));
        assert!(is_newer_version("0.3.6", "0.3.6 unrel"));
        assert!(is_newer_version("0.3.7", "0.3.6-unrel"));
        assert!(is_newer_version("0.3.7-unrel", "0.3.6"));
        assert!(!is_newer_version("0.3.6", "0.3.7-unrel"));
        assert!(!is_newer_version("0.3.6-unrel", "0.3.6"));
        assert!(!is_newer_version("0.3.6-unrel", "0.3.6-unrel"));
        assert!(is_newer_version("0.3.7-unrel.2", "0.3.7-unrel.1"));
        assert!(is_newer_version("0.3.7-unrel.10", "0.3.7-unrel.2"));
        assert!(!is_newer_version("0.3.7-unrel.2", "0.3.7-unrel.10"));
        assert!(is_newer_version("V0.3.6", "0.3.6-unrel"));
    }

    #[test]
    fn expected_apk_asset_names_match_this_app() {
        assert!(is_expected_apk_name("AI Usage Tracker_0.3.6.apk"));
        assert!(is_expected_apk_name("ai-usage-tracker-0.3.6.apk"));
        assert!(is_expected_apk_name("AI.Usage.Tracker_0.3.8.apk"));
        assert!(!is_expected_apk_name("other-app.apk"));
        assert!(!is_expected_apk_name("AI Usage Tracker_0.3.6-unsigned.apk"));
        assert!(!is_expected_apk_name("AI Usage Tracker_0.3.6.apk.sha256"));
    }

    #[test]
    fn sha256_digest_parses_common_checksum_files() {
        assert_eq!(
            parse_sha256_digest(
                "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef  AI Usage Tracker_0.3.6.apk\n"
            )
            .as_deref(),
            Some("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef")
        );
        assert!(parse_sha256_digest("not-a-hash").is_none());
    }

    #[cfg(any(test, desktop))]
    #[test]
    fn updater_errors_containing_not_found_are_not_all_up_to_date() {
        use tauri_plugin_updater::Error;

        assert!(updater_error_is_no_release(&Error::ReleaseNotFound));
        assert!(!updater_error_is_no_release(&Error::TargetNotFound(
            "darwin-aarch64".into()
        )));
        assert!(!updater_error_is_no_release(&Error::TargetsNotFound(vec![
            "darwin-aarch64".into()
        ])));
        assert!(!updater_error_is_no_release(&Error::Network(
            "404 not found".into()
        )));
        assert!(!updater_error_is_no_release(&Error::TempDirNotFound));
        assert!(!updater_error_is_no_release(
            &Error::BinaryNotFoundInArchive
        ));
    }

    #[test]
    fn github_inaccessible_statuses_are_not_treated_as_success() {
        assert!(github_latest_http_is_inaccessible(
            reqwest::StatusCode::NOT_FOUND
        ));
        assert!(github_latest_http_is_inaccessible(
            reqwest::StatusCode::FORBIDDEN
        ));
        assert!(github_latest_http_is_inaccessible(
            reqwest::StatusCode::UNAUTHORIZED
        ));
        assert!(!github_latest_http_is_inaccessible(
            reqwest::StatusCode::INTERNAL_SERVER_ERROR
        ));
        assert!(!github_latest_http_is_inaccessible(reqwest::StatusCode::OK));
        assert!(!github_latest_http_is_inaccessible(
            reqwest::StatusCode::NO_CONTENT
        ));
    }

    #[test]
    fn update_download_percent_scales_and_handles_unknown_total() {
        assert_eq!(super::update_download_percent(0, Some(100)), Some(0));
        assert_eq!(super::update_download_percent(50, Some(100)), Some(50));
        assert_eq!(super::update_download_percent(100, Some(100)), Some(100));
        assert_eq!(super::update_download_percent(12, None), None);
        assert_eq!(super::update_download_percent(1, Some(0)), None);
    }

    #[test]
    fn apk_url_prefers_unadorned_apk_asset() {
        let json = serde_json::json!({
            "assets": [
                {
                    "name": "AI.Usage.Tracker_0.3.5_aarch64.app.tar.gz",
                    "browser_download_url": "https://example.com/app.tar.gz"
                },
                {
                    "name": "AI.Usage.Tracker_0.3.5.apk",
                    "browser_download_url": "https://example.com/app.apk"
                }
            ]
        });
        assert_eq!(
            super::apk_assets_from_github(&json).0.as_deref(),
            Some("https://example.com/app.apk")
        );
    }

    #[test]
    fn apk_assets_match_github_dotted_release_names_and_checksum() {
        let json = serde_json::json!({
            "assets": [
                {
                    "name": "AI.Usage.Tracker_0.3.8.apk",
                    "browser_download_url": "https://github.com/dubba/AI-Usage-Tracker/releases/download/v0.3.8/AI.Usage.Tracker_0.3.8.apk"
                },
                {
                    "name": "AI.Usage.Tracker_0.3.8.apk.sha256",
                    "browser_download_url": "https://github.com/dubba/AI-Usage-Tracker/releases/download/v0.3.8/AI.Usage.Tracker_0.3.8.apk.sha256"
                }
            ]
        });
        let (apk, sha) = super::apk_assets_from_github(&json);
        assert_eq!(
            apk.as_deref(),
            Some("https://github.com/dubba/AI-Usage-Tracker/releases/download/v0.3.8/AI.Usage.Tracker_0.3.8.apk")
        );
        assert_eq!(
            sha.as_deref(),
            Some("https://github.com/dubba/AI-Usage-Tracker/releases/download/v0.3.8/AI.Usage.Tracker_0.3.8.apk.sha256")
        );
    }
}

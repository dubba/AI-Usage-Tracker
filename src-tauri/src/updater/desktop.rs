use super::*;

/// Only the updater's dedicated "no latest.json / no release metadata" variant
/// is treated as a missing updater manifest. Other errors whose messages happen
/// to contain "not found" (missing platform package, temp dir, archive binary,
/// etc.) are reported to the UI.
#[cfg(any(test, desktop))]
pub(super) fn updater_error_is_no_release(error: &tauri_plugin_updater::Error) -> bool {
    matches!(error, tauri_plugin_updater::Error::ReleaseNotFound)
}

/// `action` and why the updater failed, for the update status or the install error. A failed
/// request gets the same sentence as other requests (`providers::request_failed`), because its
/// own text names the request URL.
#[cfg(any(test, desktop))]
pub(super) fn updater_failure(action: &str, error: &tauri_plugin_updater::Error) -> String {
    match error {
        tauri_plugin_updater::Error::Reqwest(error) => crate::providers::request_failed_with(
            action,
            crate::providers::Transport {
                timeout: error.is_timeout(),
                connect: error.is_connect(),
                unreadable: error.is_decode() || error.is_body(),
            },
            &error.to_string(),
        ),
        other => format!("{action}: {other}"),
    }
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
                return release_only_updater(app).endpoints(vec![url])?.build();
            }
        }
    }
    release_only_updater(app).build()
}

/// The updater builder, with its HTTP client (manifest and package downloads
/// alike) limited to following redirects between GitHub's download hosts, the
/// same rule the Android download uses. The plugin's own client follows
/// redirects anywhere.
#[cfg(desktop)]
fn release_only_updater(app: &AppHandle) -> tauri_plugin_updater::UpdaterBuilder {
    app.updater_builder()
        .configure_client(|client| client.redirect(release_only_redirects()))
}

/// [`release_download_redirects`] for the updater plugin's own copy of reqwest,
/// which is a different version from the app's, so its `Policy` is a different
/// type. The rule is the same: at most 10 hops, each to a GitHub download host.
#[cfg(desktop)]
fn release_only_redirects() -> reqwest_updater::redirect::Policy {
    reqwest_updater::redirect::Policy::custom(|attempt| {
        if attempt.previous().len() >= 10 {
            attempt.error("too many redirects")
        } else if is_release_download_host(attempt.url()) {
            attempt.follow()
        } else {
            attempt.error("the update download was redirected away from GitHub")
        }
    })
}

/// A client with the desktop updater's redirect policy, for the tests.
#[cfg(all(test, desktop))]
pub(super) fn release_only_redirects_for_tests() -> reqwest_updater::Client {
    reqwest_updater::Client::builder()
        .redirect(release_only_redirects())
        .build()
        .unwrap()
}

/// Largest desktop update package the app will download. Installers are tens
/// of megabytes; this matches the Android limit.
#[cfg(any(desktop, test))]
pub(super) const MAX_DESKTOP_UPDATE_BYTES: u64 = 250 * 1024 * 1024;

/// The only places a desktop update package may come from: an asset of this
/// repository's releases, either by its download address or by the API address
/// `latest.json` lists (`api.github.com/repos/…/releases/assets/<id>`, which
/// redirects to GitHub's storage hosts). The manifest is signed by the same
/// key as the package, so this only matters when the manifest is not what we
/// expect, but it keeps the app from fetching from anywhere else.
#[cfg(any(desktop, test))]
pub(super) fn update_download_allowed(url: &tauri::Url) -> bool {
    if is_repo_release_asset_url(url.as_str()) {
        return true;
    }
    url.scheme() == "https"
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
        && url.host_str() == Some("api.github.com")
        && url
            .path()
            .strip_prefix(RELEASE_ASSET_API_PATH_PREFIX)
            .is_some_and(|id| !id.is_empty() && id.bytes().all(|byte| byte.is_ascii_digit()))
}

#[cfg(any(desktop, test))]
const RELEASE_ASSET_API_PATH_PREFIX: &str = "/repos/dubba/AI-Usage-Tracker/releases/assets/";

/// Counts the bytes of an update download as they arrive and says when it is
/// larger than [`MAX_DESKTOP_UPDATE_BYTES`], by its announced size or by what
/// has actually arrived. The updater plugin buffers the whole package, so
/// dropping its future when [`DownloadCap::exceeded`] completes is what stops it.
#[cfg(any(desktop, test))]
pub(super) struct DownloadCap {
    downloaded: std::sync::atomic::AtomicU64,
    exceeded: tokio::sync::Notify,
}

#[cfg(any(desktop, test))]
impl DownloadCap {
    pub(super) fn new() -> Self {
        Self {
            downloaded: std::sync::atomic::AtomicU64::new(0),
            exceeded: tokio::sync::Notify::new(),
        }
    }

    /// Records a chunk and returns the bytes received so far.
    pub(super) fn record(&self, chunk: usize, announced_total: Option<u64>) -> u64 {
        let so_far = self
            .downloaded
            .fetch_add(chunk as u64, std::sync::atomic::Ordering::Relaxed)
            + chunk as u64;
        if so_far > MAX_DESKTOP_UPDATE_BYTES
            || announced_total.is_some_and(|total| total > MAX_DESKTOP_UPDATE_BYTES)
        {
            self.exceeded.notify_one();
        }
        so_far
    }

    /// Completes once a recorded chunk showed the download is too large.
    pub(super) async fn exceeded(&self) {
        self.exceeded.notified().await;
    }
}

/// Upper bound for the updater manifest fetch in `check_for_app_update` and
/// `install_app_update`. The updater plugin's HTTP client has no timeout of
/// its own, so without this a stalled connection would leave the Settings
/// update button spinning on "Downloading…" forever.
#[cfg(any(desktop, test))]
pub(super) const UPDATER_CHECK_TIMEOUT: Duration = Duration::from_secs(30);

/// Upper bound for the whole download-and-install step. Aborting here is safe:
/// the updater only touches the running app after the full package is
/// downloaded and signature-verified.
#[cfg(any(desktop, test))]
pub(super) const UPDATER_INSTALL_TIMEOUT: Duration = Duration::from_secs(15 * 60);

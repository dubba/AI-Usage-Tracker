#[cfg(target_os = "android")]
use super::*;

/// Hosts a release download may be redirected through: GitHub itself, then the
/// storage hosts it hands asset downloads to.
pub(super) const RELEASE_DOWNLOAD_HOSTS: &[&str] = &[
    "github.com",
    "objects.githubusercontent.com",
    "release-assets.githubusercontent.com",
];

/// A hop an update download may follow: HTTPS on one of GitHub's download hosts.
pub(super) fn is_release_download_host(url: &reqwest::Url) -> bool {
    url.scheme() == "https"
        && url.port().is_none()
        && url
            .host_str()
            .is_some_and(|host| RELEASE_DOWNLOAD_HOSTS.contains(&host))
}

/// Redirect policy for update downloads: at most 10 hops, each to a GitHub
/// download host. A redirect anywhere else fails the download.
pub(super) fn release_download_redirects() -> reqwest::redirect::Policy {
    reqwest::redirect::Policy::custom(|attempt| {
        if attempt.previous().len() >= 10 {
            attempt.error("too many redirects")
        } else if is_release_download_host(attempt.url()) {
            attempt.follow()
        } else {
            attempt.error("the update download was redirected away from GitHub")
        }
    })
}

/// The version an update notification refers to, in the form our own
/// notification sends (`0.4.1`, `0.4.2-beta.1`, optionally with a leading `v`).
/// The value arrives as an intent extra that any installed app can set, so
/// anything else is ignored rather than shown in the update dialog.
pub(super) fn is_update_notice_version(value: &str) -> bool {
    let core = value.strip_prefix(['v', 'V']).unwrap_or(value);
    let (numbers, prerelease) = match core.split_once('-') {
        Some((numbers, prerelease)) => (numbers, Some(prerelease)),
        None => (core, None),
    };
    value.len() <= 32
        && numbers.split('.').count() == 3
        && numbers
            .split('.')
            .all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
        && prerelease.is_none_or(|tag| {
            !tag.is_empty()
                && tag
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'.')
        })
}

#[cfg(target_os = "android")]
pub(super) async fn fetch_apk_sha256(url: &str) -> Result<String, String> {
    if !is_repo_release_asset_url(url) {
        return Err("The update checksum is not hosted on this app's GitHub releases.".into());
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .redirect(release_download_redirects())
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

pub(super) fn parse_sha256_digest(body: &str) -> Option<String> {
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

#[cfg(target_os = "android")]
pub(super) const MAX_APK_BYTES: u64 = 250 * 1024 * 1024;

#[cfg(target_os = "android")]
pub(super) fn notify_android_download_progress(percent: Option<u8>) {
    match percent {
        Some(value) => apk_install::show_download_progress(i32::from(value), false),
        None => apk_install::show_download_progress(0, true),
    }
}

#[cfg(target_os = "android")]
pub(super) async fn download_android_apk(
    app: &AppHandle,
    url: &str,
    dest: &std::path::Path,
) -> Result<String, String> {
    use sha2::{Digest, Sha256};

    if !is_repo_release_asset_url(url) {
        return Err("The update is not hosted on this app's GitHub releases.".into());
    }
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(20))
        .timeout(Duration::from_secs(15 * 60))
        .redirect(release_download_redirects())
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

#[cfg(target_os = "android")]
pub(super) async fn install_android_apk(app: AppHandle, include_beta: bool) -> Result<(), String> {
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

#[cfg(target_os = "android")]
#[no_mangle]
pub extern "C" fn Java_com_dubba_ai_usage_tracker_MainActivity_setPendingUpdateNotice(
    mut env: jni::JNIEnv,
    _class: jni::objects::JClass,
    version: jni::objects::JString,
) {
    if let Ok(ver_str) = env.get_string(&version) {
        let ver_val = ver_str.to_string_lossy().into_owned();
        if !is_update_notice_version(&ver_val) {
            return;
        }
        *PENDING_UPDATE_NOTICE.lock() = Some(ver_val.clone());
        if let Some(app) = crate::commands::pairing::GLOBAL_APP_HANDLE.lock().as_ref() {
            let _ = app.emit("open-update-notes", ver_val);
        }
    }
}

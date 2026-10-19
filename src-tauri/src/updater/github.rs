use super::*;

pub(super) const GITHUB_RELEASES_PAGE_URL: &str =
    "https://github.com/dubba/AI-Usage-Tracker/releases/latest";

pub(super) const GITHUB_RELEASES_TAG_PAGE_URL: &str =
    "https://github.com/dubba/AI-Usage-Tracker/releases/tag/";

pub(super) const GITHUB_RELEASES_LIST_URL: &str =
    "https://api.github.com/repos/dubba/AI-Usage-Tracker/releases?per_page=30";

pub(super) const GITHUB_LATEST_RELEASE_URL: &str =
    "https://api.github.com/repos/dubba/AI-Usage-Tracker/releases/latest";

/// Where this repository's release assets are downloaded from. The API's
/// `browser_download_url` is always under this prefix.
pub(super) const RELEASE_ASSET_URL_PREFIX: &str =
    "https://github.com/dubba/AI-Usage-Tracker/releases/download/";

/// A release asset of this repository, as listed by the GitHub API. Anything
/// else in a release listing is ignored, so a tampered or misdirected API
/// response cannot point the updater at another host.
pub(super) fn is_repo_release_asset_url(url: &str) -> bool {
    // Checked on the parsed URL, so `..` segments, a `user@` prefix, or a port
    // cannot make a different URL look like it starts with the prefix.
    reqwest::Url::parse(url).is_ok_and(|url| {
        url.scheme() == "https"
            && url.port().is_none()
            && url.username().is_empty()
            && url.host_str() == Some("github.com")
            && url.as_str().starts_with(RELEASE_ASSET_URL_PREFIX)
    })
}

/// A release tag safe to place in a URL path: letters, digits, `.`, `-`, `_`,
/// such as `v0.4.1` or `v0.4.2-beta.1`. Rejects `/`, `?`, `#`, `%`, and `..`,
/// which would change which page or file a URL built from it points at.
pub(super) fn is_safe_release_tag(tag: &str) -> bool {
    !tag.is_empty()
        && tag.len() <= 64
        && !tag.contains("..")
        && tag
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
}

pub(super) fn github_latest_http_is_inaccessible(status: reqwest::StatusCode) -> bool {
    matches!(
        status,
        reqwest::StatusCode::NOT_FOUND
            | reqwest::StatusCode::UNAUTHORIZED
            | reqwest::StatusCode::FORBIDDEN
    )
}

pub(super) struct GitHubLatestRelease {
    pub(super) version: String,
    pub(super) tag: String,
    pub(super) published_at: Option<String>,
    pub(super) body: Option<String>,
    // Only the Android installer reads the two APK addresses.
    #[cfg_attr(not(target_os = "android"), allow(dead_code))]
    pub(super) apk_url: Option<String>,
    #[cfg_attr(not(target_os = "android"), allow(dead_code))]
    pub(super) apk_sha256_url: Option<String>,
}

pub(super) fn is_expected_apk_name(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    name.ends_with(".apk")
        && !name.contains("unsigned")
        && name
            .replace(['.', '_', ' '], "-")
            .contains("ai-usage-tracker")
}

pub(super) fn apk_assets_from_github(json: &serde_json::Value) -> (Option<String>, Option<String>) {
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
            .filter(|url| is_repo_release_asset_url(url))
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
pub(super) fn newest_release_in_listing<'a>(
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

pub(super) async fn fetch_github_latest_release(
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
    // The tag is placed in URLs (beta manifest, release page), so it must not be
    // able to change their path or add a query.
    if !is_safe_release_tag(tag.trim()) {
        return Err(
            "Unable to check for updates: the latest GitHub release has an unexpected tag.".into(),
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
pub(super) fn beta_updates_wanted(state: &AppState) -> bool {
    state.settings.include_beta_updates()
}

/// Desktop can only install releases that publish the signed updater manifest.
/// Android installs straight from the APK listed on the release.
pub(super) fn required_update_asset() -> Option<&'static str> {
    cfg!(desktop).then_some("latest.json")
}

/// Opens the page to download the update from in the browser. With betas enabled that is the page
/// of the release being offered rather than `/releases/latest`, which only ever shows the newest
/// stable one.
#[cfg(not(target_os = "android"))]
pub(super) async fn open_release_page(app: &AppHandle, state: &AppState) -> Result<(), String> {
    let page = if beta_updates_wanted(state) {
        fetch_github_latest_release(true, required_update_asset())
            .await
            .map(|release| format!("{GITHUB_RELEASES_TAG_PAGE_URL}{}", release.tag))
            .unwrap_or_else(|_| GITHUB_RELEASES_PAGE_URL.to_string())
    } else {
        GITHUB_RELEASES_PAGE_URL.to_string()
    };
    app.opener()
        .open_url(page, None::<&str>)
        .map_err(|error| format!("Unable to open download page: {error}"))
}

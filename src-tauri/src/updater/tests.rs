fn github_release(
    version: &str,
    body: Option<&str>,
    published_at: Option<&str>,
) -> GitHubLatestRelease {
    GitHubLatestRelease {
        version: version.to_string(),
        tag: format!("v{version}"),
        published_at: published_at.map(str::to_string),
        body: body.map(str::to_string),
        apk_url: None,
        apk_sha256_url: None,
    }
}

#[test]
fn notes_from_the_manifest_are_kept() {
    let release = github_release("0.4.6", Some("From GitHub"), Some("2026-10-17T03:41:55Z"));
    let (body, date) = notes_for_update(
        Some("From the manifest".into()),
        Some("2026-10-17 3:51:37.748 +00:00:00".into()),
        "0.4.6",
        Some(&release),
    );
    assert_eq!(body.as_deref(), Some("From the manifest"));
    assert_eq!(date.as_deref(), Some("2026-10-17 3:51:37.748 +00:00:00"));
}

#[test]
fn empty_manifest_notes_use_the_matching_github_release() {
    let release = github_release(
        "0.4.6",
        Some("## v0.4.6\n\n- A change."),
        Some("2026-10-17T03:41:55Z"),
    );
    for empty in [None, Some(String::new()), Some("  \n".to_string())] {
        let (body, date) = notes_for_update(
            empty,
            Some("2026-10-17 3:51:37.748 +00:00:00".into()),
            "v0.4.6",
            Some(&release),
        );
        assert_eq!(body.as_deref(), Some("## v0.4.6\n\n- A change."));
        assert_eq!(date.as_deref(), Some("2026-10-17T03:41:55Z"));
    }
}

#[test]
fn another_versions_notes_are_never_used() {
    let release = github_release("0.4.7", Some("Newer notes"), Some("2026-10-18T00:00:00Z"));
    let (body, date) = notes_for_update(
        Some(String::new()),
        Some("2026-10-17 3:51:37.748 +00:00:00".into()),
        "0.4.6",
        Some(&release),
    );
    assert_eq!(body.as_deref(), Some(""));
    assert_eq!(date.as_deref(), Some("2026-10-17 3:51:37.748 +00:00:00"));
}

#[test]
fn missing_github_data_leaves_the_manifest_values() {
    let (body, date) = notes_for_update(
        None,
        Some("2026-10-17 3:51:37.748 +00:00:00".into()),
        "0.4.6",
        None,
    );
    assert_eq!(body, None);
    assert_eq!(date.as_deref(), Some("2026-10-17 3:51:37.748 +00:00:00"));

    let no_body = github_release("0.4.6", None, Some("2026-10-17T03:41:55Z"));
    let (body, date) = notes_for_update(
        None,
        Some("2026-10-17 3:51:37.748 +00:00:00".into()),
        "0.4.6",
        Some(&no_body),
    );
    assert_eq!(body, None);
    assert_eq!(date.as_deref(), Some("2026-10-17 3:51:37.748 +00:00:00"));
}

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
                "browser_download_url": "https://github.com/dubba/AI-Usage-Tracker/releases/download/v0.3.5/app.tar.gz"
            },
            {
                "name": "AI.Usage.Tracker_0.3.5.apk",
                "browser_download_url": "https://github.com/dubba/AI-Usage-Tracker/releases/download/v0.3.5/app.apk"
            }
        ]
    });
    assert_eq!(
        super::apk_assets_from_github(&json).0.as_deref(),
        Some("https://github.com/dubba/AI-Usage-Tracker/releases/download/v0.3.5/app.apk")
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

#[test]
fn release_asset_urls_must_be_this_repos_github_releases() {
    let ok = "https://github.com/dubba/AI-Usage-Tracker/releases/download/v0.4.1/AI.Usage.Tracker_0.4.1.apk";
    assert!(super::is_repo_release_asset_url(ok));
    for bad in [
        "http://github.com/dubba/AI-Usage-Tracker/releases/download/v0.4.1/app.apk",
        "https://evil.example/dubba/AI-Usage-Tracker/releases/download/v0.4.1/app.apk",
        "https://github.com.evil.example/dubba/AI-Usage-Tracker/releases/download/v0.4.1/app.apk",
        "https://evil@github.com/dubba/AI-Usage-Tracker/releases/download/v0.4.1/app.apk",
        "https://github.com:8443/dubba/AI-Usage-Tracker/releases/download/v0.4.1/app.apk",
        "https://github.com/someone/else/releases/download/v0.4.1/app.apk",
        "https://github.com/dubba/AI-Usage-Tracker/releases/download/../../../someone/else/app.apk",
        "https://objects.githubusercontent.com/app.apk",
        "not a url",
    ] {
        assert!(!super::is_repo_release_asset_url(bad), "{bad}");
    }
}

#[test]
fn apk_assets_hosted_elsewhere_are_ignored() {
    let json = serde_json::json!({
        "assets": [
            {
                "name": "AI.Usage.Tracker_0.4.1.apk",
                "browser_download_url": "https://evil.example/AI.Usage.Tracker_0.4.1.apk"
            },
            {
                "name": "AI.Usage.Tracker_0.4.1.apk.sha256",
                "browser_download_url": "https://evil.example/AI.Usage.Tracker_0.4.1.apk.sha256"
            }
        ]
    });
    assert_eq!(super::apk_assets_from_github(&json), (None, None));
}

#[test]
fn update_redirects_stay_on_github_download_hosts() {
    for ok in [
        "https://github.com/dubba/AI-Usage-Tracker/releases/download/v1/a.apk",
        "https://objects.githubusercontent.com/github-production-release-asset/1",
        "https://release-assets.githubusercontent.com/github-production-release-asset/1",
    ] {
        assert!(
            super::is_release_download_host(&ok.parse().unwrap()),
            "{ok}"
        );
    }
    for bad in [
        "http://objects.githubusercontent.com/a.apk",
        "https://evil.example/a.apk",
        "https://objects.githubusercontent.com.evil.example/a.apk",
        "https://release-assets.githubusercontent.com:8443/a.apk",
    ] {
        assert!(
            !super::is_release_download_host(&bad.parse().unwrap()),
            "{bad}"
        );
    }
}

#[tokio::test]
async fn update_download_client_refuses_a_redirect_off_github() {
    use axum::{response::Redirect, routing::get, Router};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let router = Router::new().route(
        "/",
        get(|| async { Redirect::temporary("https://evil.example/app.apk") }),
    );
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });

    let client = reqwest::Client::builder()
        .redirect(super::release_download_redirects())
        .build()
        .unwrap();
    let error = client
        .get(format!("http://{address}/"))
        .send()
        .await
        .expect_err("a redirect to another host must fail the download");
    assert!(error.is_redirect(), "{error}");
}

#[test]
fn release_tags_are_checked_before_they_go_into_urls() {
    for ok in ["v0.4.1", "v0.4.2-beta.1", "0.4.0", "v1_2"] {
        assert!(super::is_safe_release_tag(ok), "{ok}");
    }
    for bad in [
        "",
        "v1/../../other",
        "v1/latest.json",
        "v1?x=1",
        "v1#x",
        "v1%2Fx",
        "..",
        "v1 2",
        "v1\\x",
        &"v".repeat(65),
    ] {
        assert!(!super::is_safe_release_tag(bad), "{bad}");
    }
}

#[test]
fn update_notice_accepts_only_version_shaped_values() {
    for ok in ["0.4.1", "v0.4.1", "0.4.2-beta.1", "10.20.30-rc1"] {
        assert!(super::is_update_notice_version(ok), "{ok}");
    }
    for bad in [
        "",
        "0.4",
        "0.4.1.2",
        "0.4.x",
        "v",
        "0.4.1-",
        "0.4.1-beta 1",
        "0.4.1\nWhat changed",
        "Click here to log in again",
        "0.4.1-<b>beta</b>",
        &format!("0.4.1-{}", "a".repeat(40)),
    ] {
        assert!(!super::is_update_notice_version(bad), "{bad:?}");
    }
}

fn click_extras(
    kind: &str,
    version: serde_json::Value,
) -> std::collections::HashMap<String, serde_json::Value> {
    [
        ("kind".to_string(), serde_json::json!(kind)),
        ("version".to_string(), version),
    ]
    .into_iter()
    .collect()
}

#[test]
fn clicking_the_update_notification_opens_the_notes_for_its_version() {
    let extras = click_extras("update-available", serde_json::json!("0.4.9"));
    assert_eq!(
        super::update_notice_for_click("tap", &extras, None, None).as_deref(),
        Some("0.4.9")
    );
}

#[test]
fn the_whats_new_button_opens_the_notes_too() {
    let extras = click_extras("update-available", serde_json::json!("0.4.9"));
    assert_eq!(
        super::update_notice_for_click("open-notes", &extras, None, None).as_deref(),
        Some("0.4.9")
    );
}

#[test]
fn other_clicks_and_notifications_do_not_open_the_update_notes() {
    let update = click_extras("update-available", serde_json::json!("0.4.9"));
    // A dismissal or another button is not a click on the notification or its button.
    assert_eq!(
        super::update_notice_for_click("dismiss", &update, None, None),
        None
    );
    assert_eq!(
        super::update_notice_for_click("snooze", &update, None, None),
        None
    );
    // The usage-alert notifications carry no marker.
    assert_eq!(
        super::update_notice_for_click("tap", &Default::default(), None, None),
        None
    );
    let other = click_extras("usage-alert", serde_json::json!("0.4.9"));
    assert_eq!(
        super::update_notice_for_click("tap", &other, None, None),
        None
    );
    // The version is shown in the update window, so only a version-shaped value is accepted.
    for bad in [
        serde_json::json!("Click here to log in again"),
        serde_json::json!("0.4.9\nWhat changed"),
        serde_json::json!(5),
        serde_json::Value::Null,
    ] {
        let extras = click_extras("update-available", bad.clone());
        assert_eq!(
            super::update_notice_for_click("tap", &extras, None, None),
            None,
            "{bad}"
        );
    }
}

#[test]
fn a_click_reported_by_the_notification_plugin_carries_the_update_extras() {
    // The shape the plugin reports a tap in, on desktop and iOS alike.
    let performed: tauri_plugin_notification::ActionPerformed =
        serde_json::from_value(serde_json::json!({
            "actionId": "tap",
            "inputValue": null,
            "notification": {
                "id": 1,
                "title": "AI Usage Tracker update available",
                "body": "Version 0.4.9 is ready to install.",
                "extra": { "kind": "update-available", "version": "0.4.9" }
            }
        }))
        .unwrap();
    let extra = performed.notification().unwrap().extra();
    assert_eq!(
        super::update_notice_for_click(
            performed.action_id(),
            extra,
            performed.notification().unwrap().title(),
            performed.notification().unwrap().body(),
        )
        .as_deref(),
        Some("0.4.9")
    );
}

#[test]
fn a_tap_without_extras_is_recognised_by_the_notifications_own_text() {
    // iOS reports only the title and body of the tapped notification, never its extras.
    let body = super::update_notification_body("0.4.9", "download");
    let none = Default::default();
    assert_eq!(
        super::update_notice_for_click(
            "tap",
            &none,
            Some(super::UPDATE_NOTIFICATION_TITLE),
            Some(&body)
        )
        .as_deref(),
        Some("0.4.9")
    );
    // Other notifications, such as a usage alert, are not matched.
    assert_eq!(
        super::update_notice_for_click("tap", &none, Some("Usage alert"), Some(&body)),
        None
    );
    for bad_body in [
        "Version  is ready to install.",
        "Version Click here to log in again is ready to install.",
        "Your Codex limit is almost used.",
    ] {
        assert_eq!(
            super::update_notice_for_click(
                "tap",
                &none,
                Some(super::UPDATE_NOTIFICATION_TITLE),
                Some(bad_body)
            ),
            None,
            "{bad_body}"
        );
    }
    assert_eq!(
        super::update_notice_for_click("tap", &none, Some(super::UPDATE_NOTIFICATION_TITLE), None),
        None
    );
}

#[test]
fn vendored_notification_plugin_keeps_the_ios_crash_fix() {
    // tauri-plugin-notification force-unwrapped its in-memory notification map, so tapping a
    // notification after iOS terminated the app crashed it (tauri-apps/plugins-workspace#3533).
    // The app builds a patched copy; drop both once a released plugin has the fix
    // (src-tauri/vendor/tauri-plugin-notification/VENDORED.md).
    let swift = include_str!(
        "../../vendor/tauri-plugin-notification/ios/Sources/NotificationHandler.swift"
    );
    assert!(
        !swift.contains("notificationsMap[request.identifier]!"),
        "the vendored plugin force-unwraps the notification map again"
    );
    assert!(swift.contains("notificationRequest?.sound"));
    let manifest = include_str!("../../Cargo.toml");
    assert!(
        manifest.contains(
            "tauri-plugin-notification = { path = \"vendor/tauri-plugin-notification\" }"
        ),
        "src-tauri/Cargo.toml no longer patches in the vendored notification plugin"
    );
}

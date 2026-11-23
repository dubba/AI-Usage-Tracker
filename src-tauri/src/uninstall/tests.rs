use super::*;
use std::ffi::OsString;

fn args(list: &[&str]) -> impl Iterator<Item = OsString> {
    list.iter()
        .map(OsString::from)
        .collect::<Vec<_>>()
        .into_iter()
}

#[test]
fn only_the_flag_alone_starts_the_cleanup() {
    assert!(requested(args(&["app.exe", FLAG])));
    assert!(!requested(args(&["app.exe"])));
    assert!(!requested(args(&["app.exe", FLAG, "--autostart"])));
    assert!(!requested(args(&["app.exe", "--autostart", FLAG])));
    assert!(!requested(args(&["app.exe", "--uninstall-cleanup=1"])));
    assert!(!requested(args(&[])));
}

#[test]
fn the_data_folder_is_removed_with_everything_in_it() {
    let parent = tempfile::tempdir().unwrap();
    let dir = parent.path().join(BUNDLE_ID);
    std::fs::create_dir_all(dir.join("logs")).unwrap();
    std::fs::write(dir.join("logs/app.log"), "x").unwrap();
    std::fs::write(parent.path().join("other-app.json"), "kept").unwrap();

    remove_data_dir(parent.path()).unwrap();
    assert!(!dir.exists());
    assert!(parent.path().join("other-app.json").exists());
    // Already gone is fine.
    remove_data_dir(parent.path()).unwrap();
}

#[cfg(unix)]
#[test]
fn a_link_at_the_data_folder_is_not_followed() {
    let parent = tempfile::tempdir().unwrap();
    let elsewhere = tempfile::tempdir().unwrap();
    std::fs::write(elsewhere.path().join("precious.txt"), "kept").unwrap();
    std::os::unix::fs::symlink(elsewhere.path(), parent.path().join(BUNDLE_ID)).unwrap();

    remove_data_dir(parent.path()).unwrap();
    assert!(elsewhere.path().join("precious.txt").exists());
    assert!(std::fs::symlink_metadata(parent.path().join(BUNDLE_ID)).is_ok());
}

#[test]
fn a_file_at_the_data_folder_is_left_alone() {
    let parent = tempfile::tempdir().unwrap();
    std::fs::write(parent.path().join(BUNDLE_ID), "not a folder").unwrap();
    remove_data_dir(parent.path()).unwrap();
    assert!(parent.path().join(BUNDLE_ID).is_file());
}

/// The macOS uninstall script reads the sign-in profile prefixes from the shared rules file; the
/// app's own are the ones it must name.
#[test]
fn the_rules_file_names_the_sign_in_profiles() {
    let rules: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/windows/uninstall-rules.json"
        ))
        .unwrap(),
    )
    .unwrap();
    let mut prefixes = vec![
        crate::auth::grok_login::GROK_PROFILE_PREFIX,
        crate::auth::oauth::PROVIDER_LOGIN_PROFILE_PREFIX,
        crate::auth::opencode_login::OPENCODE_PROFILE_PREFIX,
    ];
    prefixes.sort_unstable();
    assert_eq!(rules["tempProfilePrefixes"], serde_json::json!(prefixes));
}

/// The uninstaller hook closes the app, runs it with the flag before the files are deleted, reads
/// the exit codes [`run`] returns, and falls back to the script only when the app could not run.
#[test]
fn the_uninstaller_hook_runs_the_app_first() {
    let manifest = env!("CARGO_MANIFEST_DIR");
    let conf: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(format!("{manifest}/tauri.conf.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(conf["identifier"], BUNDLE_ID);
    assert_eq!(
        conf["bundle"]["windows"]["nsis"]["installerHooks"],
        "windows/hooks.nsh"
    );

    let hook = std::fs::read_to_string(format!("{manifest}/windows/hooks.nsh")).unwrap();
    let pre = hook.find("!macro NSIS_HOOK_PREUNINSTALL").unwrap();
    let post = hook.find("!macro NSIS_HOOK_POSTUNINSTALL").unwrap();
    let pre_body = &hook[pre..post];
    let close = pre_body.find("CheckIfAppIsRunning").unwrap();
    let run = pre_body
        .find(&format!("\"$INSTDIR\\${{MAINBINARYNAME}}.exe\" {FLAG}"))
        .unwrap();
    assert!(
        close < run,
        "the app is closed before it is run with the flag"
    );
    assert!(pre_body.contains("$UpdateMode <> 1"));

    let post_body = &hook[post..];
    assert!(post_body.contains("$UpdateMode <> 1"));
    assert!(post_body.contains(&format!("$AIUT_CleanupResult = {CREDENTIALS_LEFT}")));
    assert!(post_body.contains(&format!("$AIUT_CleanupResult <> {REMOVED}")));
    assert!(post_body.contains("remove-windows-credentials.ps1"));
    assert!(post_body.contains("uninstall-rules.json"));
    assert!(post_body.contains("AIUT_RemoveBundleDir"));
}

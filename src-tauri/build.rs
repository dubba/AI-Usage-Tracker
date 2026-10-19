use image::ImageFormat;
use resvg::{tiny_skia, usvg};
use std::{
    env, fs,
    io::Cursor,
    path::{Path, PathBuf},
};

#[path = "build/android_patches.rs"]
mod android_patches;
#[path = "build/icons.rs"]
mod icons;

use android_patches::*;
use icons::*;

// Kotlin patches for origin-safe Android IPC. A separate file so `cargo test` can cover them
// (see the matching `#[path]` module in `src/lib.rs`).
#[path = "webview_ipc_patch.rs"]
mod webview_ipc_patch;

/// Every command the frontend can invoke. Tauri generates an `allow-<command>`
/// permission for each, and the capability files decide which window gets which.
/// Keep in sync with `generate_handler!` in `src/lib.rs` (a test enforces it).
const APP_COMMANDS: &[&str] = &[
    "get_startup_issue",
    "get_diagnostics",
    "retry_startup",
    "get_dashboard_snapshot",
    "get_bridge_info",
    "start_login",
    "probe_google_ai_studio_key",
    "add_google_ai_studio_account",
    "start_google_ai_studio_usage_login",
    "add_opencode_go_account",
    "add_grok_account",
    "get_login_status",
    "current_login_status",
    "cancel_login",
    "refresh_account",
    "refresh_all",
    "get_app_settings",
    "set_account_refresh_minutes",
    "set_automatic_updates_enabled",
    "set_include_beta_updates",
    "get_autostart",
    "set_autostart",
    "set_api_integration_enabled",
    "open_api_integration_window",
    "reorder_accounts",
    "get_account_alerts",
    "save_account_alerts",
    "rename_account",
    "remove_account",
    "remove_unprotected_accounts",
    "save_account_bucket",
    "delete_account_bucket",
    "regenerate_bridge_token",
    "reveal_bridge_token",
    "check_for_app_update",
    "install_app_update",
    "get_pending_update_notice",
    "ensure_camera_permission",
    "pairing_wifi_enabled",
    "pairing_open_wifi_settings",
    "pairing_start_host",
    "pairing_start_client",
    "pairing_start_client_by_code",
    "pairing_select_role",
    "pairing_confirm_sas",
    "pairing_cancel",
    "pairing_status",
    "pairing_set_include_settings",
    "pairing_set_pending_ui_state",
    "pairing_clear_pending_ui_state",
    "pairing_prepare_airgap_export",
    "pairing_verify_airgap",
    "pairing_import_airgap",
    "get_pending_pairing_uri",
];

fn main() {
    println!("cargo:rerun-if-changed=icons/icon.svg");
    println!("cargo:rerun-if-changed=gen/apple/Assets.xcassets/AppIcon.appiconset/Contents.json");
    println!("cargo:rerun-if-changed=tauri.conf.json");
    println!("cargo:rerun-if-changed=capabilities");
    println!("cargo:rerun-if-changed=../dist");
    // The Tauri CLI rewrites these templates during `tauri android build`;
    // re-running the build script when they change guarantees the WebView
    // patches below are re-applied before kotlinc compiles them.
    println!("cargo:rerun-if-changed=gen/android/app/src/main/java/com/dubba/ai/usage/tracker/generated/RustWebView.kt");
    println!("cargo:rerun-if-changed=gen/android/app/src/main/java/com/dubba/ai/usage/tracker/generated/RustWebChromeClient.kt");
    println!("cargo:rerun-if-changed=gen/android/app/src/main/java/com/dubba/ai/usage/tracker/generated/RustWebViewClient.kt");
    println!("cargo:rerun-if-changed=gen/android/app/src/main/java/com/dubba/ai/usage/tracker/generated/Ipc.kt");
    println!("cargo:rerun-if-changed=webview_ipc_patch.rs");
    println!("cargo:rerun-if-changed=build");

    let manifest_dir = PathBuf::from(
        env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR must be available"),
    );
    let icon_dir = manifest_dir.join("icons");
    let icon = parse_icon();

    for (file_name, size) in [
        ("icon.png", 128),
        ("32x32.png", 32),
        ("128x128.png", 128),
        ("128x128@2x.png", 256),
    ] {
        let png = encode_png(&render_desktop_icon(&icon, size, size as f32));
        write_file_if_changed(icon_dir.join(file_name), &png);
    }

    write_windows_icon(&icon_dir, &icon);
    write_macos_icon(&icon_dir, &icon);
    write_android_icons(&manifest_dir, &icon);
    write_ios_icons(&manifest_dir, &icon);

    let mut attributes = tauri_build::Attributes::new()
        .app_manifest(tauri_build::AppManifest::new().commands(APP_COMMANDS));
    if env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc") {
        attributes = attributes
            .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest());
        embed_windows_app_manifest(&manifest_dir);
    }
    if let Err(error) = tauri_build::try_build(attributes) {
        println!("{error:#}");
        std::process::exit(1);
    }
    patch_android_webview_templates(&manifest_dir);
}

/// tauri-build links its Windows application manifest into the app binary only, so the
/// `cargo test` binary started without the Common Controls v6 dependency that tauri's code needs
/// and Windows refused to run it (STATUS_ENTRYPOINT_NOT_FOUND, 0xc0000139). Embedding the same
/// manifest through the linker covers every binary. tauri-build's own copy is turned off in
/// `main`, because two manifests in one binary fail to link.
fn embed_windows_app_manifest(manifest_dir: &Path) {
    let manifest = manifest_dir.join("windows-app-manifest.xml");
    println!("cargo:rerun-if-changed={}", manifest.display());
    println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
    println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
}

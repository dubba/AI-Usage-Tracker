mod account_order;
mod alerts;
#[cfg(target_os = "android")]
mod android_context;
#[cfg(target_os = "android")]
mod android_keystore;
#[cfg(target_os = "android")]
mod apk_install;
mod backend;
mod bridge_api;
mod buckets;
mod camera_permission;
mod commands;
#[cfg(any(target_os = "android", debug_assertions))]
mod credential_file;
mod diagnostics;
mod fs_util;
mod google_ai_studio_oauth;
mod google_client;
mod grok_login;
mod lan_binding;
mod limits;
#[cfg(target_os = "macos")]
mod macos_notifications;
mod migrations;
mod mobile_auth;
mod model;
mod oauth;
mod oauth_common;
mod opencode_login;
mod pairing;
mod providers;
mod refresh_backoff;
mod refresh_loop;
mod settings;
mod startup;
mod state;
mod store;
mod tray;
mod updater;
mod usage;

use crate::state::AppState;
use std::sync::Arc;
use tauri::Manager;
#[cfg(desktop)]
use tauri_plugin_autostart::MacosLauncher;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _ = rustls::crypto::ring::default_provider().install_default();

    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default();

    #[cfg(desktop)]
    {
        builder = builder
            .plugin(tauri_plugin_single_instance::init(|app, _, _| {
                tray::show_main_window(app);
            }))
            .plugin(tauri_plugin_autostart::init(
                MacosLauncher::LaunchAgent,
                Some(vec!["--hidden"]),
            ))
            .plugin(
                tauri_plugin_window_state::Builder::default()
                    .with_state_flags(tray::SAVED_WINDOW_STATE)
                    .build(),
            )
            .plugin(tauri_plugin_updater::Builder::new().build());
    }

    builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            #[cfg(desktop)]
            tray::setup_main_window(app);

            #[cfg(target_os = "macos")]
            macos_notifications::setup_macos_notification_delegate();

            // A failure here must not abort setup: the window still opens and
            // the frontend shows the problem with a Retry button.
            app.manage(startup::StartupStatus::default());
            if let Err(issue) = backend::initialize_backend(app.handle()) {
                crate::diagnostics::error(&format!("Backend startup failed: {}", issue.message));
                app.state::<startup::StartupStatus>().set(issue);
            }

            #[cfg(desktop)]
            tray::build_tray(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::system::get_startup_issue,
            commands::system::get_diagnostics,
            commands::system::retry_startup,
            commands::accounts::get_dashboard_snapshot,
            commands::bridge::get_bridge_info,
            commands::auth::start_login,
            commands::auth::probe_google_ai_studio_key,
            commands::auth::add_google_ai_studio_account,
            commands::auth::start_google_ai_studio_usage_login,
            commands::auth::add_opencode_go_account,
            commands::auth::add_grok_account,
            commands::auth::get_login_status,
            commands::auth::current_login_status,
            commands::auth::cancel_login,
            commands::accounts::refresh_account,
            commands::accounts::refresh_all,
            commands::settings::get_app_settings,
            commands::settings::set_account_refresh_minutes,
            commands::settings::set_automatic_updates_enabled,
            commands::settings::set_include_beta_updates,
            commands::settings::get_autostart,
            commands::settings::set_autostart,
            commands::bridge::set_api_integration_enabled,
            commands::bridge::open_api_integration_window,
            commands::accounts::reorder_accounts,
            commands::alerts::get_account_alerts,
            commands::alerts::save_account_alerts,
            commands::accounts::rename_account,
            commands::accounts::remove_account,
            commands::buckets::get_account_buckets,
            commands::buckets::save_account_bucket,
            commands::buckets::delete_account_bucket,
            commands::bridge::regenerate_bridge_token,
            commands::bridge::reveal_bridge_token,
            updater::check_for_app_update,
            updater::install_app_update,
            updater::get_pending_update_notice,
            commands::pairing::ensure_camera_permission,
            commands::pairing::pairing_start_host,
            commands::pairing::pairing_start_receiver,
            commands::pairing::pairing_start_client,
            commands::pairing::pairing_start_client_by_code,
            commands::pairing::pairing_start_sender,
            commands::pairing::pairing_select_role,
            commands::pairing::pairing_confirm_sas,
            commands::pairing::pairing_cancel,
            commands::pairing::pairing_status,
            commands::pairing::pairing_set_include_settings,
            commands::pairing::pairing_set_allow_credential_replace,
            commands::pairing::pairing_set_pending_ui_state,
            commands::pairing::pairing_clear_pending_ui_state,
            commands::pairing::pairing_prepare_airgap_export,
            commands::pairing::pairing_verify_airgap,
            commands::pairing::pairing_import_airgap,
            commands::pairing::get_pending_pairing_uri,
        ])
        .build(tauri::generate_context!())
        .expect("error while building AI Usage Tracker")
        .run(|app_handle, event| {
            // Tauri only emits `RunEvent::Resumed` for a polling event loop, so
            // Android delivers activity resume as `WindowEvent::Resumed`. Window
            // focus covers desktop wake-from-sleep and returning to the app.
            let should_check_refresh = match &event {
                tauri::RunEvent::Resumed => true,
                #[cfg(mobile)]
                tauri::RunEvent::WindowEvent {
                    event: tauri::WindowEvent::Resumed,
                    ..
                } => true,
                tauri::RunEvent::WindowEvent {
                    event: tauri::WindowEvent::Focused(true),
                    ..
                } => true,
                _ => false,
            };
            if should_check_refresh {
                if let Some(state) = app_handle.try_state::<Arc<AppState>>() {
                    state.request_refresh_check();
                }
            }
        });
}

#[cfg(test)]
mod tests {
    /// The command list in `build.rs`, the capability files, and the commands
    /// the frontend really calls must agree, or a window silently loses (or
    /// gains) access to a command.
    #[test]
    fn app_commands_capabilities_and_frontend_stay_in_sync() {
        use std::collections::BTreeSet;

        fn quoted(text: &str) -> BTreeSet<String> {
            text.split('"')
                .skip(1)
                .step_by(2)
                .map(str::to_string)
                .collect()
        }

        // Commands registered with Tauri (the needle is split so this test's
        // own source does not match it).
        let lib_source = include_str!("lib.rs");
        let needle = concat!("generate_", "handler![");
        let start = lib_source.find(needle).expect("handler list") + needle.len();
        let handler_block = &lib_source[start..];
        let handlers: BTreeSet<String> = handler_block[..handler_block.find("])").unwrap()]
            .split(',')
            .map(|path| {
                path.trim()
                    .rsplit("::")
                    .next()
                    .unwrap_or_default()
                    .to_string()
            })
            .filter(|name| !name.is_empty())
            .collect();

        // Commands declared in build.rs.
        let build_source = include_str!("../build.rs");
        let start = build_source
            .find("const APP_COMMANDS")
            .expect("manifest list");
        let list = &build_source[start..];
        let declared = quoted(&list[list.find('[').unwrap()..list.find("];").unwrap()]);
        assert_eq!(
            handlers, declared,
            "build.rs APP_COMMANDS must match generate_handler!"
        );

        // Main window: every command. API window: only bridge token handling.
        let permissions = |json: &str| -> BTreeSet<String> {
            let value: serde_json::Value = serde_json::from_str(json).unwrap();
            value["permissions"]
                .as_array()
                .unwrap()
                .iter()
                .filter_map(|entry| entry.as_str().map(str::to_string))
                .collect()
        };
        let allow = |command: &str| format!("allow-{}", command.replace('_', "-"));
        let main_permissions = permissions(include_str!("../capabilities/default.json"));
        let main_app_permissions: BTreeSet<_> = main_permissions
            .iter()
            .filter(|permission| permission.starts_with("allow-"))
            .cloned()
            .collect();
        assert_eq!(
            main_app_permissions,
            handlers.iter().map(|command| allow(command)).collect(),
            "the main window must be allowed exactly the registered commands"
        );
        let api_permissions = permissions(include_str!("../capabilities/api-integration.json"));
        let api_commands: BTreeSet<_> = api_permissions
            .iter()
            .filter(|permission| permission.starts_with("allow-"))
            .cloned()
            .collect();
        assert_eq!(
            api_commands,
            [
                "get_bridge_info",
                "reveal_bridge_token",
                "regenerate_bridge_token"
            ]
            .iter()
            .map(|command| allow(command))
            .collect::<BTreeSet<_>>()
        );

        // Every `invoke("command")` in the frontend is registered.
        fn frontend_files(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
            for entry in std::fs::read_dir(dir).unwrap().flatten() {
                let path = entry.path();
                if path.is_dir() {
                    frontend_files(&path, out);
                } else if matches!(
                    path.extension().and_then(|ext| ext.to_str()),
                    Some("ts" | "tsx")
                ) {
                    out.push(path);
                }
            }
        }
        let mut files = Vec::new();
        frontend_files(
            &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../src"),
            &mut files,
        );
        assert!(!files.is_empty());
        for file in files {
            let text = std::fs::read_to_string(&file).unwrap();
            let mut rest = text.as_str();
            while let Some(index) = rest.find("invoke") {
                rest = &rest[index + "invoke".len()..];
                let mut chars = rest.trim_start();
                if chars.starts_with('<') {
                    // Skip a generic argument such as `<Account | null>`.
                    let mut depth = 0;
                    let end = chars.find(|c| {
                        match c {
                            '<' => depth += 1,
                            '>' => depth -= 1,
                            _ => {}
                        }
                        depth == 0
                    });
                    chars = end.map_or("", |end| chars[end + 1..].trim_start());
                }
                if let Some(after) = chars.strip_prefix('(') {
                    if let Some(name) = after.trim_start().strip_prefix('"') {
                        let name = &name[..name.find('"').unwrap()];
                        assert!(
                            handlers.contains(name),
                            "{} invokes unknown command {name}",
                            file.display()
                        );
                    }
                }
            }
        }

        // The Paseo Bridge window may only call what its capability allows.
        let bridge_window =
            include_str!("../../src/features/api-integration/ApiIntegrationWindow.tsx");
        let allowed_methods = ["bridgeInfo", "revealBridgeToken", "regenerateToken"];
        let mut rest = bridge_window;
        while let Some(index) = rest.find("bridgeApi.") {
            rest = &rest[index + "bridgeApi.".len()..];
            let method: String = rest
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric())
                .collect();
            assert!(
                allowed_methods.contains(&method.as_str()),
                "the Paseo Bridge window calls bridgeApi.{method}, which its capability does not allow"
            );
        }
    }
}

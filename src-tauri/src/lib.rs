mod account_order;
mod alerts;
#[cfg(target_os = "android")]
mod android_context;
#[cfg(target_os = "android")]
mod android_keystore;
#[cfg(target_os = "android")]
mod apk_install;
mod autostart;
mod backend;
mod bridge_api;
mod buckets;
mod camera_permission;
mod commands;
mod confirm;
#[cfg(any(target_os = "android", debug_assertions))]
mod credential_file;
mod diagnostics;
mod fs_util;
mod google_ai_studio_oauth;
mod google_client;
mod grok_login;
#[cfg(target_os = "ios")]
mod ios_cookies;
#[cfg(target_os = "ios")]
mod ios_popups;
mod lan_binding;
mod limits;
#[cfg(desktop)]
mod login_profile;
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
mod signin_navigation;
mod startup;
mod state;
mod store;
mod tray;
mod updater;
mod usage;
mod wifi;

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
                Some(autostart::AUTOSTART_ARGS.to_vec()),
            ))
            .plugin(
                tauri_plugin_window_state::Builder::default()
                    .with_state_flags(tray::SAVED_WINDOW_STATE)
                    .with_filter(|label| label == "main")
                    .build(),
            )
            .plugin(tauri_plugin_updater::Builder::new().build());
    }

    // In-app sign-in uses the main window on mobile; keep it on sign-in pages.
    #[cfg(mobile)]
    {
        builder = builder.plugin(signin_navigation::plugin());
    }

    builder
        // Used from Rust only (see confirm.rs); the webview has no dialog permission.
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            #[cfg(desktop)]
            tray::setup_main_window(app);

            // Entries written by earlier versions have an unquoted path.
            #[cfg(windows)]
            autostart::quote_windows_run_value(&app.package_info().name);

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
            commands::accounts::remove_unprotected_accounts,
            commands::buckets::get_account_buckets,
            commands::buckets::save_account_bucket,
            commands::buckets::delete_account_bucket,
            commands::bridge::regenerate_bridge_token,
            commands::bridge::reveal_bridge_token,
            updater::check_for_app_update,
            updater::install_app_update,
            updater::get_pending_update_notice,
            commands::pairing::ensure_camera_permission,
            commands::pairing::pairing_wifi_enabled,
            commands::pairing::pairing_open_wifi_settings,
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
            // Quitting with Cmd+Q or from the system menu: the tray's Quit and closing the
            // window have their own hooks.
            #[cfg(desktop)]
            if matches!(event, tauri::RunEvent::ExitRequested { .. }) {
                commands::bridge::remember_api_integration_window_size(app_handle);
            }
            if should_check_refresh {
                if let Some(state) = app_handle.try_state::<Arc<AppState>>() {
                    state.request_refresh_check();
                }
            }
        });
}

// Kotlin patches that `build.rs` applies; compiled here only so they can be tested.
#[cfg(test)]
#[path = "../webview_ipc_patch.rs"]
mod webview_ipc_patch;

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

        // The opener's URL allowlist (what can actually be opened) and the
        // frontend's safeUrl prefixes (which links are shown as clickable) must
        // be the same list.
        let main_json: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
        let opener_patterns: BTreeSet<String> = main_json["permissions"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|entry| entry["identifier"] == "opener:allow-open-url")
            .flat_map(|entry| entry["allow"].as_array().unwrap().iter())
            .map(|rule| rule["url"].as_str().unwrap().to_string())
            .collect();
        assert!(
            opener_patterns
                .iter()
                .all(|pattern| pattern.starts_with("https://") && pattern.ends_with("/*")),
            "opener patterns must be https:// prefixes ending in /*: {opener_patterns:?}"
        );
        let safe_url = include_str!("../../src/shared/lib/safeUrl.ts");
        let start = safe_url
            .find("ALLOWED_EXTERNAL_URL_PREFIXES = [")
            .expect("safeUrl prefix list");
        let list = &safe_url[start..];
        let safe_url_patterns: BTreeSet<String> = quoted(&list[..list.find("] as const").unwrap()])
            .into_iter()
            .map(|prefix| format!("{prefix}*"))
            .collect();
        assert_eq!(
            opener_patterns, safe_url_patterns,
            "capabilities/default.json opener allowlist and src/shared/lib/safeUrl.ts must match"
        );
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
        let mut called = BTreeSet::new();
        let mut non_test_sources = Vec::new();
        for file in files {
            let is_test = file
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.contains(".test."));
            let text = std::fs::read_to_string(&file).unwrap();
            let is_api = file.ends_with("shared/lib/api.ts");
            if !is_test {
                // Join `bridgeApi\n  .method(` chains so the call is found on one line.
                let mut joined = String::with_capacity(text.len());
                let mut pending_space = String::new();
                for ch in text.chars() {
                    if ch.is_whitespace() {
                        pending_space.push(ch);
                        continue;
                    }
                    if ch != '.' {
                        joined.push_str(&pending_space);
                    }
                    pending_space.clear();
                    joined.push(ch);
                }
                non_test_sources.push(joined);
            }
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
                    let after = after.trim_start();
                    // Only a double-quoted literal can be checked here, so single
                    // quotes, a template literal, or a variable fail instead of
                    // slipping past.
                    let Some(name) = after.strip_prefix('"') else {
                        panic!(
                            "{} calls invoke() with something other than a double-quoted command name: {}",
                            file.display(),
                            after.lines().next().unwrap_or_default()
                        );
                    };
                    let name = &name[..name.find('"').unwrap()];
                    assert!(
                        handlers.contains(name),
                        "{} invokes unknown command {name}",
                        file.display()
                    );
                    // `api.ts` only declares wrappers; whether a wrapper is used is checked below.
                    if !is_test && !is_api {
                        called.insert(name.to_string());
                    }
                }
            }
        }

        // Every registered command has a caller in the app's own frontend. A command nothing
        // calls is attack surface with no user: it stays registered, listed in `build.rs`,
        // and granted to the main window for nothing. A command counts as called when code
        // outside the tests invokes it directly, or calls the `bridgeApi` / `pairingApi`
        // method in `api.ts` that wraps it. The list of exceptions is exact on purpose, so
        // removing a command from it (or the code) cannot be forgotten.
        const REGISTERED_BUT_UNCALLED: &[&str] = &[
            "get_account_buckets",
            "pairing_set_allow_credential_replace",
            "pairing_start_receiver",
            "pairing_start_sender",
        ];
        let api_source = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/shared/lib/api.ts"),
        )
        .unwrap();
        // (object name, method name) -> command, read from lines like `  getBuckets: () => invoke<..>("cmd")`.
        let mut wrappers: Vec<(&str, String, String)> = Vec::new();
        let mut object = "";
        let mut method = String::new();
        for line in api_source.lines() {
            if let Some(name) = line
                .strip_prefix("export const ")
                .and_then(|rest| rest.split(' ').next())
            {
                object = if name == "bridgeApi" || name == "pairingApi" {
                    name
                } else {
                    ""
                };
            }
            if object.is_empty() {
                continue;
            }
            let property = line
                .strip_prefix("  ")
                .filter(|rest| !rest.starts_with(' '))
                .and_then(|rest| rest.split_once(':'))
                .map(|(name, _)| name)
                .filter(|name| !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric()));
            if let Some(name) = property {
                method = name.to_string();
            }
            if let Some(index) = line.find("invoke<").or_else(|| line.find("invoke(")) {
                let after = &line[index..];
                if let Some(quote) = after.find('"') {
                    let command = &after[quote + 1..];
                    let command = &command[..command.find('"').unwrap()];
                    wrappers.push((object, method.clone(), command.to_string()));
                }
            }
        }
        assert!(
            wrappers.len() > 40,
            "api.ts wrapper parsing found too few commands"
        );
        let used_methods = |object: &str, method: &str| {
            let needle = format!("{object}.{method}");
            non_test_sources.iter().any(|text| {
                text.match_indices(&needle).any(|(index, _)| {
                    !text[index + needle.len()..].starts_with(|c: char| c.is_ascii_alphanumeric())
                })
            })
        };
        for (object, method, command) in &wrappers {
            if used_methods(object, method) {
                called.insert(command.clone());
            }
        }
        let uncalled: BTreeSet<String> = handlers.difference(&called).cloned().collect();
        let expected: BTreeSet<String> = REGISTERED_BUT_UNCALLED
            .iter()
            .map(|name| name.to_string())
            .collect();
        assert_eq!(
            uncalled, expected,
            "registered commands no frontend code calls must match REGISTERED_BUT_UNCALLED"
        );

        // The Paseo Bridge window may only call what its capability allows.
        let bridge_window =
            include_str!("../../src/features/api-integration/ApiIntegrationWindow.tsx");
        // Raw invoke() calls would bypass the method check below.
        assert!(
            !bridge_window.contains("invoke"),
            "the Paseo Bridge window must call commands through bridgeApi so this test can check them"
        );
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

mod account_order;
mod alerts;
mod bridge_api;
mod buckets;
mod fs_util;
mod google_ai_studio_oauth;
mod grok_login;
mod mobile_auth;
mod model;
mod oauth;
mod opencode_login;
mod providers;
mod settings;
mod state;
mod store;
mod usage;

use crate::{
    alerts::UsageAlertSetting,
    model::{
        Account, AccountBucket, AppUpdateStatus, BridgeInfo, BridgeStatus, DashboardSnapshot,
        LoginStart, LoginStatus, Provider,
    },
    settings::AppSettings,
    state::AppState,
    store::{load_or_create_bridge_token, rotate_bridge_token},
};
use std::{str::FromStr, sync::Arc};
#[cfg(desktop)]
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    WindowEvent,
};
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder};
#[cfg(desktop)]
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_notification::NotificationExt;
#[cfg(desktop)]
use tauri_plugin_updater::UpdaterExt;
#[cfg(desktop)]
use tauri_plugin_window_state::{AppHandleExt, StateFlags, WindowExt};

#[cfg(desktop)]
const SAVED_WINDOW_STATE: StateFlags = StateFlags::from_bits_truncate(
    StateFlags::SIZE.bits()
        | StateFlags::POSITION.bits()
        | StateFlags::MAXIMIZED.bits()
        | StateFlags::FULLSCREEN.bits(),
);

#[tauri::command]
async fn get_dashboard_snapshot(
    state: State<'_, Arc<AppState>>,
) -> Result<DashboardSnapshot, String> {
    let accounts = state.account_order.apply(state.store.list())?;
    let buckets = state.buckets.list();
    Ok(DashboardSnapshot {
        accounts,
        buckets,
        bridge: bridge_status(state.inner().as_ref()),
    })
}

#[tauri::command]
fn get_bridge_info(state: State<'_, Arc<AppState>>) -> Result<BridgeInfo, String> {
    Ok(bridge_info(state.inner().as_ref()))
}

#[tauri::command]
async fn start_login(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    label: String,
    provider: String,
    email: Option<String>,
) -> Result<LoginStart, String> {
    let provider = Provider::from_str(&provider)?;
    let label = if provider == Provider::OpencodeGo && label.trim().is_empty() {
        "OpenCode Go".to_string()
    } else if provider == Provider::Grok && label.trim().is_empty() {
        "Grok".to_string()
    } else {
        validate_label(&label)?
    };

    if provider == Provider::GoogleAiStudio {
        return Err("Google AI Studio setup begins with an API key in Add Account.".into());
    }
    if provider == Provider::OpencodeGo {
        opencode_login::start_login(app, state.inner().clone(), label, email).await
    } else if provider == Provider::Grok {
        grok_login::start_login(state.inner().clone(), label).await
    } else {
        oauth::start_login(state.inner().clone(), label, provider).await
    }
}

#[tauri::command]
async fn probe_google_ai_studio_key(
    state: State<'_, Arc<AppState>>,
    api_key: String,
) -> Result<Account, String> {
    providers::google_ai_studio::probe_account(
        state.inner().clone(),
        "Google AI Studio".into(),
        api_key,
    )
    .await
}

#[tauri::command]
async fn add_google_ai_studio_account(
    state: State<'_, Arc<AppState>>,
    label: String,
    api_key: String,
    selected_models: Vec<String>,
) -> Result<Account, String> {
    providers::google_ai_studio::add_account(
        state.inner().clone(),
        validate_label(&label)?,
        api_key,
        selected_models,
    )
    .await
}

#[tauri::command]
async fn start_google_ai_studio_usage_login(
    state: State<'_, Arc<AppState>>,
    account_id: String,
    project_id: String,
    enable_monitoring: bool,
) -> Result<LoginStart, String> {
    google_ai_studio_oauth::start_login(
        state.inner().clone(),
        account_id,
        project_id,
        enable_monitoring,
    )
    .await
}

#[tauri::command]
async fn add_grok_account(
    state: State<'_, Arc<AppState>>,
    label: String,
    cookie_header: String,
) -> Result<Account, String> {
    let label = if label.trim().is_empty() {
        "Grok".to_string()
    } else {
        validate_label(&label)?
    };
    grok_login::add_account(state.inner().clone(), label, cookie_header).await
}

#[tauri::command]
async fn add_opencode_go_account(
    state: State<'_, Arc<AppState>>,
    label: String,
    workspace_id: String,
    auth_cookie: String,
    email: Option<String>,
) -> Result<Account, String> {
    let label = if label.trim().is_empty() {
        "OpenCode Go".to_string()
    } else {
        validate_label(&label)?
    };
    opencode_login::add_account(
        state.inner().clone(),
        label,
        workspace_id,
        auth_cookie,
        email,
    )
    .await
}

#[tauri::command]
async fn get_login_status(
    state: State<'_, Arc<AppState>>,
    attempt_id: String,
) -> Result<LoginStatus, String> {
    oauth::login_status(state.inner(), &attempt_id).await
}

#[tauri::command]
fn current_login_status(state: State<'_, Arc<AppState>>) -> Option<LoginStatus> {
    state.pending_login.read().clone()
}

#[tauri::command]
fn cancel_login(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    attempt_id: String,
) -> Result<(), String> {
    let cancelled = {
        let mut pending = state.pending_login.write();
        let cancellable = pending.as_ref().is_some_and(|login| {
  login.attempt_id == attempt_id
      && matches!(
          login.status.as_str(),
          "waiting" | "choose_project" | "monitoring_disabled"
      )
        });
        if cancellable {
  *pending = Some(LoginStatus {
      attempt_id: attempt_id.clone(),
      status: "failed".into(),
      message: Some("Authentication was cancelled.".into()),
      account: None,
      projects: None,
      selected_project_id: None,
  });
        }
        cancellable
    };

    state.stop_login_shutdown(&attempt_id);
    if !cancelled {
        return Ok(());
    }

    for label in ["opencode-go-login", "grok-login"] {
        if let Some(window) = app.get_webview_window(label) {
            let _ = window.close();
            let _ = window.destroy();
        }
    }
    Ok(())
}

#[tauri::command]
async fn refresh_account(
    state: State<'_, Arc<AppState>>,
    account_id: String,
) -> Result<Account, String> {
    usage::refresh_account(state.inner().clone(), &account_id).await
}

#[tauri::command]
async fn refresh_all(state: State<'_, Arc<AppState>>) -> Result<Vec<Account>, String> {
    Ok(usage::refresh_all(state.inner().clone()).await)
}

#[tauri::command]
fn get_app_settings(state: State<'_, Arc<AppState>>) -> Result<AppSettings, String> {
    Ok(state.settings.get())
}

#[tauri::command]
fn set_account_refresh_minutes(
    state: State<'_, Arc<AppState>>,
    minutes: u64,
) -> Result<AppSettings, String> {
    state.settings.set_account_refresh_minutes(minutes)
}

#[tauri::command]
fn set_automatic_updates_enabled(
    state: State<'_, Arc<AppState>>,
    enabled: bool,
) -> Result<AppSettings, String> {
    state.settings.set_automatic_updates_enabled(enabled)
}

#[tauri::command]
async fn set_paseo_bridge_enabled(
    state: State<'_, Arc<AppState>>,
    enabled: bool,
) -> Result<BridgeStatus, String> {
    state.settings.set_paseo_bridge_enabled(enabled)?;

    for _ in 0..20 {
        let status = bridge_status(state.inner().as_ref());
        if (!enabled && !status.running) || (enabled && (status.running || status.error.is_some())) {
            return Ok(status);
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }

    Ok(bridge_status(state.inner().as_ref()))
}

#[tauri::command]
async fn open_paseo_bridge_window(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    if !state.settings.paseo_bridge_enabled() {
        return Err("Enable the Paseo Bridge before opening its configuration.".into());
    }

    if let Some(window) = app.get_webview_window("paseo-bridge") {
        #[cfg(desktop)]
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        return Ok(());
    }

    #[allow(unused_mut)]
    let mut builder =
        WebviewWindowBuilder::new(&app, "paseo-bridge", WebviewUrl::App("index.html".into()))
            .title("Paseo Bridge")
            .inner_size(780.0, 760.0)
            .min_inner_size(640.0, 560.0);

    #[cfg(desktop)]
    {
        builder = builder.center();
        if let Some(icon) = app.default_window_icon() {
            builder = builder
                .icon(icon.clone())
                .map_err(|error| error.to_string())?;
        }
    }

    builder.build().map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn reorder_accounts(
    state: State<'_, Arc<AppState>>,
    account_ids: Vec<String>,
) -> Result<Vec<Account>, String> {
    state.account_order.save(account_ids, state.store.list())
}

#[tauri::command]
fn get_account_alerts(
    state: State<'_, Arc<AppState>>,
    account_id: String,
) -> Result<Vec<UsageAlertSetting>, String> {
    if state.store.get(&account_id).is_none() {
        return Err("Account not found.".into());
    }
    Ok(state.alerts.get(&account_id))
}

#[tauri::command]
fn save_account_alerts(
    state: State<'_, Arc<AppState>>,
    account_id: String,
    settings: Vec<UsageAlertSetting>,
) -> Result<Vec<UsageAlertSetting>, String> {
    let account = state
        .store
        .get(&account_id)
        .ok_or_else(|| "Account not found.".to_string())?;

    for setting in &settings {
        let available = account.last_usage.as_ref().is_some_and(|usage| {
            usage.windows.iter().any(|window| {
                alerts::canonical_window_id(window) == Some(setting.window_id.as_str())
            })
        });
        if !available {
            return Err(format!(
                "{} is not available for this account's current plan.",
                setting.window_id.replace('_', " ")
            ));
        }
    }

    let saved = state.alerts.save(&account_id, settings)?;
    usage::emit_alerts_for_account(state.inner().as_ref(), &account);
    Ok(saved)
}

#[tauri::command]
fn rename_account(
    state: State<'_, Arc<AppState>>,
    account_id: String,
    label: String,
) -> Result<Account, String> {
    let label = validate_label(&label)?;
    state
        .store
        .mutate(&account_id, |account| account.label = label)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn get_account_buckets(state: State<'_, Arc<AppState>>) -> Result<Vec<AccountBucket>, String> {
    Ok(state.buckets.list())
}

#[tauri::command]
fn save_account_bucket(
    state: State<'_, Arc<AppState>>,
    id: Option<String>,
    name: String,
    provider: Option<String>,
    account_ids: Vec<String>,
) -> Result<AccountBucket, String> {
    let provider = match provider {
        Some(p) if !p.trim().is_empty() => Some(Provider::from_str(&p)?),
        _ => None,
    };
    state.buckets.save(id, name, provider, account_ids)
}

#[tauri::command]
fn delete_account_bucket(
    state: State<'_, Arc<AppState>>,
    id: String,
) -> Result<(), String> {
    state.buckets.delete(&id)
}

#[tauri::command]
async fn remove_account(
    state: State<'_, Arc<AppState>>,
    account_id: String,
) -> Result<(), String> {
    let lock = state.account_lock(&account_id);
    let _guard = lock.lock().await;
    state
        .store
        .remove(&account_id)
        .map_err(|error| error.to_string())?;
    state.account_order.remove(&account_id)?;
    state.alerts.remove(&account_id)?;
    state.buckets.cleanup_account(&account_id)?;
    Ok(())
}

#[tauri::command]
fn regenerate_bridge_token(state: State<'_, Arc<AppState>>) -> Result<BridgeInfo, String> {
    let token = rotate_bridge_token().map_err(|error| error.to_string())?;
    *state.bridge_token.write() = token;
    Ok(bridge_info(state.inner().as_ref()))
}

#[tauri::command]
async fn check_for_app_update(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
) -> Result<AppUpdateStatus, String> {
    let current_version = app.package_info().version.to_string();

    #[cfg(not(desktop))]
    {
        let _ = state;
        return Ok(AppUpdateStatus {
            current_version,
            available: false,
            available_version: None,
            date: None,
            body: None,
        });
    }

    #[cfg(desktop)]
    {
        let update = app
            .updater()
            .map_err(|error| format!("Unable to initialize the updater: {error}"))?
            .check()
            .await
            .map_err(|error| format!("Unable to check for updates: {error}"))?;

        Ok(match update {
            Some(update) => {
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

                AppUpdateStatus {
                    current_version,
                    available: true,
                    available_version: Some(available_version),
                    date: update.date.map(|date| date.to_string()),
                    body: update.body,
                }
            }
            None => AppUpdateStatus {
                current_version,
                available: false,
                available_version: None,
                date: None,
                body: None,
            },
        })
    }
}

#[tauri::command]
async fn install_app_update(app: AppHandle) -> Result<(), String> {
    #[cfg(not(desktop))]
    {
        let _ = app;
        return Err("App updates are only supported on desktop platforms.".to_string());
    }

    #[cfg(desktop)]
    {
        let update = app
            .updater()
            .map_err(|error| format!("Unable to initialize the updater: {error}"))?
            .check()
            .await
            .map_err(|error| format!("Unable to check for updates: {error}"))?
            .ok_or_else(|| "No newer release is available.".to_string())?;

        update
            .download_and_install(|_, _| {}, || {})
            .await
            .map_err(|error| format!("Unable to install the update: {error}"))?;

        app.restart();
        #[allow(unreachable_code)]
        Ok(())
    }
}

fn migrate_google_ai_studio_accounts(state: &AppState) {
    for account in state.store.list() {
        let legacy_ai_studio = account.provider == Provider::Antigravity
            && account
                .provider_account_id
                .as_deref()
                .is_some_and(|value| value.starts_with("google-ai-studio:"));
        if legacy_ai_studio {
            let _ = state.store.mutate(&account.id, |account| {
                account.provider = Provider::GoogleAiStudio;
                account.plan = Some("Google AI Studio".into());
            });
        }
    }
}

fn validate_label(label: &str) -> Result<String, String> {
    let label = label.trim();
    if label.is_empty() {
        return Err("Account label is required.".into());
    }
    if label.chars().count() > 80 {
        return Err("Account label must be 80 characters or fewer.".into());
    }
    Ok(label.to_string())
}

fn bridge_status(state: &AppState) -> BridgeStatus {
    let runtime = state.api_runtime.read();
    BridgeStatus {
        endpoint: runtime.endpoint.clone(),
        enabled: state.settings.paseo_bridge_enabled(),
        running: runtime.running,
        error: runtime.error.clone(),
    }
}

fn bridge_info(state: &AppState) -> BridgeInfo {
    let status = bridge_status(state);
    BridgeInfo {
        endpoint: status.endpoint,
        token: state.bridge_token.read().clone(),
        enabled: status.enabled,
        running: status.running,
        error: status.error,
    }
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        #[cfg(desktop)]
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _ = rustls::crypto::ring::default_provider().install_default();

    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default();

    #[cfg(desktop)]
    {
        builder = builder
            .plugin(tauri_plugin_single_instance::init(|app, _, _| {
                show_main_window(app);
            }))
            .plugin(tauri_plugin_autostart::init(
                MacosLauncher::LaunchAgent,
                Some(vec!["--hidden"]),
            ))
            .plugin(
                tauri_plugin_window_state::Builder::default()
                    .with_state_flags(SAVED_WINDOW_STATE)
                    .build(),
            )
            .plugin(tauri_plugin_updater::Builder::new().build());
    }

    builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            #[cfg(desktop)]
            if let Some(window) = app.get_webview_window("main") {
                let start_hidden = std::env::args().any(|argument| argument == "--hidden");
                if let Some(icon) = app.default_window_icon() {
                    let _ = window.set_icon(icon.clone());
                }
                let _ = window.restore_state(SAVED_WINDOW_STATE);
                if !start_hidden {
                    let _ = window.unminimize();
                    let _ = window.show();
                    let _ = window.set_focus();
                }

                let window_for_event = window.clone();
                window.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = window_for_event.app_handle().save_window_state(SAVED_WINDOW_STATE);
                        let _ = window_for_event.hide();
                    }
                });
            }

            let data_dir = app.path().app_data_dir()?;
            crate::store::set_data_dir(data_dir.clone());
            let token = load_or_create_bridge_token()
                .map_err(|error| std::io::Error::other(error.to_string()))?;
            let state = Arc::new(AppState::new(data_dir, token).map_err(std::io::Error::other)?);
            migrate_google_ai_studio_accounts(state.as_ref());
            state.set_app_handle(app.handle().clone());
            app.manage(state.clone());
            tauri::async_runtime::spawn(bridge_api::run_controller(state.clone()));
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                loop {
                    let _ = usage::refresh_all(state.clone()).await;
                    let minutes = state.settings.account_refresh_minutes();
                    tokio::select! {
                        _ = tokio::time::sleep(std::time::Duration::from_secs(minutes * 60)) => {},
                        _ = state.settings.wait_for_refresh_schedule_change() => {},
                    }
                }
            });

            #[cfg(desktop)]
            {
                let show_label = format!("Open {}", app.package_info().name);
                let show = MenuItem::with_id(app, "show", show_label, true, None::<&str>)?;
                let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
                let menu = Menu::with_items(app, &[&show, &quit])?;
                let mut tray = TrayIconBuilder::new()
                    .menu(&menu)
                    .show_menu_on_left_click(false)
                    .on_menu_event(|app, event| match event.id.as_ref() {
                        "show" => show_main_window(app),
                        "quit" => {
                            let _ = app.save_window_state(SAVED_WINDOW_STATE);
                            app.exit(0);
                        }
                        _ => {}
                    })
                    .on_tray_icon_event(|tray, event| match event {
                        TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        }
                        | TrayIconEvent::DoubleClick {
                            button: MouseButton::Left,
                            ..
                        } => show_main_window(tray.app_handle()),
                        _ => {}
                    });
                if let Some(icon) = app.default_window_icon() {
                    tray = tray.icon(icon.clone());
                }
                tray.build(app)?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_dashboard_snapshot,
            get_bridge_info,
            start_login,
            probe_google_ai_studio_key,
            add_google_ai_studio_account,
            start_google_ai_studio_usage_login,
            add_opencode_go_account,
            add_grok_account,
            get_login_status,
            current_login_status,
            cancel_login,
            refresh_account,
            refresh_all,
            get_app_settings,
            set_account_refresh_minutes,
            set_automatic_updates_enabled,
            set_paseo_bridge_enabled,
            open_paseo_bridge_window,
            reorder_accounts,
            get_account_alerts,
            save_account_alerts,
            rename_account,
            remove_account,
            get_account_buckets,
            save_account_bucket,
            delete_account_bucket,
            regenerate_bridge_token,
            check_for_app_update,
            install_app_update,
        ])
        .run(tauri::generate_context!())
        .expect("error while running AI Usage Tracker");
}

mod account_order;
mod alerts;
#[cfg(target_os = "android")]
mod apk_install;
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
use std::{
    str::FromStr,
    sync::Arc,
    time::{Duration, SystemTime},
};
#[cfg(desktop)]
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    WindowEvent,
};
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;
#[cfg(desktop)]
use tauri_plugin_autostart::MacosLauncher;
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
const API_INTEGRATION_WINDOW_LABEL: &str = "api-integration";
const GITHUB_LATEST_RELEASE_URL: &str =
    "https://api.github.com/repos/dubba/AI-Usage-Tracker/releases/latest";
const GITHUB_RELEASES_PAGE_URL: &str = "https://github.com/dubba/AI-Usage-Tracker/releases/latest";

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
        "Grok/Cursor".to_string()
    } else if provider == Provider::Openai && label.trim().is_empty() {
        "GPT/Codex".to_string()
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
        "Grok/Cursor".to_string()
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
fn get_autostart(app: AppHandle, state: State<'_, Arc<AppState>>) -> Result<bool, String> {
    #[cfg(desktop)]
    {
        use tauri_plugin_autostart::ManagerExt;
        let enabled = app.autolaunch().is_enabled().map_err(|error| error.to_string())?;
        let _ = state.settings.set_autostart_enabled(enabled);
        Ok(enabled)
    }
    #[cfg(not(desktop))]
    {
        let _ = app;
        Ok(state.settings.autostart_enabled())
    }
}

#[tauri::command]
fn set_autostart(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    enabled: bool,
) -> Result<bool, String> {
    #[cfg(desktop)]
    {
        use tauri_plugin_autostart::ManagerExt;
        if enabled {
            app.autolaunch().enable().map_err(|error| error.to_string())?;
        } else {
            app.autolaunch().disable().map_err(|error| error.to_string())?;
        }
    }
    #[cfg(not(desktop))]
    let _ = app;

    state.settings.set_autostart_enabled(enabled)?;
    Ok(enabled)
}

#[tauri::command]
async fn set_api_integration_enabled(
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
async fn open_api_integration_window(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    if !state.settings.paseo_bridge_enabled() {
        return Err("Enable the Paseo Bridge before opening its configuration.".into());
    }

    if let Some(window) = app.get_webview_window(API_INTEGRATION_WINDOW_LABEL) {
        #[cfg(desktop)]
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        return Ok(());
    }

    #[allow(unused_mut)]
    let mut builder =
        WebviewWindowBuilder::new(&app, API_INTEGRATION_WINDOW_LABEL, WebviewUrl::App("index.html".into()))
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

#[allow(dead_code)]
fn is_newer_version(candidate: &str, current: &str) -> bool {
    let parse = |v: &str| -> Vec<u64> {
        v.trim_start_matches('v')
            .split('.')
            .filter_map(|s| {
                let num_str: String = s.chars().take_while(|c| c.is_ascii_digit()).collect();
                num_str.parse::<u64>().ok()
            })
            .collect()
    };
    let cand_parts = parse(candidate);
    let curr_parts = parse(current);
    let max_len = cand_parts.len().max(curr_parts.len());
    for i in 0..max_len {
        let cand = cand_parts.get(i).copied().unwrap_or(0);
        let curr = curr_parts.get(i).copied().unwrap_or(0);
        if cand > curr {
            return true;
        }
        if cand < curr {
            return false;
        }
    }
    false
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
    published_at: Option<String>,
    body: Option<String>,
    #[cfg_attr(not(target_os = "android"), allow(dead_code))]
    apk_url: Option<String>,
}

fn apk_url_from_github_assets(json: &serde_json::Value) -> Option<String> {
    let assets = json.get("assets")?.as_array()?;
    let mut fallback = None;
    for asset in assets {
        let name = asset.get("name")?.as_str()?.to_ascii_lowercase();
        if !name.ends_with(".apk") || name.contains("unsigned") {
            continue;
        }
        let url = asset.get("browser_download_url")?.as_str()?.to_string();
        let has_arch = name.contains("arm") || name.contains("x86") || name.contains("universal");
        if !has_arch {
            return Some(url);
        }
        fallback = Some(url);
    }
    fallback
}

async fn fetch_github_latest_release() -> Result<GitHubLatestRelease, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .build()
        .map_err(|error| format!("Unable to check for updates: {error}"))?;

    let response = client
        .get(GITHUB_LATEST_RELEASE_URL)
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

    let json = response
        .json::<serde_json::Value>()
        .await
        .map_err(|error| format!("Unable to check for updates: {error}"))?;
    let tag = json.get("tag_name").and_then(|value| value.as_str()).unwrap_or("");
    let version = tag.trim_start_matches('v');
    if version.is_empty() {
        return Err(
            "Unable to check for updates: latest GitHub release has no version tag.".into(),
        );
    }

    Ok(GitHubLatestRelease {
        version: version.to_string(),
        published_at: json
            .get("published_at")
            .and_then(|value| value.as_str())
            .map(str::to_string),
        body: json
            .get("body")
            .and_then(|value| value.as_str())
            .map(str::to_string),
        apk_url: apk_url_from_github_assets(&json),
    })
}

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
async fn download_android_apk(url: &str, dest: &std::path::Path) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(|error| format!("Unable to download the update: {error}"))?;
    let response = client
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
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("Unable to download the update: {error}"))?;
    if bytes.len() < 1024 || !bytes.starts_with(b"PK") {
        return Err("Downloaded update is not a valid Android package.".into());
    }
    if let Some(parent) = dest.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|error| format!("Unable to save the update: {error}"))?;
    }
    tokio::fs::write(dest, &bytes)
        .await
        .map_err(|error| format!("Unable to save the update: {error}"))?;
    Ok(())
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
        let shown = app
            .notification()
            .builder()
            .title("AI Usage Tracker update available")
            .body(format!("Version {} is ready to download.", latest.version))
            .show();
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

#[tauri::command]
async fn check_for_app_update(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
) -> Result<AppUpdateStatus, String> {
    let current_version = app.package_info().version.to_string();

    #[cfg(desktop)]
    {
        match app.updater() {
            Ok(updater) => match updater.check().await {
                Ok(Some(update)) => {
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
                Ok(None) => {}
                Err(error) if updater_error_is_no_release(&error) => {}
                Err(error) => {
                    return Ok(AppUpdateStatus::failed(
                        current_version,
                        format!("Unable to check for updates: {error}"),
                    ));
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
    match fetch_github_latest_release().await {
        Ok(latest) => Ok(status_from_github_latest(
            current_version,
            latest,
            &app,
            state.inner().as_ref(),
        )),
        Err(error) => Ok(AppUpdateStatus::failed(current_version, error)),
    }
}

#[tauri::command]
async fn install_app_update(app: AppHandle) -> Result<(), String> {
    #[cfg(desktop)]
    {
        if let Ok(updater) = app.updater() {
            if let Ok(Some(update)) = updater.check().await {
                update
                    .download_and_install(|_, _| {}, || {})
                    .await
                    .map_err(|error| format!("Unable to install the update: {error}"))?;
                app.restart();
                #[allow(unreachable_code)]
                return Ok(());
            }
        }
    }

    #[cfg(target_os = "android")]
    {
        let latest = fetch_github_latest_release().await?;
        let apk_url = latest
            .apk_url
            .ok_or_else(|| "The latest GitHub release does not include an Android APK.".to_string())?;
        let cache = app
            .path()
            .app_cache_dir()
            .map_err(|error| format!("Unable to save the update: {error}"))?;
        let dest = cache.join("ai-usage-tracker-update.apk");
        download_android_apk(&apk_url, &dest).await?;
        apk_install::prompt_apk_install(&dest)?;
        return Ok(());
    }

    #[cfg(not(target_os = "android"))]
    {
        app.opener()
            .open_url(GITHUB_RELEASES_PAGE_URL, None::<&str>)
            .map_err(|error| format!("Unable to open download page: {error}"))?;
    }
    Ok(())
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
            tauri::async_runtime::spawn(run_account_refresh_loop(state.clone()));

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
            get_autostart,
            set_autostart,
            set_api_integration_enabled,
            open_api_integration_window,
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
        .build(tauri::generate_context!())
        .expect("error while building AI Usage Tracker")
        .run(|app_handle, event| {
            if let tauri::RunEvent::Resumed = event {
                if let Some(state) = app_handle.try_state::<Arc<AppState>>() {
                    state.wakeup_refresh();
                }
            }
        });
}

fn account_refresh_is_due(last_refresh: SystemTime, now: SystemTime, interval: Duration) -> bool {
    now.duration_since(last_refresh).unwrap_or(Duration::MAX) >= interval
}

async fn run_account_refresh_loop(state: Arc<AppState>) {
    tokio::time::sleep(Duration::from_secs(2)).await;
    loop {
        let _ = usage::refresh_all(state.clone()).await;
        let last_refresh = SystemTime::now();
        loop {
            let interval = Duration::from_secs(state.settings.account_refresh_minutes() * 60);
            if account_refresh_is_due(last_refresh, SystemTime::now(), interval) {
                break;
            }
            let remaining = interval.saturating_sub(
                SystemTime::now()
                    .duration_since(last_refresh)
                    .unwrap_or(Duration::ZERO),
            );
            tokio::select! {
                _ = tokio::time::sleep(remaining) => break,
                _ = state.settings.wait_for_refresh_schedule_change() => break,
                _ = state.wait_for_refresh_wakeup() => {}
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        account_refresh_is_due, github_latest_http_is_inaccessible, is_newer_version,
        updater_error_is_no_release,
    };
    use std::time::{Duration, SystemTime};

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
    }

    #[test]
    fn account_refresh_is_due_after_the_configured_interval() {
        let last = SystemTime::UNIX_EPOCH;
        let interval = Duration::from_secs(15 * 60);
        let just_before = last + interval - Duration::from_secs(1);
        let exactly = last + interval;
        let later = last + interval + Duration::from_secs(1);
        assert!(!account_refresh_is_due(last, just_before, interval));
        assert!(account_refresh_is_due(last, exactly, interval));
        assert!(account_refresh_is_due(last, later, interval));
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
        assert!(!updater_error_is_no_release(&Error::BinaryNotFoundInArchive));
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
            super::apk_url_from_github_assets(&json).as_deref(),
            Some("https://example.com/app.apk")
        );
    }
}

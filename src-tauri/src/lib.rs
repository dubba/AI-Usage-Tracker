mod account_order;
mod alerts;
#[cfg(target_os = "android")]
mod apk_install;
mod bridge_api;
mod buckets;
mod camera_permission;
mod fs_util;
mod google_ai_studio_oauth;
mod grok_login;
mod lan_binding;
mod mobile_auth;
mod model;
mod oauth;
mod opencode_login;
mod pairing;
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
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};
use tokio::io::AsyncWriteExt;
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
        "OpenCode-Go".to_string()
    } else if provider == Provider::Grok && label.trim().is_empty() {
        "Grok".to_string()
    } else if provider == Provider::Openai && label.trim().is_empty() {
        "ChatGPT".to_string()
    } else if provider == Provider::Anthropic && label.trim().is_empty() {
        "Claude".to_string()
    } else if provider == Provider::Antigravity && label.trim().is_empty() {
        "Antigravity".to_string()
    } else if provider == Provider::GoogleAiStudio && label.trim().is_empty() {
        "AI-Studio".to_string()
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

    state.abort_login_resources(&attempt_id);
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

fn is_alert_window_available(account: &Account, window_id: &str) -> bool {
    if let Some(usage) = account.last_usage.as_ref() {
        if usage.windows.iter().any(|window| {
            alerts::canonical_window_id(window) == Some(window_id)
        }) {
            return true;
        }
    }
    // Free OpenAI/ChatGPT accounts operate on a 30-day (monthly) quota limit.
    // Recognize monthly limit for OpenAI free tier accounts even if last_usage is pending
    // or cached with legacy session labels.
    if account.provider == Provider::Openai
        && window_id == "monthly"
        && account.plan.as_deref().map_or(true, |p| p.eq_ignore_ascii_case("free"))
    {
        return true;
    }
    // Paid OpenAI accounts support 5-hour and weekly limits.
    if account.provider == Provider::Openai
        && (window_id == "five_hour" || window_id == "weekly")
        && account.plan.as_deref().map_or(false, |p| !p.eq_ignore_ascii_case("free"))
    {
        return true;
    }
    false
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
        if !setting.enabled {
            continue;
        }
        if !is_alert_window_available(&account, &setting.window_id) {
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
    // Return masked info only; the UI must call reveal_bridge_token after
    // explicit user confirmation to display or copy the new value once.
    Ok(bridge_info(state.inner().as_ref()))
}

/// Explicit user-confirmed reveal of the full bridge bearer token.
/// The frontend must call this only from a Reveal/Copy click handler — never
/// on a timer — so the full token crosses IPC once per user action instead of
/// on every `get_bridge_info` poll.
#[tauri::command]
fn reveal_bridge_token(state: State<'_, Arc<AppState>>) -> Result<String, String> {
    Ok(state.bridge_token.read().clone())
}

#[tauri::command]
async fn pairing_start_host(
    state: State<'_, Arc<AppState>>,
) -> Result<crate::pairing::PairingHostInit, String> {
    crate::lan_binding::configure_pairing_network(true);
    state.pairing.start_host(state.inner().clone()).await
}

#[tauri::command]
async fn pairing_start_receiver(
    state: State<'_, Arc<AppState>>,
) -> Result<crate::pairing::PairingReceiverInit, String> {
    state.pairing.start_receiver(state.inner().clone()).await
}

#[tauri::command]
async fn ensure_camera_permission() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(crate::camera_permission::ensure)
        .await
        .map_err(|e| format!("Camera permission check failed: {e}"))?
}

#[tauri::command]
async fn pairing_start_client(
    state: State<'_, Arc<AppState>>,
    qr_uri: String,
) -> Result<(), String> {
    crate::lan_binding::configure_pairing_network(true);
    state.pairing.start_client(state.inner().clone(), qr_uri).await
}

#[tauri::command]
async fn pairing_start_sender(
    state: State<'_, Arc<AppState>>,
    qr_uri: String,
) -> Result<(), String> {
    state.pairing.start_sender(state.inner().clone(), qr_uri).await
}

#[tauri::command]
async fn pairing_start_client_by_code(
    state: State<'_, Arc<AppState>>,
    code: String,
) -> Result<(), String> {
    crate::lan_binding::configure_pairing_network(true);
    state
        .pairing
        .start_client_by_code(state.inner().clone(), code)
        .await
}

#[tauri::command]
async fn pairing_select_role(
    state: State<'_, Arc<AppState>>,
    role: String,
) -> Result<(), String> {
    state.pairing.select_role(&role).await
}

#[tauri::command]
async fn pairing_confirm_sas(
    state: State<'_, Arc<AppState>>,
    session_id: String,
    confirmed: bool,
) -> Result<(), String> {
    state.pairing.confirm_sas(&session_id, confirmed).await
}

#[tauri::command]
async fn pairing_cancel(state: State<'_, Arc<AppState>>) -> Result<(), String> {
    state.pairing.cancel().await;
    *state.pairing_include_settings.write() = false;
    *state.pairing_pending_ui_state.write() = None;
    *state.pairing_allow_credential_replace.write() = false;
    crate::lan_binding::configure_pairing_network(false);
    Ok(())
}

#[tauri::command]
async fn pairing_status(
    state: State<'_, Arc<AppState>>,
) -> Result<crate::pairing::PairingStatus, String> {
    Ok(state.pairing.get_status().await)
}

#[tauri::command]
fn pairing_set_include_settings(state: State<'_, Arc<AppState>>, include: bool) -> Result<(), String> {
    *state.pairing_include_settings.write() = include;
    Ok(())
}

#[tauri::command]
fn pairing_set_allow_credential_replace(
    state: State<'_, Arc<AppState>>,
    allow: bool,
) -> Result<(), String> {
    // Explicit per-transfer opt-in to overwrite credentials of existing local
    // accounts during the next pairing import. Defaults to false (preserve).
    *state.pairing_allow_credential_replace.write() = allow;
    Ok(())
}

#[tauri::command]
fn pairing_set_pending_ui_state(
    state: State<'_, Arc<AppState>>,
    ui_state: serde_json::Value,
) -> Result<(), String> {
    // Validate that it's an object with expected optional fields
    if !ui_state.is_object() && !ui_state.is_null() {
        return Err("UI state must be an object".into());
    }
    *state.pairing_pending_ui_state.write() = Some(ui_state);
    Ok(())
}

#[tauri::command]
fn pairing_clear_pending_ui_state(state: State<'_, Arc<AppState>>) -> Result<(), String> {
    *state.pairing_pending_ui_state.write() = None;
    *state.pairing_include_settings.write() = false;
    Ok(())
}

#[tauri::command]
fn pairing_prepare_airgap_export(
    state: State<'_, Arc<AppState>>,
    include_settings: bool,
    ui_state: Option<serde_json::Value>,
) -> Result<pairing::airgap::AirgapExport, String> {
    *state.pairing_include_settings.write() = include_settings;
    if let Some(ui) = ui_state {
        *state.pairing_pending_ui_state.write() = Some(ui);
    } else if !include_settings {
        *state.pairing_pending_ui_state.write() = None;
    }
    pairing::airgap::prepare_airgap_export(state.inner().as_ref())
}

#[tauri::command]
fn pairing_verify_airgap(
    chunks: Vec<String>,
) -> Result<pairing::airgap::AirgapVerifyResult, String> {
    pairing::airgap::verify_airgap_frames(chunks)
}

#[tauri::command]
async fn pairing_import_airgap(
    state: State<'_, Arc<AppState>>,
    chunks: Vec<String>,
) -> Result<pairing::payload::SyncSummary, String> {
    pairing::airgap::import_airgap_payload(state.inner(), chunks).await
}

static PENDING_PAIRING_URI: parking_lot::Mutex<Option<String>> = parking_lot::Mutex::new(None);
static GLOBAL_APP_HANDLE: parking_lot::Mutex<Option<AppHandle>> = parking_lot::Mutex::new(None);

#[cfg(target_os = "android")]
#[no_mangle]
pub extern "C" fn Java_com_yajinni_paseousagebridge_MainActivity_setPendingPairingUri(
    mut env: jni::JNIEnv,
    _class: jni::objects::JClass,
    uri: jni::objects::JString,
) {
    if let Ok(uri_str) = env.get_string(&uri) {
        let uri_val = uri_str.to_string_lossy().into_owned();
        // Validate before storing: any app can fire a VIEW intent, and the
        // URI carries key material. Never log its contents.
        if !is_valid_incoming_pairing_uri(&uri_val) {
            return;
        }
        *PENDING_PAIRING_URI.lock() = Some(uri_val.clone());
        if let Some(app) = GLOBAL_APP_HANDLE.lock().as_ref() {
            use tauri::Emitter;
            let _ = app.emit("pairing-uri-received", uri_val);
        }
    }
}

/// Length-bounded allowlist check for pairing URIs arriving from Android
/// intents. Full cryptographic validation happens in
/// `pairing::protocol::ParsedQrPayload::parse` before any connection.
#[cfg(target_os = "android")]
fn is_valid_incoming_pairing_uri(uri: &str) -> bool {
    if uri.len() > 2048 {
        return false;
    }
    uri.starts_with("aiusage-pair:") || uri.starts_with("aiusage:")
}

#[tauri::command]
async fn get_pending_pairing_uri() -> Result<Option<String>, String> {
    Ok(PENDING_PAIRING_URI.lock().take())
}

fn split_version(v: &str) -> (Vec<u64>, Option<String>) {
    let v = v.trim().trim_start_matches(['v', 'V']);
    let numeric_end = v
        .char_indices()
        .find(|(_, ch)| !ch.is_ascii_digit() && *ch != '.')
        .map(|(i, _)| i)
        .unwrap_or(v.len());
    let numeric = v[..numeric_end]
        .split('.')
        .filter_map(|part| {
            if part.is_empty() {
                None
            } else {
                part.parse::<u64>().ok()
            }
        })
        .collect();
    let pre = v[numeric_end..]
        .trim_start_matches(|ch: char| !ch.is_ascii_alphanumeric())
        .to_ascii_lowercase();
    (numeric, if pre.is_empty() { None } else { Some(pre) })
}

fn compare_prerelease(cand: &str, curr: &str) -> bool {
    let cand_tokens: Vec<&str> = cand.split(['.', '-', '_']).filter(|s| !s.is_empty()).collect();
    let curr_tokens: Vec<&str> = curr.split(['.', '-', '_']).filter(|s| !s.is_empty()).collect();
    let min_len = cand_tokens.len().min(curr_tokens.len());
    for i in 0..min_len {
        let c = cand_tokens[i];
        let u = curr_tokens[i];
        if c == u {
            continue;
        }
        let c_num = c.parse::<u64>();
        let u_num = u.parse::<u64>();
        match (c_num, u_num) {
            (Ok(cn), Ok(un)) => return cn > un,
            (Ok(_), Err(_)) => return false,
            (Err(_), Ok(_)) => return true,
            (Err(_), Err(_)) => return c > u,
        }
    }
    cand_tokens.len() > curr_tokens.len()
}

#[allow(dead_code)]
fn is_newer_version(candidate: &str, current: &str) -> bool {
    let (cand_parts, cand_pre) = split_version(candidate);
    let (curr_parts, curr_pre) = split_version(current);
    let max_len = cand_parts.len().max(curr_parts.len());
    for i in 0..max_len {
        let cand = cand_parts.get(i).copied().unwrap_or(0);
        let curr = curr_parts.get(i).copied().unwrap_or(0);
        if cand != curr {
            return cand > curr;
        }
    }
    match (cand_pre.as_deref(), curr_pre.as_deref()) {
        (None, Some(_)) => true,
        (Some(_), None) => false,
        (None, None) => false,
        (Some(cand), Some(curr)) => compare_prerelease(cand, curr),
    }
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
    #[cfg_attr(not(target_os = "android"), allow(dead_code))]
    apk_sha256_url: Option<String>,
}

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
fn is_expected_apk_name(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    name.ends_with(".apk")
        && !name.contains("unsigned")
        && name.replace(['.', '_', ' '], "-").contains("ai-usage-tracker")
}

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
fn apk_assets_from_github(json: &serde_json::Value) -> (Option<String>, Option<String>) {
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
        let has_arch = lower.contains("arm") || lower.contains("x86") || lower.contains("universal");
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
    let version = tag.trim().trim_start_matches(['v', 'V']);
    if version.is_empty() {
        return Err(
            "Unable to check for updates: latest GitHub release has no version tag.".into(),
        );
    }

    let (apk_url, apk_sha256_url) = apk_assets_from_github(&json);
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
        apk_url,
        apk_sha256_url,
    })
}

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
async fn fetch_apk_sha256(url: &str) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
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

fn parse_sha256_digest(body: &str) -> Option<String> {
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

#[allow(dead_code)]
fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

const MAX_APK_BYTES: u64 = 250 * 1024 * 1024;

#[derive(Clone, Serialize)]
struct AppUpdateProgress {
    phase: &'static str,
    downloaded: u64,
    total: Option<u64>,
    percent: Option<u8>,
}

fn update_download_percent(downloaded: u64, total: Option<u64>) -> Option<u8> {
    let total = total.filter(|value| *value > 0)?;
    Some(((downloaded.min(total).saturating_mul(100)) / total) as u8)
}

fn emit_update_progress(
    app: &AppHandle,
    phase: &'static str,
    downloaded: u64,
    total: Option<u64>,
) {
    let payload = AppUpdateProgress {
        phase,
        downloaded,
        total,
        percent: update_download_percent(downloaded, total),
    };
    let _ = app.emit("app-update-progress", payload);
}

#[cfg(target_os = "android")]
fn notify_android_download_progress(percent: Option<u8>) {
    match percent {
        Some(value) => apk_install::show_download_progress(i32::from(value), false),
        None => apk_install::show_download_progress(0, true),
    }
}

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
async fn download_android_apk(
    app: &AppHandle,
    url: &str,
    dest: &std::path::Path,
) -> Result<String, String> {
    use sha2::{Digest, Sha256};

    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(20))
        .timeout(Duration::from_secs(15 * 60))
        .redirect(reqwest::redirect::Policy::limited(10))
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
                emit_update_progress(&app, "downloading", 0, None);
                let downloaded = std::sync::atomic::AtomicU64::new(0);
                let result = update
                    .download_and_install(
                        |chunk, total| {
                            let so_far = downloaded
                                .fetch_add(chunk as u64, std::sync::atomic::Ordering::Relaxed)
                                + chunk as u64;
                            emit_update_progress(&app, "downloading", so_far, total);
                        },
                        || {
                            emit_update_progress(&app, "installing", 0, None);
                        },
                    )
                    .await;
                result.map_err(|error| format!("Unable to install the update: {error}"))?;
                app.restart();
                #[allow(unreachable_code)]
                return Ok(());
            }
        }
    }

    #[cfg(target_os = "android")]
    {
        apk_install::ensure_can_install()?;
        let latest = fetch_github_latest_release().await?;
        let apk_url = latest.apk_url.ok_or_else(|| {
            "The latest GitHub release does not include an Android APK.".to_string()
        })?;
        let dest_dir = app
            .path()
            .app_data_dir()
            .or_else(|_| app.path().app_cache_dir())
            .map_err(|error| format!("Unable to save the update: {error}"))?;
        let dest = dest_dir.join("updates").join("ai-usage-tracker-update.apk");
        let digest = download_android_apk(&app, &apk_url, &dest).await?;
        emit_update_progress(&app, "verifying", 0, None);
        if let Some(sha_url) = latest.apk_sha256_url.as_deref() {
            let expected = fetch_apk_sha256(sha_url).await?;
            if expected != digest {
                let _ = tokio::fs::remove_file(&dest).await;
                apk_install::clear_update_notification();
                return Err("The downloaded update did not match the published checksum.".into());
            }
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
        // Older builds cached the Antigravity Google Cloud *project* id in the
        // account identity field. Project ids always contain a letter or hyphen;
        // Google user ids are all digits. Clear non-numeric values so pairing
        // no longer treats distinct accounts sharing a project as duplicates.
        if account.provider == Provider::Antigravity {
            let polluted = account
                .provider_account_id
                .as_deref()
                .is_some_and(|value| !value.bytes().all(|b| b.is_ascii_digit()));
            if polluted {
                let _ = state.store.mutate(&account.id, |account| {
                    account.provider_account_id = None;
                });
            }
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
    let token = state.bridge_token.read().clone();
    let token_last4 = if token.len() >= 4 {
        token[token.len() - 4..].to_string()
    } else {
        String::new()
    };
    BridgeInfo {
        endpoint: status.endpoint,
        token: crate::model::mask_bridge_token(&token),
        token_last4,
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

            #[cfg(target_os = "macos")]
            setup_macos_notification_delegate();

            let data_dir = app.path().app_data_dir()?;
            crate::store::set_data_dir(data_dir.clone());
            // Crash-safe cleanup: remove stale private Grok login profiles left
            // by a previous crash/kill before any new login window opens.
            #[cfg(desktop)]
            crate::grok_login::sweep_stale_grok_profiles();
            let token = load_or_create_bridge_token()
                .map_err(|error| std::io::Error::other(error.to_string()))?;
            let state = Arc::new(AppState::new(data_dir, token).map_err(std::io::Error::other)?);
            migrate_google_ai_studio_accounts(state.as_ref());
            state.set_app_handle(app.handle().clone());
            *GLOBAL_APP_HANDLE.lock() = Some(app.handle().clone());
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
            reveal_bridge_token,
            check_for_app_update,
            install_app_update,
            ensure_camera_permission,
            pairing_start_host,
            pairing_start_receiver,
            pairing_start_client,
            pairing_start_client_by_code,
            pairing_start_sender,
            pairing_select_role,
            pairing_confirm_sas,
            pairing_cancel,
            pairing_status,
            pairing_set_include_settings,
            pairing_set_allow_credential_replace,
            pairing_set_pending_ui_state,
            pairing_clear_pending_ui_state,
            pairing_prepare_airgap_export,
            pairing_verify_airgap,
            pairing_import_airgap,
            get_pending_pairing_uri,
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
                _ = state.wait_for_refresh_wakeup() => break,
            }
        }
    }
}

#[cfg(target_os = "macos")]
fn setup_macos_notification_delegate() {
    use block2::Block;
    use objc2::runtime::{AnyClass, AnyObject};
    use objc2::{define_class, msg_send, sel, ClassType};
    use std::sync::Once;

    static INIT: Once = Once::new();
    INIT.call_once(|| {
        // Legacy NSUserNotificationCenter delegate. Declared with
        // `define_class!` so the runtime verifies the method encoding;
        // messaging goes through the typed `msg_send!` macro instead of a
        // transmuted `objc_msgSend` function pointer.
        define_class!(
            #[unsafe(super(objc2::runtime::NSObject))]
            struct AiUsageNotificationCenterDelegate;

            impl AiUsageNotificationCenterDelegate {
                #[unsafe(method(userNotificationCenter:shouldPresentNotification:))]
                unsafe fn should_present(
                    &self,
                    _center: *mut AnyObject,
                    _notification: *mut AnyObject,
                ) -> bool {
                    true
                }
            }
        );

        // Modern UNUserNotificationCenter delegate. The completion handler is
        // typed as a real block and invoked via `block2::Block::call`
        // instead of calling a raw function pointer from a C struct.
        define_class!(
            #[unsafe(super(objc2::runtime::NSObject))]
            struct AiUsageModernNotificationCenterDelegate;

            impl AiUsageModernNotificationCenterDelegate {
                #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
                unsafe fn will_present(
                    &self,
                    _center: *mut AnyObject,
                    _notification: *mut AnyObject,
                    completion_handler: *mut Block<dyn Fn(u64)>,
                ) {
                    if completion_handler.is_null() {
                        return;
                    }
                    // Banner, List, Alert, Sound, Badge.
                    let options: u64 = (1 << 4) | (1 << 3) | (1 << 2) | (1 << 1) | (1 << 0);
                    (*completion_handler).call((options,));
                }
            }
        );

        // NSUserNotificationCenter.defaultUserNotificationCenter
        let Some(center_class) = AnyClass::get(c"NSUserNotificationCenter") else {
            return;
        };
        let center: *mut AnyObject = unsafe { msg_send![center_class, defaultUserNotificationCenter] };
        if center.is_null() {
            return;
        }

        let delegate_class = AiUsageNotificationCenterDelegate::class();
        let delegate: *mut AnyObject = unsafe { msg_send![delegate_class, new] };
        if !delegate.is_null() {
            unsafe {
                let _: () = msg_send![center, setDelegate: delegate];
            }
        }

        // UNUserNotificationCenter.currentNotificationCenter
        let Some(un_center_class) = AnyClass::get(c"UNUserNotificationCenter") else {
            return;
        };
        let un_center: *mut AnyObject =
            unsafe { msg_send![un_center_class, currentNotificationCenter] };
        if un_center.is_null() {
            return;
        }
        let modern_class = AiUsageModernNotificationCenterDelegate::class();
        let modern_delegate: *mut AnyObject = unsafe { msg_send![modern_class, new] };
        if !modern_delegate.is_null() {
            unsafe {
                let _: () = msg_send![un_center, setDelegate: modern_delegate];
            }
            // Keep the selector referenced so the intent is explicit even
            // though `define_class!` registers the method encoding.
            let _ = sel!(userNotificationCenter:willPresentNotification:withCompletionHandler:);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::{
        account_refresh_is_due, github_latest_http_is_inaccessible, is_expected_apk_name,
        is_newer_version, parse_sha256_digest, updater_error_is_no_release,
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
                    "browser_download_url": "https://example.com/app.tar.gz"
                },
                {
                    "name": "AI.Usage.Tracker_0.3.5.apk",
                    "browser_download_url": "https://example.com/app.apk"
                }
            ]
        });
        assert_eq!(
            super::apk_assets_from_github(&json).0.as_deref(),
            Some("https://example.com/app.apk")
        );
    }

    #[test]
    fn recognizes_monthly_window_for_free_openai_accounts() {
        use crate::model::{now_rfc3339, Account, Provider};

        let now = now_rfc3339();
        let free_account = Account {
            id: "openai-free".into(),
            label: "Free ChatGPT".into(),
            provider: Provider::Openai,
            email: None,
            provider_account_id: None,
            chatgpt_account_id: None,
            plan: Some("free".into()),
            created_at: now.clone(),
            updated_at: now.clone(),
            last_usage: None,
            last_error: None,
            auth_required: false,
        };

        assert!(super::is_alert_window_available(&free_account, "monthly"));
        assert!(!super::is_alert_window_available(&free_account, "five_hour"));
    }
}

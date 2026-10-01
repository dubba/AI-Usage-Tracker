use super::validate_label;
use crate::{
    google_ai_studio_oauth, grok_login, limits,
    model::{Account, LoginStart, LoginStatus, Provider},
    oauth, opencode_login, providers,
    state::AppState,
};
use std::str::FromStr;
use std::sync::Arc;
use tauri::Manager;
use tauri::{AppHandle, State};

#[tauri::command]
pub async fn start_login(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    label: String,
    provider: String,
    email: Option<String>,
) -> Result<LoginStart, String> {
    let provider = Provider::from_str(&provider)?;
    let email = limits::normalize_optional_email(email)?;
    let label = if label.trim().is_empty() {
        provider.display_name().to_string()
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
pub async fn probe_google_ai_studio_key(
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
pub async fn add_google_ai_studio_account(
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
pub async fn start_google_ai_studio_usage_login(
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
pub async fn add_grok_account(
    state: State<'_, Arc<AppState>>,
    label: String,
    cookie_header: String,
) -> Result<Account, String> {
    let label = if label.trim().is_empty() {
        Provider::Grok.display_name().to_string()
    } else {
        validate_label(&label)?
    };
    grok_login::add_account(state.inner().clone(), label, cookie_header).await
}

#[tauri::command]
pub async fn add_opencode_go_account(
    state: State<'_, Arc<AppState>>,
    label: String,
    workspace_id: String,
    auth_cookie: String,
    email: Option<String>,
) -> Result<Account, String> {
    let label = if label.trim().is_empty() {
        Provider::OpencodeGo.display_name().to_string()
    } else {
        validate_label(&label)?
    };
    let email = limits::normalize_optional_email(email)?;
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
pub async fn get_login_status(
    state: State<'_, Arc<AppState>>,
    attempt_id: String,
) -> Result<LoginStatus, String> {
    oauth::login_status(state.inner(), &attempt_id).await
}

#[tauri::command]
pub fn current_login_status(state: State<'_, Arc<AppState>>) -> Option<LoginStatus> {
    state.pending_login.read().clone()
}

#[tauri::command]
pub fn cancel_login(
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

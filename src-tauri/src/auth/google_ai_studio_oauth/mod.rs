use crate::{
    auth::google_client::{client_secret, CLIENT_ID, TOKEN_URL},
    auth::{
        oauth_common::{
            spawn_callback_server, spawn_login_timeout, CallbackQuery, OAUTH_LOGIN_TIMEOUT_MINUTES,
        },
        pkce::{pkce_challenge, random_base64},
        result_pages::{account_connected_html, auth_failure_html, callback_html, escape_html},
    },
    model::{
        Account, CloudProjectOption, GoogleAiStudioSecret, LoginStart, LoginState, LoginStatus,
        OAuthSecret, Provider, ProviderSecret,
    },
    providers::{
        google_ai_studio,
        oauth_refresh::{IdToken, Lifetime, RefreshBody, TokenResponse},
        ProviderError,
    },
    state::AppState,
    store::{load_provider_secret, save_provider_secret},
    usage,
};
use axum::{
    extract::{Query, State},
    routing::get,
    Router,
};
use chrono::{Duration, Utc};
use reqwest::StatusCode;
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::sync::oneshot;
use url::Url;
use uuid::Uuid;

mod monitoring;
mod projects;
mod secret;

use monitoring::*;
use projects::*;
use secret::*;

const READ_ONLY_SCOPES: &str = "openid email profile https://www.googleapis.com/auth/monitoring.read https://www.googleapis.com/auth/cloudplatformprojects.readonly https://www.googleapis.com/auth/cloud-platform.read-only";
const ENABLE_SCOPES: &str = "openid email profile https://www.googleapis.com/auth/monitoring.read https://www.googleapis.com/auth/cloudplatformprojects.readonly https://www.googleapis.com/auth/service.management";

#[derive(Clone, Debug)]
enum LoginMode {
    Connect,
    EnableMonitoring { project_id: String },
}

struct LoginContext {
    app: Arc<AppState>,
    attempt_id: String,
    account_id: String,
    mode: LoginMode,
    expected_state: String,
    redirect_uri: String,
    verifier: String,
    /// Set by the first request that carries `expected_state`, so the code is
    /// exchanged once even if the redirect arrives twice.
    callback_claimed: AtomicBool,
}

#[allow(clippy::large_enum_variant)]
#[derive(Clone)]
enum CallbackOutcome {
    Complete(Account),
    ChooseProject(Vec<CloudProjectOption>),
    MonitoringDisabled(CloudProjectOption),
}

pub async fn start_login(
    app: Arc<AppState>,
    account_id: String,
    project_id: String,
    enable_monitoring: bool,
) -> Result<LoginStart, String> {
    validate_google_ai_studio_account(app.as_ref(), &account_id)?;

    let project_id = project_id.trim();
    if enable_monitoring {
        return start_oauth(
            app,
            account_id,
            LoginMode::EnableMonitoring {
                project_id: validate_project_id(project_id)?,
            },
        )
        .await;
    }

    if !project_id.is_empty() {
        return select_project(app, account_id, validate_project_id(project_id)?).await;
    }

    start_oauth(app, account_id, LoginMode::Connect).await
}

async fn start_oauth(
    app: Arc<AppState>,
    account_id: String,
    mode: LoginMode,
) -> Result<LoginStart, String> {
    let attempt_id = Uuid::new_v4().to_string();
    let message = Some(match &mode {
        LoginMode::Connect => {
            "Sign in to Google so the app can find the API key's Cloud project automatically."
                .into()
        }
        LoginMode::EnableMonitoring { project_id } => {
            format!("Authorize enabling Cloud Monitoring for project {project_id}.")
        }
    });

    let pending = app.begin_login_guarded(&attempt_id, message)?;

    let (listener, addr) = crate::auth::oauth::bind_ephemeral_loopback().await?;
    let expected_state = random_base64(24);
    let redirect_uri = crate::auth::oauth::loopback_http_origin(addr);
    app.set_login_callback(&attempt_id, &redirect_uri);
    let verifier = random_base64(48);
    let challenge = pkce_challenge(&verifier);
    let scopes = match &mode {
        LoginMode::Connect => READ_ONLY_SCOPES,
        LoginMode::EnableMonitoring { .. } => ENABLE_SCOPES,
    };
    let authorization_url =
        build_authorization_url(&redirect_uri, &expected_state, scopes, &challenge)?;
    // From here a failure is shown as a failed attempt instead of being forgotten.
    pending.keep();
    let expires_at = (Utc::now() + Duration::minutes(OAUTH_LOGIN_TIMEOUT_MINUTES)).to_rfc3339();

    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    app.register_login_shutdown(attempt_id.clone(), shutdown_tx);
    let context = Arc::new(LoginContext {
        app: app.clone(),
        attempt_id: attempt_id.clone(),
        account_id,
        mode,
        expected_state,
        redirect_uri,
        verifier,
        callback_claimed: AtomicBool::new(false),
    });
    let router = Router::new()
        .route("/", get(callback))
        .route("/callback", get(callback))
        .with_state(context.clone());

    let server_context = context.clone();
    spawn_callback_server(
        app.clone(),
        attempt_id.clone(),
        listener,
        router,
        shutdown_rx,
        "Google Cloud callback server failed",
        move |message| {
            server_context
                .app
                .fail_login_if_waiting(&server_context.attempt_id, message)
        },
    );

    let timeout_context = context.clone();
    spawn_login_timeout(
        app.clone(),
        attempt_id.clone(),
        std::time::Duration::from_secs((OAUTH_LOGIN_TIMEOUT_MINUTES * 60) as u64),
        "Google Cloud authorization timed out. Start it again.".into(),
        move |message| {
            timeout_context
                .app
                .fail_login_if_waiting(&timeout_context.attempt_id, message)
        },
    );

    // Desktop opens a private sign-in window (Back button on the Google page).
    // Mobile keeps the system browser: third-party sign-in pages must never
    // load in the main webview, which carries privileged Tauri IPC.
    #[cfg(desktop)]
    {
        if let Err(error) = crate::auth::oauth::open_provider_login_window(
            &app,
            &attempt_id,
            &authorization_url,
            "Sign in to Google AI Studio",
        ) {
            app.fail_login_if_waiting(&attempt_id, error.clone());
            app.abort_login_resources(&attempt_id);
            return Err(error);
        }
        Ok(LoginStart {
            attempt_id,
            authorization_url: String::new(),
            expires_at,
        })
    }
    #[cfg(not(desktop))]
    {
        Ok(LoginStart {
            attempt_id,
            authorization_url,
            expires_at,
        })
    }
}

async fn select_project(
    app: Arc<AppState>,
    account_id: String,
    project_id: String,
) -> Result<LoginStart, String> {
    let attempt_id = Uuid::new_v4().to_string();
    let expires_at = (Utc::now() + Duration::minutes(OAUTH_LOGIN_TIMEOUT_MINUTES)).to_rfc3339();
    {
        let mut pending = app.pending_login.write();
        if pending
            .as_ref()
            .is_some_and(|login| login.status == LoginState::Waiting)
        {
            return Err(crate::auth::oauth_common::LOGIN_IN_PROGRESS_MESSAGE.into());
        }
        *pending = Some(LoginStatus::waiting(
            attempt_id.clone(),
            Some("Checking the selected Google Cloud project.".into()),
        ));
    }

    // Refresh and save under the same lock a usage refresh holds, then release
    // it before project setup. That path locks again, and this mutex is not reentrant.
    let app_for_refresh = app.clone();
    let oauth =
        modify_google_ai_studio_secret(app.as_ref(), &account_id, |mut stored| async move {
            let current = stored
                .cloud_oauth
                .clone()
                .ok_or_else(|| "Sign in to Google before selecting a project.".to_string())?;
            let fresh = ensure_fresh_oauth(app_for_refresh.as_ref(), current).await?;
            stored.cloud_oauth = Some(fresh.clone());
            Ok((stored, fresh))
        })
        .await?;

    let project = resolve_project_by_id(app.as_ref(), &project_id, &oauth.access_token).await?;
    let outcome = finish_project_setup(app.clone(), &account_id, project, oauth, None).await?;
    apply_outcome(app.as_ref(), &attempt_id, outcome)?;

    Ok(LoginStart {
        attempt_id,
        authorization_url: String::new(),
        expires_at,
    })
}

async fn callback(
    State(context): State<Arc<LoginContext>>,
    Query(query): Query<CallbackQuery>,
) -> axum::response::Response {
    // Only Google's redirect carries this attempt's state; anything else leaves
    // the sign-in and the callback server as they are (see oauth.rs).
    if query.state.as_deref() != Some(context.expected_state.as_str()) {
        return crate::auth::result_pages::unrecognized_callback_response();
    }
    if context.callback_claimed.swap(true, Ordering::SeqCst) {
        return crate::auth::result_pages::finishing_sign_in_response();
    }
    let result = complete_callback(context.clone(), query).await;
    if let Err(error) = &result {
        context
            .app
            .fail_login_if_waiting(&context.attempt_id, error.clone());
    }
    stop_callback(&context).await;

    let body = match result {
        Ok(CallbackOutcome::Complete(account)) => {
            account_connected_html("Account connected", &account)
        }
        Ok(CallbackOutcome::ChooseProject(_)) => {
            r#"<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0;min-height:100vh;min-height:100dvh;box-sizing:border-box;display:flex;flex-direction:column;align-items:center;justify-content:center;background:#000000;color:#f4f6f8;font-family:system-ui;padding:24px 20px;text-align:center"><div style="max-width:480px;width:100%"><h1 style="margin:0 0 12px;font-size:28px">Google sign-in complete</h1><p style="margin:0">Return to AI Usage Tracker and choose the project that owns this API key.</p></div></body></html>"#.into()
        }
        Ok(CallbackOutcome::MonitoringDisabled(project)) => format!(
            r#"<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0;min-height:100vh;min-height:100dvh;box-sizing:border-box;display:flex;flex-direction:column;align-items:center;justify-content:center;background:#000000;color:#f4f6f8;font-family:system-ui;padding:24px 20px;text-align:center"><div style="max-width:480px;width:100%"><h1 style="margin:0 0 12px;font-size:28px">Project found</h1><p style="margin:0 0 8px">{}</p><p style="margin:0">Return to AI Usage Tracker to enable Cloud Monitoring.</p></div></body></html>"#,
            escape_html(&project.display_name)
        ),
        Err(error) => auth_failure_html("Authorization failed", &error),
    };
    callback_html(body)
}

async fn complete_callback(
    context: Arc<LoginContext>,
    query: CallbackQuery,
) -> Result<CallbackOutcome, String> {
    if let Some(error) = query.error {
        return Err(query.error_description.unwrap_or(error));
    }
    let code = query
        .code
        .ok_or_else(|| "Google did not return an authorization code.".to_string())?;
    if query.state.as_deref() != Some(context.expected_state.as_str()) {
        return Err("OAuth state validation failed.".into());
    }
    if !context.app.login_is_waiting(&context.attempt_id) {
        return Err("The Google authorization was canceled.".into());
    }

    // The exchange and the save share the usage-refresh lock. A refresh that
    // loaded the previous secret cannot write it back over this grant, and
    // this grant cannot write a secret it loaded before that refresh finished.
    // Project setup locks again, so the guard ends with this save. The project
    // chooser returns after the save and does not write the secret a second time.
    let (oauth, email, api_key) =
        modify_google_ai_studio_secret(context.app.as_ref(), &context.account_id, |mut stored| {
            let context = context.clone();
            let code = code.clone();
            async move {
                let tokens = exchange_tokens(&context, &code).await?;
                if !context.app.login_is_waiting(&context.attempt_id) {
                    return Err("The Google authorization was canceled.".into());
                }
                let expires_at = tokens
                    .checked_expires_at(Lifetime::DefaultsToOneHour)
                    .ok_or_else(|| String::from("Invalid Google token response."))?;
                let refresh_token = tokens
                    .refresh_token
                    .or_else(|| {
                        stored
                            .cloud_oauth
                            .as_ref()
                            .map(|secret| secret.refresh_token.clone())
                    })
                    .ok_or_else(|| {
                        "Google did not return a refresh token. Revoke the app's Google access and try again."
                            .to_string()
                    })?;
                let oauth = OAuthSecret {
                    access_token: tokens.access_token,
                    refresh_token,
                    id_token: tokens.id_token,
                    expires_at,
                };
                let email = fetch_email(context.app.as_ref(), &oauth.access_token)
                    .await
                    .ok();
                if !context.app.login_is_waiting(&context.attempt_id) {
                    return Err("The Google authorization was canceled.".into());
                }
                let api_key = stored.api_key.clone();
                stored.cloud_oauth = Some(oauth.clone());
                update_account_identity(context.app.as_ref(), &context.account_id, email.clone())?;
                Ok((stored, (oauth, email, api_key)))
            }
        })
        .await?;

    let outcome = match &context.mode {
        LoginMode::Connect => {
            if let Some(project) =
                lookup_key_project(context.app.as_ref(), &api_key, &oauth.access_token).await?
            {
                finish_project_setup(
                    context.app.clone(),
                    &context.account_id,
                    project,
                    oauth,
                    email,
                )
                .await?
            } else {
                let projects = list_projects(context.app.as_ref(), &oauth.access_token).await?;
                if projects.is_empty() {
                    return Err("Google sign-in succeeded, but no accessible Cloud projects were found. Sign in with the account that owns the AI Studio API key.".into());
                }
                if projects.len() == 1 {
                    finish_project_setup(
                        context.app.clone(),
                        &context.account_id,
                        projects[0].clone(),
                        oauth,
                        email,
                    )
                    .await?
                } else {
                    CallbackOutcome::ChooseProject(projects)
                }
            }
        }
        LoginMode::EnableMonitoring { project_id } => {
            let project =
                resolve_project_by_id(context.app.as_ref(), project_id, &oauth.access_token)
                    .await?;
            enable_monitoring(context.app.as_ref(), &project, &oauth.access_token).await?;
            finish_connected_project(
                context.app.clone(),
                &context.account_id,
                project,
                oauth,
                email,
            )
            .await?
        }
    };

    apply_outcome(context.app.as_ref(), &context.attempt_id, outcome.clone())?;
    Ok(outcome)
}

async fn finish_project_setup(
    app: Arc<AppState>,
    account_id: &str,
    project: CloudProjectOption,
    oauth: OAuthSecret,
    email: Option<String>,
) -> Result<CallbackOutcome, String> {
    if monitoring_enabled(app.as_ref(), &project, &oauth.access_token).await? {
        finish_connected_project(app, account_id, project, oauth, email).await
    } else {
        save_project_selection(app.as_ref(), account_id, &project, oauth, email).await?;
        Ok(CallbackOutcome::MonitoringDisabled(project))
    }
}

async fn finish_connected_project(
    app: Arc<AppState>,
    account_id: &str,
    project: CloudProjectOption,
    oauth: OAuthSecret,
    email: Option<String>,
) -> Result<CallbackOutcome, String> {
    validate_monitoring_access_with_retry(app.as_ref(), &project.project_id, &oauth.access_token)
        .await?;
    save_project_selection(app.as_ref(), account_id, &project, oauth, email).await?;
    let account = usage::refresh_account(app, account_id).await?;
    Ok(CallbackOutcome::Complete(account))
}

async fn validate_monitoring_access_with_retry(
    app: &AppState,
    project_id: &str,
    access_token: &str,
) -> Result<(), String> {
    let mut last_error = None;
    for attempt in 0..5 {
        match google_ai_studio::validate_cloud_project_access(app, project_id, access_token).await {
            Ok(()) => return Ok(()),
            Err(error) => {
                last_error = Some(error.to_string());
                if attempt < 4 {
                    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                }
            }
        }
    }
    Err(last_error.unwrap_or_else(|| "Google Cloud Monitoring could not be reached.".into()))
}

/// Saves the chosen project. Every caller already saved `oauth` under the
/// account lock before the project checks ran, and a usage refresh may have
/// rotated it since, so the stored Cloud sign-in is kept as it is now; `oauth`
/// is only used when none is stored.
async fn save_project_selection(
    app: &AppState,
    account_id: &str,
    project: &CloudProjectOption,
    oauth: OAuthSecret,
    email: Option<String>,
) -> Result<(), String> {
    let lock = app.account_lock(account_id);
    let _guard = lock.lock().await;
    let mut stored = load_google_ai_studio_secret(account_id)?;
    stored.cloud_project_id = Some(project.project_id.clone());
    stored.cloud_oauth.get_or_insert(oauth);
    save_provider_secret(account_id, &ProviderSecret::GoogleAiStudio(stored))
        .map_err(|error| error.to_string())?;
    app.store
        .mutate(account_id, |account| {
            account.provider = Provider::GoogleAiStudio;
            account.provider_account_id =
                Some(format!("google-ai-studio-project:{}", project.project_id));
            account.plan = Some("Google AI Studio".into());
            if email.is_some() {
                account.email = email.clone();
            }
            account.last_error = None;
            account.auth_required = false;
        })
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn update_account_identity(
    app: &AppState,
    account_id: &str,
    email: Option<String>,
) -> Result<(), String> {
    app.store
        .mutate(account_id, |account| {
            account.provider = Provider::GoogleAiStudio;
            account.plan = Some("Google AI Studio".into());
            if email.is_some() {
                account.email = email.clone();
            }
            account.last_error = None;
            account.auth_required = false;
        })
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn apply_outcome(app: &AppState, attempt_id: &str, outcome: CallbackOutcome) -> Result<(), String> {
    let status = match outcome {
        CallbackOutcome::Complete(account) => LoginStatus::complete(attempt_id, account),
        CallbackOutcome::ChooseProject(projects) => LoginStatus {
            attempt_id: attempt_id.into(),
            status: LoginState::ChooseProject,
            message: None,
            account: None,
            projects: Some(projects),
            selected_project_id: None,
        },
        CallbackOutcome::MonitoringDisabled(project) => LoginStatus {
            attempt_id: attempt_id.into(),
            status: LoginState::MonitoringDisabled,
            message: None,
            account: None,
            selected_project_id: Some(project.project_id.clone()),
            projects: Some(vec![project]),
        },
    };
    if !app.update_login_if_waiting(attempt_id, |login| *login = status) {
        return Err("The Google authorization was canceled.".into());
    }
    Ok(())
}

pub(super) fn network_unavailable(action: &str) -> String {
    format!("{action} could not be reached. Check your network and try again.")
}

pub(super) async fn read_google_body(response: reqwest::Response) -> Result<String, String> {
    crate::providers::read_sign_in_body(response, "Google returned a response that is too large.")
        .await
        .map_err(str::to_string)
}

async fn exchange_tokens(context: &LoginContext, code: &str) -> Result<TokenResponse, String> {
    let client_secret = client_secret();
    let response = RefreshBody::Form(&[
        ("client_id", CLIENT_ID),
        ("client_secret", client_secret.as_str()),
        ("code", code),
        ("redirect_uri", context.redirect_uri.as_str()),
        ("grant_type", "authorization_code"),
        ("code_verifier", context.verifier.as_str()),
    ])
    .apply(context.app.client.post(TOKEN_URL))
    .send()
    .await
    .map_err(|_| network_unavailable("Google token exchange"))?;
    let status = response.status();
    let body = read_google_body(response).await?;
    if !status.is_success() {
        return Err(format!("Google token exchange failed ({status})."));
    }
    serde_json::from_str(&body).map_err(|_| String::from("Invalid Google token response."))
}

async fn fetch_email(app: &AppState, access_token: &str) -> Result<String, String> {
    let response = app
        .client
        .get("https://www.googleapis.com/oauth2/v2/userinfo")
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|error| format!("Google user-info request failed: {error}"))?;
    let status = response.status();
    let body = read_google_body(response).await?;
    if !status.is_success() {
        return Err(format!("Google user-info request returned {status}."));
    }
    let value: Value = serde_json::from_str(&body)
        .map_err(|_| String::from("Invalid Google user-info response."))?;
    value
        .get("email")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
        .ok_or_else(|| "Google user info did not contain an email address.".into())
}

fn build_authorization_url(
    redirect_uri: &str,
    state: &str,
    scopes: &str,
    challenge: &str,
) -> Result<String, String> {
    let mut url = Url::parse("https://accounts.google.com/o/oauth2/auth")
        .map_err(|error| error.to_string())?;
    url.query_pairs_mut()
        .append_pair("client_id", CLIENT_ID)
        .append_pair("redirect_uri", redirect_uri)
        .append_pair("response_type", "code")
        .append_pair("scope", scopes)
        .append_pair("state", state)
        .append_pair("code_challenge", challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("access_type", "offline")
        // `select_account` always shows Google's account chooser so a second
        // account can be connected while one session is active; `consent`
        // keeps the refresh token coming for that second account.
        .append_pair("prompt", "select_account consent");
    Ok(url.to_string())
}

async fn stop_callback(context: &LoginContext) {
    context.app.stop_login_shutdown(&context.attempt_id);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_google_project_ids() {
        assert_eq!(
            validate_project_id("example-project-123").unwrap(),
            "example-project-123"
        );
        assert!(validate_project_id("Example Project").is_err());
        assert!(validate_project_id("123-project").is_err());
    }

    #[test]
    fn authorize_url_accepts_bracketed_ipv6_loopback() {
        let url =
            build_authorization_url("http://[::1]:11461", "state", "openid email", "challenge")
                .unwrap();
        let parsed = Url::parse(&url).unwrap();
        assert_eq!(
            parsed
                .query_pairs()
                .find(|(key, _)| key == "redirect_uri")
                .map(|(_, value)| value.into_owned())
                .as_deref(),
            Some("http://[::1]:11461")
        );
    }

    #[test]
    fn authorize_url_omits_granted_scopes() {
        let url = build_authorization_url(
            "http://127.0.0.1:11461",
            "state",
            "openid email https://www.googleapis.com/auth/cloud-platform",
            "challenge",
        )
        .unwrap();
        let parsed = Url::parse(&url).unwrap();
        assert!(!parsed
            .query_pairs()
            .any(|(key, _)| key == "include_granted_scopes"));
        assert!(parsed
            .query_pairs()
            .any(|(key, value)| key == "code_challenge" && value == "challenge"));
        // The chooser must appear even with an active Google session, and
        // offline access must stay so a second account still gets a refresh
        // token.
        assert!(parsed
            .query_pairs()
            .any(|(key, value)| key == "prompt" && value == "select_account consent"));
        assert!(parsed
            .query_pairs()
            .any(|(key, value)| key == "access_type" && value == "offline"));
    }

    #[test]
    fn login_status_serializes_project_choices_for_the_frontend() {
        let status = LoginStatus {
            attempt_id: "attempt".into(),
            status: LoginState::MonitoringDisabled,
            message: None,
            account: None,
            selected_project_id: Some("example-project-123".into()),
            projects: Some(vec![CloudProjectOption {
                project_id: "example-project-123".into(),
                project_number: "123456789".into(),
                display_name: "Example Project".into(),
            }]),
        };
        let message = serde_json::to_string(&status).unwrap();
        assert!(message.contains("projectId"));
        assert!(message.contains("example-project-123"));
    }

    #[tokio::test]
    async fn a_callback_without_this_attempts_state_leaves_the_sign_in_running() {
        use axum::extract::{Query, State};
        let temp = tempfile::tempdir().unwrap();
        let app = Arc::new(AppState::new(temp.path().to_path_buf(), "test-token".into()).unwrap());
        *app.pending_login.write() = Some(crate::model::LoginStatus {
            attempt_id: "attempt".into(),
            status: crate::model::LoginState::Waiting,
            message: None,
            account: None,
            projects: None,
            selected_project_id: None,
        });
        let context = Arc::new(LoginContext {
            app: app.clone(),
            attempt_id: "attempt".into(),
            account_id: "account".into(),
            mode: LoginMode::Connect,
            expected_state: "s".into(),
            redirect_uri: "http://127.0.0.1:1".into(),
            verifier: "v".into(),
            callback_claimed: AtomicBool::new(false),
        });
        for state in [None, Some("wrong".to_string())] {
            let _ = callback(
                State(context.clone()),
                Query(CallbackQuery {
                    code: None,
                    state,
                    error: Some("access_denied".into()),
                    error_description: None,
                }),
            )
            .await;
            assert!(app.login_is_waiting("attempt"));
        }
    }

    #[tokio::test]
    async fn only_the_first_callback_with_this_attempts_state_is_handled() {
        use axum::extract::{Query, State};
        let temp = tempfile::tempdir().unwrap();
        let app = Arc::new(AppState::new(temp.path().to_path_buf(), "test-token".into()).unwrap());
        *app.pending_login.write() = Some(crate::model::LoginStatus {
            attempt_id: "attempt".into(),
            status: crate::model::LoginState::Waiting,
            message: None,
            account: None,
            projects: None,
            selected_project_id: None,
        });
        let context = Arc::new(LoginContext {
            app: app.clone(),
            attempt_id: "attempt".into(),
            account_id: "account".into(),
            mode: LoginMode::Connect,
            expected_state: "s".into(),
            redirect_uri: "http://127.0.0.1:1".into(),
            verifier: "v".into(),
            callback_claimed: AtomicBool::new(false),
        });
        let denied = || {
            Query(CallbackQuery {
                code: None,
                state: Some("s".into()),
                error: Some("access_denied".into()),
                error_description: None,
            })
        };
        // A first request is still being handled (its exchange is in flight).
        context.callback_claimed.store(true, Ordering::SeqCst);
        let _ = callback(State(context.clone()), denied()).await;
        assert!(
            app.login_is_waiting("attempt"),
            "a second request must not be handled while the first one runs"
        );
        // The first request is the one that settles the sign-in.
        context.callback_claimed.store(false, Ordering::SeqCst);
        let _ = callback(State(context.clone()), denied()).await;
        assert!(!app.login_is_waiting("attempt"));
    }

    fn function_body<'a>(source: &'a str, signature: &str) -> &'a str {
        let start = source
            .find(signature)
            .unwrap_or_else(|| panic!("missing {signature}"));
        let rest = &source[start + signature.len()..];
        let end = rest
            .find("\nasync fn ")
            .or_else(|| rest.find("\nfn "))
            .unwrap_or(rest.len());
        &rest[..end]
    }

    #[test]
    fn project_selection_and_the_callback_save_cloud_oauth_under_the_account_lock() {
        let source = include_str!("mod.rs");
        for signature in ["async fn select_project(", "async fn complete_callback("] {
            let body = function_body(source, signature);
            assert!(
                body.contains("modify_google_ai_studio_secret"),
                "{signature} must save through the locked helper"
            );
            assert!(
                !body.contains("save_provider_secret"),
                "{signature} must not write the secret itself"
            );
        }
        let helper = function_body(
            include_str!("secret.rs"),
            "async fn modify_google_ai_studio_secret<",
        );
        let lock = helper.find("account_lock").expect("helper takes the lock");
        let load = helper
            .find("load_google_ai_studio_secret")
            .expect("helper loads");
        let save = helper.find("save_provider_secret").expect("helper saves");
        assert!(
            lock < load && load < save,
            "load and save stay inside the lock"
        );
    }

    #[tokio::test(flavor = "current_thread")]
    #[allow(clippy::await_holding_lock)]
    async fn a_refresh_that_rotates_under_the_lock_is_not_overwritten_by_an_earlier_load() {
        let temp = tempfile::tempdir().unwrap();
        let app = Arc::new(AppState::new(temp.path().to_path_buf(), "test-token".into()).unwrap());
        // Credential files follow a process-wide directory. Hold it on this
        // temp dir for the overlap, including across the wait below.
        let _credentials = crate::store::pin_data_dir_for_test(temp.path().to_path_buf());
        let account_id = "l45-cloud-oauth";
        let now = crate::model::now_rfc3339();
        app.store
            .upsert(Account {
                id: account_id.into(),
                label: "Google AI Studio".into(),
                provider: Provider::GoogleAiStudio,
                email: None,
                provider_account_id: None,
                chatgpt_account_id: None,
                plan: Some("Google AI Studio".into()),
                created_at: now.clone(),
                updated_at: now,
                last_usage: None,
                last_error: None,
                auth_required: false,
            })
            .unwrap();
        save_provider_secret(account_id, &studio_secret("old")).unwrap();

        let loaded = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Notify::new());
        let loaded_flag = loaded.clone();
        let release_flag = release.clone();
        let callback_app = app.clone();
        let callback = tokio::spawn(async move {
            modify_google_ai_studio_secret(&callback_app, account_id, |stored| async move {
                // Inside the lock, after the load, before the save. A refresh
                // uses this same helper, so it cannot write until we return.
                loaded_flag.notify_one();
                release_flag.notified().await;
                Ok((stored, ()))
            })
            .await
            .unwrap();
        });

        loaded.notified().await;
        let refresh_app = app.clone();
        let refresh = tokio::spawn(async move {
            modify_google_ai_studio_secret(&refresh_app, account_id, |mut stored| async move {
                stored.cloud_oauth.as_mut().unwrap().refresh_token = "rotated".into();
                Ok((stored, ()))
            })
            .await
            .unwrap();
        });

        release.notify_one();
        callback.await.unwrap();
        refresh.await.unwrap();

        let stored = load_google_ai_studio_secret(account_id).unwrap();
        assert_eq!(
            stored.cloud_oauth.unwrap().refresh_token,
            "rotated",
            "the refresh that waited for the lock keeps the token it rotated"
        );
    }

    fn studio_account(account_id: &str) -> Account {
        let now = crate::model::now_rfc3339();
        Account {
            id: account_id.into(),
            label: "Google AI Studio".into(),
            provider: Provider::GoogleAiStudio,
            email: None,
            provider_account_id: None,
            chatgpt_account_id: None,
            plan: Some("Google AI Studio".into()),
            created_at: now.clone(),
            updated_at: now,
            last_usage: None,
            last_error: None,
            auth_required: false,
        }
    }

    #[tokio::test]
    async fn saving_the_project_keeps_a_cloud_token_rotated_after_the_sign_in() {
        let temp = tempfile::tempdir().unwrap();
        let app = Arc::new(AppState::new(temp.path().to_path_buf(), "test-token".into()).unwrap());
        let _credentials = crate::store::pin_data_dir_for_test(temp.path().to_path_buf());
        let account_id = "l85-project";
        app.store.upsert(studio_account(account_id)).unwrap();
        // The sign-in saved its token, then a refresh rotated it while the
        // project checks ran; the flow still holds the sign-in's copy.
        save_provider_secret(account_id, &studio_secret("rotated")).unwrap();
        let ProviderSecret::GoogleAiStudio(earlier) = studio_secret("from-sign-in") else {
            unreachable!()
        };
        let project = CloudProjectOption {
            project_id: "example-project-123".into(),
            project_number: "123".into(),
            display_name: "Example".into(),
        };
        save_project_selection(
            &app,
            account_id,
            &project,
            earlier.cloud_oauth.unwrap(),
            None,
        )
        .await
        .unwrap();
        let stored = load_google_ai_studio_secret(account_id).unwrap();
        assert_eq!(
            stored.cloud_project_id.as_deref(),
            Some("example-project-123")
        );
        assert_eq!(stored.cloud_oauth.unwrap().refresh_token, "rotated");
    }

    #[tokio::test]
    async fn an_api_key_reconnect_keeps_the_cloud_token_stored_when_it_saves() {
        let temp = tempfile::tempdir().unwrap();
        let app = Arc::new(AppState::new(temp.path().to_path_buf(), "test-token".into()).unwrap());
        // No data-dir pin: saving the account sets the data dir itself, which
        // waits on the same test lock. The id is unique to this test.
        let account_id = "l85-reconnect";
        app.store.upsert(studio_account(account_id)).unwrap();
        save_provider_secret(account_id, &studio_secret("before")).unwrap();

        // A usage refresh holds the account lock and rotates the token while
        // the reconnect is waiting to save.
        let lock = app.account_lock(account_id);
        let guard = lock.lock().await;
        let save_app = app.clone();
        let reconnect = tokio::spawn(async move {
            save_app
                .persist_connected_account_from_current(studio_account(account_id), |current| {
                    ProviderSecret::GoogleAiStudio(google_ai_studio::with_stored_cloud_fields(
                        "new-api-key".into(),
                        vec!["gemini-2.5-pro".into()],
                        current,
                    ))
                })
                .await
                .unwrap();
        });
        tokio::task::yield_now().await;
        save_provider_secret(account_id, &studio_secret("rotated")).unwrap();
        drop(guard);
        reconnect.await.unwrap();

        let stored = load_google_ai_studio_secret(account_id).unwrap();
        assert_eq!(stored.api_key, "new-api-key");
        assert_eq!(stored.cloud_oauth.unwrap().refresh_token, "rotated");
    }

    fn studio_secret(refresh_token: &str) -> ProviderSecret {
        ProviderSecret::GoogleAiStudio(GoogleAiStudioSecret {
            api_key: "test-api-key".into(),
            selected_models: vec!["gemini-2.5-pro".into()],
            cloud_project_id: None,
            cloud_oauth: Some(OAuthSecret {
                access_token: "access".into(),
                refresh_token: refresh_token.into(),
                id_token: None,
                expires_at: Utc::now().timestamp_millis() + 3_600_000,
            }),
        })
    }
}

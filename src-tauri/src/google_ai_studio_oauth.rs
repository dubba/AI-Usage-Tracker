use crate::{
    model::{Account, CloudProjectOption, LoginStart, LoginStatus, OAuthSecret, Provider, ProviderSecret},
    providers::google_ai_studio,
    state::AppState,
    store::{load_provider_secret, save_provider_secret},
    usage,
};
use axum::{
    extract::{Query, State},
    response::Html,
    routing::get,
    Router,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use chrono::{Duration, Utc};
use rand::RngCore;
use reqwest::StatusCode;
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::{net::TcpListener, sync::oneshot};
use url::Url;
use uuid::Uuid;

const GOOGLE_CLIENT_ID: &str =
    "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
const GOOGLE_CLIENT_SECRET_BYTES: &[u8] = &[
    71, 79, 67, 83, 80, 88, 45, 75, 53, 56, 70, 87, 82, 52, 56, 54, 76, 100, 76, 74, 49, 109, 76,
    66, 56, 115, 88, 67, 52, 122, 54, 113, 68, 65, 102,
];
const LOGIN_TIMEOUT_MINUTES: i64 = 5;
const MONITORING_SERVICE: &str = "monitoring.googleapis.com";
const READ_ONLY_SCOPES: &str = "openid email profile https://www.googleapis.com/auth/cloud-platform.read-only https://www.googleapis.com/auth/monitoring.read";
const ENABLE_SCOPES: &str = "openid email profile https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/monitoring.read";

#[derive(Clone, Debug)]
enum LoginMode {
    Connect,
    EnableMonitoring { project_id: String },
}

#[derive(Clone)]
struct LoginContext {
    app: Arc<AppState>,
    attempt_id: String,
    account_id: String,
    mode: LoginMode,
    expected_state: String,
    redirect_uri: String,
}

#[derive(Debug, Deserialize)]
struct CallbackQuery {
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
    error_description: Option<String>,
}

#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: Option<String>,
    id_token: Option<String>,
    expires_in: Option<i64>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectResponse {
    name: String,
    project_id: String,
    display_name: Option<String>,
    state: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectSearchResponse {
    #[serde(default)]
    projects: Vec<ProjectResponse>,
    next_page_token: Option<String>,
}

#[derive(Debug, Deserialize)]
struct LookupKeyResponse {
    parent: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ServiceResponse {
    state: Option<String>,
}

#[derive(Debug, Deserialize)]
struct OperationResponse {
    name: Option<String>,
    done: Option<bool>,
    error: Option<Value>,
}

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

    {
        let mut pending = app.pending_login.write();
        if pending.as_ref().is_some_and(|login| {
            matches!(
                login.status.as_str(),
                "waiting" | "choose_project" | "monitoring_disabled"
            )
        }) {
            return Err("Another provider login is already in progress.".into());
        }
        *pending = Some(LoginStatus {
            attempt_id: attempt_id.clone(),
            status: "waiting".into(),
            message,
            account: None,
            projects: None,
            selected_project_id: None,
        });
    }

    let (listener, port) = match bind_callback_port().await {
        Ok(bound) => bound,
        Err(error) => {
            let mut pending = app.pending_login.write();
            if pending.as_ref().is_some_and(|login| login.attempt_id == attempt_id) {
                *pending = None;
            }
            return Err(error);
        }
    };
    let expected_state = random_base64(24);
    let redirect_uri = format!("http://127.0.0.1:{port}");
    let scopes = match &mode {
        LoginMode::Connect => READ_ONLY_SCOPES,
        LoginMode::EnableMonitoring { .. } => ENABLE_SCOPES,
    };
    let authorization_url =
        match build_authorization_url(&redirect_uri, &expected_state, scopes) {
            Ok(url) => url,
            Err(error) => {
                let mut pending = app.pending_login.write();
                if pending.as_ref().is_some_and(|login| login.attempt_id == attempt_id) {
                    *pending = None;
                }
                return Err(error);
            }
        };
    let expires_at = (Utc::now() + Duration::minutes(LOGIN_TIMEOUT_MINUTES)).to_rfc3339();

    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    app.register_login_shutdown(attempt_id.clone(), shutdown_tx);
    let context = Arc::new(LoginContext {
        app: app.clone(),
        attempt_id: attempt_id.clone(),
        account_id,
        mode,
        expected_state,
        redirect_uri,
    });
    let router = Router::new()
        .route("/", get(callback))
        .route("/callback", get(callback))
        .with_state(context.clone());

    let server_context = context.clone();
    tokio::spawn(async move {
        if let Err(error) = axum::serve(listener, router)
            .with_graceful_shutdown(async {
                let _ = shutdown_rx.await;
            })
            .await
        {
            fail_login(
                &server_context,
                format!("Google Cloud callback server failed: {error}"),
            );
            server_context.app.stop_login_shutdown(&server_context.attempt_id);
        }
    });

    let timeout_context = context.clone();
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(
            (LOGIN_TIMEOUT_MINUTES * 60) as u64,
        ))
        .await;
        let waiting = timeout_context
            .app
            .pending_login
            .read()
            .as_ref()
            .is_some_and(|login| {
                login.attempt_id == timeout_context.attempt_id && login.status == "waiting"
            });
        if waiting {
            fail_login(
                &timeout_context,
                "Google Cloud authorization timed out. Start it again.".into(),
            );
            stop_callback(&timeout_context).await;
        }
    });

    Ok(LoginStart {
        attempt_id,
        authorization_url,
        expires_at,
    })
}

async fn select_project(
    app: Arc<AppState>,
    account_id: String,
    project_id: String,
) -> Result<LoginStart, String> {
    let attempt_id = Uuid::new_v4().to_string();
    let expires_at = (Utc::now() + Duration::minutes(LOGIN_TIMEOUT_MINUTES)).to_rfc3339();
    {
        let mut pending = app.pending_login.write();
        if pending.as_ref().is_some_and(|login| login.status == "waiting") {
            return Err("Another provider login is already in progress.".into());
        }
        *pending = Some(LoginStatus {
            attempt_id: attempt_id.clone(),
            status: "waiting".into(),
            message: Some("Checking the selected Google Cloud project.".into()),
            account: None,
            projects: None,
            selected_project_id: None,
        });
    }

    let mut stored = load_google_ai_studio_secret(&account_id)?;
    let oauth = stored
        .cloud_oauth
        .clone()
        .ok_or_else(|| "Sign in to Google before selecting a project.".to_string())?;
    let oauth = ensure_fresh_oauth(app.as_ref(), oauth).await?;
    stored.cloud_oauth = Some(oauth.clone());
    save_provider_secret(&account_id, &ProviderSecret::GoogleAiStudio(stored))
        .map_err(|error| error.to_string())?;

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
) -> Html<String> {
    let result = complete_callback(context.clone(), query).await;
    if let Err(error) = &result {
        fail_login(&context, error.clone());
    }
    stop_callback(&context).await;

    match result {
        Ok(CallbackOutcome::Complete(account)) => Html(format!(
            r#"<!doctype html><html><body style="background:#101412;color:#f4f6f8;font-family:system-ui;padding:50px;text-align:center"><h1>Google usage connected</h1><p>{}</p><p style="color:#8e9791">You can close this tab and return to AI Usage Tracker.</p></body></html>"#,
            escape_html(account.email.as_deref().unwrap_or(&account.label))
        )),
        Ok(CallbackOutcome::ChooseProject(_)) => Html(
            r#"<!doctype html><html><body style="background:#101412;color:#f4f6f8;font-family:system-ui;padding:50px;text-align:center"><h1>Google sign-in complete</h1><p>Return to AI Usage Tracker and choose the project that owns this API key.</p></body></html>"#.into(),
        ),
        Ok(CallbackOutcome::MonitoringDisabled(project)) => Html(format!(
            r#"<!doctype html><html><body style="background:#101412;color:#f4f6f8;font-family:system-ui;padding:50px;text-align:center"><h1>Project found</h1><p>{}</p><p>Return to AI Usage Tracker to enable Cloud Monitoring.</p></body></html>"#,
            escape_html(&project.display_name)
        )),
        Err(error) => Html(format!(
            r#"<!doctype html><html><body style="background:#101412;color:#f4f6f8;font-family:system-ui;padding:50px;text-align:center"><h1>Authorization failed</h1><p style="color:#ff9d9d">{}</p><p style="color:#8e9791">Return to the app and try again.</p></body></html>"#,
            escape_html(&error)
        )),
    }
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
    if !is_waiting(context.app.as_ref(), &context.attempt_id) {
        return Err("The Google authorization was cancelled.".into());
    }

    let mut stored = load_google_ai_studio_secret(&context.account_id)?;
    let tokens = exchange_tokens(&context, &code).await?;
    if !is_waiting(context.app.as_ref(), &context.attempt_id) {
        return Err("The Google authorization was cancelled.".into());
    }
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
        expires_at: Utc::now().timestamp_millis() + tokens.expires_in.unwrap_or(3600) * 1000,
    };
    let email = fetch_email(context.app.as_ref(), &oauth.access_token)
        .await
        .ok();
    if !is_waiting(context.app.as_ref(), &context.attempt_id) {
        return Err("The Google authorization was cancelled.".into());
    }
    stored.cloud_oauth = Some(oauth.clone());
    save_provider_secret(
        &context.account_id,
        &ProviderSecret::GoogleAiStudio(stored.clone()),
    )
    .map_err(|error| error.to_string())?;
    update_account_identity(context.app.as_ref(), &context.account_id, email.clone())?;

    let outcome = match &context.mode {
        LoginMode::Connect => {
            if let Some(project) = lookup_key_project(
                context.app.as_ref(),
                &stored.api_key,
                &oauth.access_token,
            )
            .await?
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
                resolve_project_by_id(context.app.as_ref(), project_id, &oauth.access_token).await?;
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
        save_project_selection(app.as_ref(), account_id, &project, oauth, email)?;
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
    validate_monitoring_access_with_retry(
        app.as_ref(),
        &project.project_id,
        &oauth.access_token,
    )
    .await?;
    save_project_selection(app.as_ref(), account_id, &project, oauth, email)?;
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

fn save_project_selection(
    app: &AppState,
    account_id: &str,
    project: &CloudProjectOption,
    oauth: OAuthSecret,
    email: Option<String>,
) -> Result<(), String> {
    let mut stored = load_google_ai_studio_secret(account_id)?;
    stored.cloud_project_id = Some(project.project_id.clone());
    stored.cloud_oauth = Some(oauth);
    save_provider_secret(account_id, &ProviderSecret::GoogleAiStudio(stored))
        .map_err(|error| error.to_string())?;
    app.store
        .mutate(account_id, |account| {
            account.provider = Provider::GoogleAiStudio;
            account.provider_account_id = Some(format!(
                "google-ai-studio-project:{}",
                project.project_id
            ));
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
        CallbackOutcome::Complete(account) => LoginStatus {
            attempt_id: attempt_id.into(),
            status: "complete".into(),
            message: None,
            account: Some(account),
            projects: None,
            selected_project_id: None,
        },
        CallbackOutcome::ChooseProject(projects) => LoginStatus {
            attempt_id: attempt_id.into(),
            status: "choose_project".into(),
            message: None,
            account: None,
            projects: Some(projects),
            selected_project_id: None,
        },
        CallbackOutcome::MonitoringDisabled(project) => LoginStatus {
            attempt_id: attempt_id.into(),
            status: "monitoring_disabled".into(),
            message: None,
            account: None,
            selected_project_id: Some(project.project_id.clone()),
            projects: Some(vec![project]),
        },
    };
    let mut pending = app.pending_login.write();
    if !pending
        .as_ref()
        .is_some_and(|login| login.attempt_id == attempt_id && login.status == "waiting")
    {
        return Err("The Google authorization was cancelled.".into());
    }
    *pending = Some(status);
    Ok(())
}

async fn lookup_key_project(
    app: &AppState,
    api_key: &str,
    access_token: &str,
) -> Result<Option<CloudProjectOption>, String> {
    let response = app
        .client
        .get("https://apikeys.googleapis.com/v2/keys:lookupKey")
        .bearer_auth(access_token)
        .query(&[("keyString", api_key)])
        .send()
        .await
        .map_err(|error| format!("Google API-key project lookup failed: {error}"))?;
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if status == StatusCode::UNAUTHORIZED {
        return Err("Google authorization expired before the API-key project could be found.".into());
    }
    if status == StatusCode::FORBIDDEN
        || status == StatusCode::NOT_FOUND
        || status == StatusCode::BAD_REQUEST
    {
        return Ok(None);
    }
    if !status.is_success() {
        return Err(format!(
            "Google API-key project lookup returned HTTP {}.",
            status.as_u16()
        ));
    }
    let lookup: LookupKeyResponse = serde_json::from_str(&body)
        .map_err(|error| format!("Google returned an invalid API-key lookup response: {error}"))?;
    let Some(parent) = lookup.parent.filter(|value| !value.trim().is_empty()) else {
        return Ok(None);
    };
    resolve_project_resource(app, &parent, access_token)
        .await
        .map(Some)
}

async fn list_projects(
    app: &AppState,
    access_token: &str,
) -> Result<Vec<CloudProjectOption>, String> {
    let mut page_token: Option<String> = None;
    let mut projects = Vec::new();
    loop {
        let mut request = app
            .client
            .get("https://cloudresourcemanager.googleapis.com/v3/projects:search")
            .bearer_auth(access_token)
            .query(&[("pageSize", "1000")]);
        if let Some(token) = page_token.as_deref() {
            request = request.query(&[("pageToken", token)]);
        }
        let response = request
            .send()
            .await
            .map_err(|error| format!("Google Cloud project search failed: {error}"))?;
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN {
            return Err("Google did not allow this account to list Cloud projects.".into());
        }
        if !status.is_success() {
            return Err(format!(
                "Google Cloud project search returned HTTP {}.",
                status.as_u16()
            ));
        }
        let page: ProjectSearchResponse = serde_json::from_str(&body)
            .map_err(|error| format!("Google returned an invalid project list: {error}"))?;
        projects.extend(page.projects.into_iter().filter_map(project_option));
        page_token = page
            .next_page_token
            .filter(|value| !value.trim().is_empty());
        if page_token.is_none() {
            break;
        }
    }
    projects.sort_by(|left, right| {
        left.display_name
            .to_ascii_lowercase()
            .cmp(&right.display_name.to_ascii_lowercase())
            .then_with(|| left.project_id.cmp(&right.project_id))
    });
    projects.dedup_by(|left, right| left.project_id == right.project_id);
    Ok(projects)
}

async fn resolve_project_by_id(
    app: &AppState,
    project_id: &str,
    access_token: &str,
) -> Result<CloudProjectOption, String> {
    resolve_project_resource(app, &format!("projects/{project_id}"), access_token).await
}

async fn resolve_project_resource(
    app: &AppState,
    resource: &str,
    access_token: &str,
) -> Result<CloudProjectOption, String> {
    let response = app
        .client
        .get(format!(
            "https://cloudresourcemanager.googleapis.com/v3/{resource}"
        ))
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|error| format!("Google Cloud project lookup failed: {error}"))?;
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if status == StatusCode::NOT_FOUND {
        return Err("Google Cloud could not find that project.".into());
    }
    if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN {
        return Err("The signed-in Google account cannot view that Cloud project.".into());
    }
    if !status.is_success() {
        return Err(format!(
            "Google Cloud project lookup returned HTTP {}.",
            status.as_u16()
        ));
    }
    let project: ProjectResponse = serde_json::from_str(&body)
        .map_err(|error| format!("Google returned invalid project information: {error}"))?;
    project_option(project).ok_or_else(|| "The selected Google Cloud project is not active.".into())
}

fn project_option(project: ProjectResponse) -> Option<CloudProjectOption> {
    if project
        .state
        .as_deref()
        .is_some_and(|state| state != "ACTIVE")
    {
        return None;
    }
    let project_number = project.name.strip_prefix("projects/")?.trim().to_string();
    if project_number.is_empty() || project.project_id.trim().is_empty() {
        return None;
    }
    let display_name = project
        .display_name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(project.project_id.as_str())
        .to_string();
    Some(CloudProjectOption {
        project_id: project.project_id,
        project_number,
        display_name,
    })
}

async fn monitoring_enabled(
    app: &AppState,
    project: &CloudProjectOption,
    access_token: &str,
) -> Result<bool, String> {
    let response = app
        .client
        .get(format!(
            "https://serviceusage.googleapis.com/v1/projects/{}/services/{MONITORING_SERVICE}",
            project.project_number
        ))
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|error| format!("Unable to check Cloud Monitoring: {error}"))?;
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if status == StatusCode::UNAUTHORIZED {
        return Err("Google authorization expired while checking Cloud Monitoring.".into());
    }
    if status == StatusCode::FORBIDDEN {
        return Err("The signed-in account cannot inspect services for this project. Ask a project owner for Service Usage Viewer access.".into());
    }
    if !status.is_success() {
        return Err(format!(
            "Cloud Monitoring status returned HTTP {}.",
            status.as_u16()
        ));
    }
    let service: ServiceResponse = serde_json::from_str(&body)
        .map_err(|error| format!("Google returned an invalid service status: {error}"))?;
    Ok(service.state.as_deref() == Some("ENABLED"))
}

async fn enable_monitoring(
    app: &AppState,
    project: &CloudProjectOption,
    access_token: &str,
) -> Result<(), String> {
    let response = app
        .client
        .post(format!(
            "https://serviceusage.googleapis.com/v1/projects/{}/services/{MONITORING_SERVICE}:enable",
            project.project_number
        ))
        .bearer_auth(access_token)
        .json(&json!({}))
        .send()
        .await
        .map_err(|error| format!("Unable to enable Cloud Monitoring: {error}"))?;
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN {
        return Err("Google did not allow this account to enable Cloud Monitoring. A project owner or Service Usage Admin must enable it.".into());
    }
    if !status.is_success() {
        return Err(format!(
            "Enabling Cloud Monitoring returned HTTP {}.",
            status.as_u16()
        ));
    }
    let operation: OperationResponse = serde_json::from_str(&body)
        .map_err(|error| format!("Google returned an invalid enable operation: {error}"))?;
    if operation.done == Some(true) {
        if operation.error.is_some() {
            return Err("Google could not enable Cloud Monitoring for this project.".into());
        }
        return Ok(());
    }
    let Some(name) = operation.name.filter(|value| !value.trim().is_empty()) else {
        return Ok(());
    };
    poll_operation(app, &name, access_token).await
}

async fn poll_operation(app: &AppState, name: &str, access_token: &str) -> Result<(), String> {
    for _ in 0..30 {
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        let response = app
            .client
            .get(format!("https://serviceusage.googleapis.com/v1/{name}"))
            .bearer_auth(access_token)
            .send()
            .await
            .map_err(|error| format!("Unable to check Cloud Monitoring enablement: {error}"))?;
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        if !status.is_success() {
            return Err(format!(
                "Cloud Monitoring enablement check returned HTTP {}.",
                status.as_u16()
            ));
        }
        let operation: OperationResponse = serde_json::from_str(&body)
            .map_err(|error| format!("Google returned an invalid operation status: {error}"))?;
        if operation.done == Some(true) {
            return if operation.error.is_some() {
                Err("Google could not enable Cloud Monitoring for this project.".into())
            } else {
                Ok(())
            };
        }
    }
    Err("Cloud Monitoring is still being enabled. Wait a minute and connect usage again.".into())
}

fn validate_google_ai_studio_account(app: &AppState, account_id: &str) -> Result<(), String> {
    app.store
        .get(account_id)
        .ok_or_else(|| "Google AI Studio account not found.".to_string())?;
    let secret = load_provider_secret(account_id).map_err(|error| error.to_string())?;
    if !matches!(secret, ProviderSecret::GoogleAiStudio(_)) {
        return Err("This account is not a Google AI Studio API-key connection.".into());
    }
    Ok(())
}

fn load_google_ai_studio_secret(
    account_id: &str,
) -> Result<crate::model::GoogleAiStudioSecret, String> {
    match load_provider_secret(account_id).map_err(|error| error.to_string())? {
        ProviderSecret::GoogleAiStudio(secret) => Ok(secret),
        _ => Err("This account is not a Google AI Studio connection.".into()),
    }
}

async fn exchange_tokens(context: &LoginContext, code: &str) -> Result<TokenResponse, String> {
    let client_secret = String::from_utf8_lossy(GOOGLE_CLIENT_SECRET_BYTES).to_string();
    let response = context
        .app
        .client
        .post("https://oauth2.googleapis.com/token")
        .form(&[
            ("client_id", GOOGLE_CLIENT_ID),
            ("client_secret", client_secret.as_str()),
            ("code", code),
            ("redirect_uri", context.redirect_uri.as_str()),
            ("grant_type", "authorization_code"),
        ])
        .send()
        .await
        .map_err(|error| format!("Google token exchange failed: {error}"))?;
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("Google token exchange failed ({status})."));
    }
    serde_json::from_str(&body).map_err(|error| format!("Invalid Google token response: {error}"))
}

async fn ensure_fresh_oauth(app: &AppState, oauth: OAuthSecret) -> Result<OAuthSecret, String> {
    if !oauth.expires_within(300) {
        return Ok(oauth);
    }
    let client_secret = String::from_utf8_lossy(GOOGLE_CLIENT_SECRET_BYTES).to_string();
    let response = app
        .client
        .post("https://oauth2.googleapis.com/token")
        .form(&[
            ("client_id", GOOGLE_CLIENT_ID),
            ("client_secret", client_secret.as_str()),
            ("refresh_token", oauth.refresh_token.as_str()),
            ("grant_type", "refresh_token"),
        ])
        .send()
        .await
        .map_err(|error| format!("Google token refresh failed: {error}"))?;
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err("Google authorization expired. Sign in again.".into());
    }
    let tokens: TokenResponse = serde_json::from_str(&body)
        .map_err(|error| format!("Invalid Google token refresh response: {error}"))?;
    Ok(OAuthSecret {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token.unwrap_or(oauth.refresh_token),
        id_token: tokens.id_token.or(oauth.id_token),
        expires_at: Utc::now().timestamp_millis() + tokens.expires_in.unwrap_or(3600) * 1000,
    })
}

async fn fetch_email(app: &AppState, access_token: &str) -> Result<String, String> {
    let response = app
        .client
        .get("https://www.googleapis.com/oauth2/v2/userinfo")
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|error| format!("Google user-info request failed: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "Google user-info request returned {}.",
            response.status()
        ));
    }
    let value: Value = response
        .json()
        .await
        .map_err(|error| format!("Invalid Google user-info response: {error}"))?;
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
) -> Result<String, String> {
    let mut url = Url::parse("https://accounts.google.com/o/oauth2/auth")
        .map_err(|error| error.to_string())?;
    url.query_pairs_mut()
        .append_pair("client_id", GOOGLE_CLIENT_ID)
        .append_pair("redirect_uri", redirect_uri)
        .append_pair("response_type", "code")
        .append_pair("scope", scopes)
        .append_pair("state", state)
        .append_pair("access_type", "offline")
        .append_pair("prompt", "consent");
    Ok(url.to_string())
}

async fn bind_callback_port() -> Result<(TcpListener, u16), String> {
    for port in 11461..=11465 {
        match TcpListener::bind(("127.0.0.1", port)).await {
            Ok(listener) => return Ok((listener, port)),
            Err(error) if error.kind() == std::io::ErrorKind::AddrInUse => continue,
            Err(error) => return Err(format!("Unable to start OAuth callback server: {error}")),
        }
    }
    Err("No callback port is available for Google AI Studio usage authorization.".into())
}

fn validate_project_id(value: &str) -> Result<String, String> {
    let value = value.trim();
    let valid_length = (6..=63).contains(&value.len());
    let valid_edges = value.as_bytes().first().is_some_and(u8::is_ascii_lowercase)
        && value
            .as_bytes()
            .last()
            .is_some_and(|value| value.is_ascii_lowercase() || value.is_ascii_digit());
    let valid_characters = value
        .bytes()
        .all(|value| value.is_ascii_lowercase() || value.is_ascii_digit() || value == b'-');
    if !valid_length || !valid_edges || !valid_characters {
        return Err("Google returned an invalid Cloud project ID.".into());
    }
    Ok(value.to_string())
}

fn random_base64(bytes: usize) -> String {
    let mut value = vec![0_u8; bytes];
    rand::thread_rng().fill_bytes(&mut value);
    URL_SAFE_NO_PAD.encode(value)
}

fn set_login_status(app: &AppState, status: LoginStatus) {
    *app.pending_login.write() = Some(status);
}

fn is_waiting(app: &AppState, attempt_id: &str) -> bool {
    app.pending_login
        .read()
        .as_ref()
        .is_some_and(|login| login.attempt_id == attempt_id && login.status == "waiting")
}

fn fail_login(context: &LoginContext, message: String) {
    if is_waiting(context.app.as_ref(), &context.attempt_id) {
        set_login_status(
  context.app.as_ref(),
  LoginStatus {
      attempt_id: context.attempt_id.clone(),
      status: "failed".into(),
      message: Some(message),
      account: None,
      projects: None,
      selected_project_id: None,
  },
        );
    }
}

async fn stop_callback(context: &LoginContext) {
    context.app.stop_login_shutdown(&context.attempt_id);
}

fn escape_html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
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
    fn authorize_url_omits_granted_scopes() {
        let url = build_authorization_url(
            "http://127.0.0.1:11461",
            "state",
            "openid email https://www.googleapis.com/auth/cloud-platform.read-only",
        )
        .unwrap();
        let parsed = Url::parse(&url).unwrap();
        assert!(!parsed
            .query_pairs()
            .any(|(key, _)| key == "include_granted_scopes"));
    }

    #[test]
    fn login_status_serializes_project_choices_for_the_frontend() {
        let status = LoginStatus {
            attempt_id: "attempt".into(),
            status: "monitoring_disabled".into(),
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
}

use crate::{
    model::{LoginStart, LoginStatus, OAuthSecret, Provider, ProviderSecret},
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
use serde::Deserialize;
use serde_json::Value;
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

#[derive(Clone)]
struct LoginContext {
    app: Arc<AppState>,
    attempt_id: String,
    account_id: String,
    project_id: String,
    expected_state: String,
    redirect_uri: String,
    shutdown: Arc<tokio::sync::Mutex<Option<oneshot::Sender<()>>>>,
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

pub async fn start_login(
    app: Arc<AppState>,
    account_id: String,
    project_id: String,
) -> Result<LoginStart, String> {
    let project_id = validate_project_id(&project_id)?;
    let account = app
        .store
        .get(&account_id)
        .ok_or_else(|| "Google AI Studio account not found.".to_string())?;
    let secret = load_provider_secret(&account_id).map_err(|error| error.to_string())?;
    if !matches!(secret, ProviderSecret::GoogleAiStudio(_)) {
        return Err("This account is not a Google AI Studio API-key connection.".into());
    }
    if app
        .pending_login
        .read()
        .as_ref()
        .is_some_and(|login| login.status == "waiting")
    {
        return Err("Another provider login is already in progress.".into());
    }

    let (listener, port) = bind_callback_port().await?;
    let expected_state = random_base64(24);
    let attempt_id = Uuid::new_v4().to_string();
    let redirect_uri = format!("http://127.0.0.1:{port}");
    let authorization_url = build_authorization_url(&redirect_uri, &expected_state)?;
    let expires_at = (Utc::now() + Duration::minutes(LOGIN_TIMEOUT_MINUTES)).to_rfc3339();

    *app.pending_login.write() = Some(LoginStatus {
        attempt_id: attempt_id.clone(),
        status: "waiting".into(),
        message: Some(format!(
            "Authorize read-only Google Cloud Monitoring access for project {project_id}."
        )),
        account: None,
    });

    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let context = Arc::new(LoginContext {
        app: app.clone(),
        attempt_id: attempt_id.clone(),
        account_id,
        project_id,
        expected_state,
        redirect_uri,
        shutdown: Arc::new(tokio::sync::Mutex::new(Some(shutdown_tx))),
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
                "Google Cloud usage authorization timed out. Start it again.".into(),
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
        Ok(account) => Html(format!(
            r#"<!doctype html><html><body style="background:#101412;color:#f4f6f8;font-family:system-ui;padding:50px;text-align:center"><h1>Google Cloud usage connected</h1><p>{}</p><p style="color:#8e9791">You can close this tab and return to AI Subscription Tracker.</p></body></html>"#,
            escape_html(account.email.as_deref().unwrap_or(&account.label))
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
) -> Result<crate::model::Account, String> {
    if let Some(error) = query.error {
        return Err(query.error_description.unwrap_or(error));
    }
    let code = query
        .code
        .ok_or_else(|| "Google did not return an authorization code.".to_string())?;
    if query.state.as_deref() != Some(context.expected_state.as_str()) {
        return Err("OAuth state validation failed.".into());
    }

    let mut stored =
        match load_provider_secret(&context.account_id).map_err(|error| error.to_string())? {
            ProviderSecret::GoogleAiStudio(secret) => secret,
            _ => return Err("This account is not a Google AI Studio connection.".into()),
        };
    let tokens = exchange_tokens(&context, &code).await?;
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

    google_ai_studio::validate_cloud_project_access(
        context.app.as_ref(),
        &context.project_id,
        &oauth.access_token,
    )
    .await
    .map_err(|error| error.to_string())?;
    let email = fetch_email(context.app.as_ref(), &oauth.access_token)
        .await
        .ok();

    stored.cloud_project_id = Some(context.project_id.clone());
    stored.cloud_oauth = Some(oauth);
    save_provider_secret(&context.account_id, &ProviderSecret::GoogleAiStudio(stored))
        .map_err(|error| error.to_string())?;
    context
        .app
        .store
        .mutate(&context.account_id, |account| {
            account.provider = Provider::GoogleAiStudio;
            account.provider_account_id =
                Some(format!("google-ai-studio-project:{}", context.project_id));
            account.plan = Some("Google AI Studio".into());
            if email.is_some() {
                account.email = email.clone();
            }
            account.last_error = None;
            account.auth_required = false;
        })
        .map_err(|error| error.to_string())?;

    let account = usage::refresh_account(context.app.clone(), &context.account_id).await?;
    *context.app.pending_login.write() = Some(LoginStatus {
        attempt_id: context.attempt_id.clone(),
        status: "complete".into(),
        message: None,
        account: Some(account.clone()),
    });
    Ok(account)
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

fn build_authorization_url(redirect_uri: &str, state: &str) -> Result<String, String> {
    let mut url = Url::parse("https://accounts.google.com/o/oauth2/auth")
        .map_err(|error| error.to_string())?;
    url.query_pairs_mut()
        .append_pair("client_id", GOOGLE_CLIENT_ID)
        .append_pair("redirect_uri", redirect_uri)
        .append_pair("response_type", "code")
        .append_pair(
            "scope",
            "openid email profile https://www.googleapis.com/auth/monitoring.read",
        )
        .append_pair("state", state)
        .append_pair("access_type", "offline")
        .append_pair("prompt", "consent")
        .append_pair("include_granted_scopes", "true");
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
        return Err(
            "Enter a valid Google Cloud project ID, not its display name or project number.".into(),
        );
    }
    Ok(value.to_string())
}

fn random_base64(bytes: usize) -> String {
    let mut value = vec![0u8; bytes];
    rand::thread_rng().fill_bytes(&mut value);
    URL_SAFE_NO_PAD.encode(value)
}

fn fail_login(context: &LoginContext, message: String) {
    *context.app.pending_login.write() = Some(LoginStatus {
        attempt_id: context.attempt_id.clone(),
        status: "failed".into(),
        message: Some(message),
        account: None,
    });
}

async fn stop_callback(context: &LoginContext) {
    if let Some(sender) = context.shutdown.lock().await.take() {
        let _ = sender.send(());
    }
}

fn escape_html(input: &str) -> String {
    input
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
        assert!(validate_project_id("1234567890").is_err());
        assert!(validate_project_id("project/").is_err());
    }

    #[test]
    fn uses_a_dedicated_loopback_callback_range() {
        let url = build_authorization_url("http://127.0.0.1:11461", "state").unwrap();
        assert!(url.contains("11461"));
        assert!(url.contains("monitoring.read"));
    }
}

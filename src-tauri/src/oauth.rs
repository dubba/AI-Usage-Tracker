use crate::{
    model::{
        now_rfc3339, Account, LoginStart, LoginStatus, OAuthSecret, Provider, ProviderSecret,
    },
    state::AppState,
    store::save_provider_secret,
};
use axum::{
    extract::{Query, State},
    response::Html,
    routing::get,
    Router,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use chrono::{Duration, Utc};
use parking_lot::RwLock;
use rand::RngCore;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::sync::Arc;
use tokio::{net::TcpListener, sync::oneshot};
use url::Url;
use uuid::Uuid;

const OPENAI_ISSUER: &str = "https://auth.openai.com";
const OPENAI_CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
const OPENAI_ORIGINATOR: &str = "ai_usage_tracker";
const ANTHROPIC_CLIENT_ID: &str = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
/// Profile identity plus subscription usage. Intentionally omits API-key creation,
/// Claude Code sessions, MCP servers, and file upload.
const ANTHROPIC_SCOPES: &str = "user:profile user:inference";
const ANTIGRAVITY_CLIENT_ID: &str =
    "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
const ANTIGRAVITY_CLIENT_SECRET_BYTES: &[u8] = &[
    71, 79, 67, 83, 80, 88, 45, 75, 53, 56, 70, 87, 82, 52, 56, 54, 76, 100, 76, 74, 49, 109, 76,
    66, 56, 115, 88, 67, 52, 122, 54, 113, 68, 65, 102,
];
const LOGIN_TIMEOUT_MINUTES: i64 = 5;

#[derive(Clone)]
struct LoginContext {
    app: Arc<AppState>,
    attempt_id: String,
    label: String,
    provider: Provider,
    verifier: String,
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
struct OpenAiTokenResponse {
    access_token: String,
    refresh_token: Option<String>,
    id_token: Option<String>,
    expires_in: i64,
}

#[derive(Debug, Deserialize)]
struct OAuthTokenResponse {
    access_token: String,
    refresh_token: Option<String>,
    id_token: Option<String>,
    expires_in: Option<i64>,
}

#[derive(Clone, Debug, Default)]
struct ProviderIdentity {
    email: Option<String>,
    account_id: Option<String>,
    plan: Option<String>,
}

pub async fn start_login(
    app: Arc<AppState>,
    label: String,
    provider: Provider,
) -> Result<LoginStart, String> {
    if matches!(provider, Provider::OpencodeGo | Provider::Grok) {
        return Err(format!(
            "{} uses its dedicated login flow instead of browser OAuth.",
            provider.display_name()
        ));
    }
    let attempt_id = Uuid::new_v4().to_string();
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
            message: None,
            account: None,
            projects: None,
            selected_project_id: None,
        });
    }

    let (listener, port) = match bind_callback_port(&provider).await {
        Ok(bound) => bound,
        Err(error) => {
            let mut pending = app.pending_login.write();
            if pending.as_ref().is_some_and(|login| login.attempt_id == attempt_id) {
                *pending = None;
            }
            return Err(error);
        }
    };
    let verifier = random_base64(32);
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let expected_state = random_base64(24);
    let redirect_uri = redirect_uri(&provider, port);
    let authorization_url =
        match build_authorization_url(&provider, &redirect_uri, &challenge, &expected_state) {
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
        label,
        provider,
        verifier,
        expected_state,
        redirect_uri,
    });
    let router = Router::new()
        .route("/", get(callback))
        .route("/callback", get(callback))
        .route("/auth/callback", get(callback))
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
                &server_context.app.pending_login,
                &server_context.attempt_id,
                format!("Callback server failed: {error}"),
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
                &timeout_context.app.pending_login,
                &timeout_context.attempt_id,
                format!(
                    "{} login timed out. Start the login again.",
                    timeout_context.provider.display_name()
                ),
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

pub fn login_status(app: &AppState, attempt_id: &str) -> Result<LoginStatus, String> {
    let pending = app.pending_login.read();
    let status = pending
        .as_ref()
        .ok_or_else(|| "No login attempt is available.".to_string())?;
    if status.attempt_id != attempt_id {
        return Err("The login attempt is no longer active.".into());
    }
    Ok(status.clone())
}

fn is_waiting(app: &AppState, attempt_id: &str) -> bool {
    app.pending_login
        .read()
        .as_ref()
        .is_some_and(|login| login.attempt_id == attempt_id && login.status == "waiting")
}

async fn callback(
    State(context): State<Arc<LoginContext>>,
    Query(query): Query<CallbackQuery>,
) -> Html<String> {
    let result = complete_callback(context.clone(), query).await;
    if let Err(error) = &result {
        fail_login(
            &context.app.pending_login,
            &context.attempt_id,
            error.clone(),
        );
    }
    stop_callback(&context).await;
    match result {
        Ok(account) => Html(format!(
            r#"<!doctype html><html><body style="background:#101412;color:#f4f6f8;font-family:system-ui;padding:50px;text-align:center"><h1>Account connected</h1><p>{}</p><p style="color:#8e9791">You can close this tab and return to AI Usage Tracker.</p></body></html>"#,
            escape_html(account.email.as_deref().unwrap_or(&account.label))
        )),
        Err(error) => Html(format!(
            r#"<!doctype html><html><body style="background:#101412;color:#f4f6f8;font-family:system-ui;padding:50px;text-align:center"><h1>Authentication failed</h1><p style="color:#ff9d9d">{}</p><p style="color:#8e9791">Return to the app and try again.</p></body></html>"#,
            escape_html(&error)
        )),
    }
}

async fn complete_callback(
    context: Arc<LoginContext>,
    query: CallbackQuery,
) -> Result<Account, String> {
    if let Some(error) = query.error {
        return Err(query.error_description.unwrap_or(error));
    }
    let code = query.code.ok_or_else(|| {
        format!(
            "{} did not return an authorization code.",
            context.provider.display_name()
        )
    })?;
    if query.state.as_deref() != Some(context.expected_state.as_str()) {
        return Err("OAuth state validation failed.".into());
    }
    if !is_waiting(context.app.as_ref(), &context.attempt_id) {
        return Err("The login attempt was cancelled.".into());
    }

    let (secret, identity) = exchange_tokens(&context, &code).await?;
    if !is_waiting(context.app.as_ref(), &context.attempt_id) {
        return Err("The login attempt was cancelled.".into());
    }
    let duplicate = context.app.store.find_duplicate(
        &context.provider,
        identity.account_id.as_deref(),
        identity.email.as_deref(),
    );
    let now = now_rfc3339();
    let label = if context.label.trim().is_empty() {
        identity
            .email
            .clone()
            .unwrap_or_else(|| context.provider.display_name().to_string())
    } else {
        context.label.trim().to_string()
    };
    let provider_account_id = identity.account_id.clone().or_else(|| {
        duplicate
            .as_ref()
            .and_then(|account| account.provider_account_id.clone())
    });
    let chatgpt_account_id = if context.provider == Provider::Openai {
        provider_account_id.clone().or_else(|| {
            duplicate
                .as_ref()
                .and_then(|account| account.chatgpt_account_id.clone())
        })
    } else {
        None
    };
    let account = Account {
        id: duplicate
            .as_ref()
            .map(|account| account.id.clone())
            .unwrap_or_else(|| Uuid::new_v4().to_string()),
        label,
        provider: context.provider.clone(),
        email: identity
            .email
            .or_else(|| duplicate.as_ref().and_then(|account| account.email.clone())),
        provider_account_id,
        chatgpt_account_id,
        plan: identity
            .plan
            .or_else(|| duplicate.as_ref().and_then(|account| account.plan.clone())),
        created_at: duplicate
            .as_ref()
            .map(|account| account.created_at.clone())
            .unwrap_or_else(|| now.clone()),
        updated_at: now,
        last_usage: duplicate
            .as_ref()
            .and_then(|account| account.last_usage.clone()),
        last_error: None,
        auth_required: false,
    };
    let mut pending = context.app.pending_login.write();
    if !pending
        .as_ref()
        .is_some_and(|login| login.attempt_id == context.attempt_id && login.status == "waiting")
    {
        return Err("The login attempt was cancelled.".into());
    }
    save_provider_secret(&account.id, &secret).map_err(|error| error.to_string())?;
    let account = context
        .app
        .store
        .upsert(account)
        .map_err(|error| error.to_string())?;
    *pending = Some(LoginStatus {
        attempt_id: context.attempt_id.clone(),
        status: "complete".into(),
        message: None,
        account: Some(account.clone()),
        projects: None,
        selected_project_id: None,
    });
    Ok(account)
}

async fn exchange_tokens(
    context: &LoginContext,
    code: &str,
) -> Result<(ProviderSecret, ProviderIdentity), String> {
    match context.provider {
        Provider::Openai => exchange_openai(context, code).await,
        Provider::Anthropic => exchange_anthropic(context, code).await,
        Provider::Antigravity => exchange_antigravity(context, code).await,
        Provider::GoogleAiStudio => {
            Err("Google AI Studio usage uses its dedicated Google Cloud authorization flow.".into())
        }
        Provider::Grok => Err("Grok uses the official Grok Build CLI login flow.".into()),
        Provider::OpencodeGo => Err("OpenCode Go does not use OAuth.".into()),
    }
}

async fn exchange_openai(
    context: &LoginContext,
    code: &str,
) -> Result<(ProviderSecret, ProviderIdentity), String> {
    let response = context
        .app
        .client
        .post(format!("{OPENAI_ISSUER}/oauth/token"))
        .form(&[
            ("grant_type", "authorization_code"),
            ("client_id", OPENAI_CLIENT_ID),
            ("code", code),
            ("code_verifier", context.verifier.as_str()),
            ("redirect_uri", context.redirect_uri.as_str()),
        ])
        .send()
        .await
        .map_err(|error| format!("OpenAI token exchange failed: {error}"))?;
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("OpenAI token exchange failed ({status})."));
    }
    let tokens: OpenAiTokenResponse = serde_json::from_str(&body)
        .map_err(|error| format!("Invalid OpenAI token response: {error}"))?;
    let refresh_token = tokens
        .refresh_token
        .clone()
        .ok_or_else(|| "OpenAI did not return a refresh token.".to_string())?;
    let userinfo = fetch_json(
        &context.app,
        &format!("{OPENAI_ISSUER}/userinfo"),
        &tokens.access_token,
    )
    .await
    .unwrap_or(Value::Null);
    let identity = identity_from_userinfo(&userinfo);
    Ok((
        ProviderSecret::Openai(OAuthSecret {
            access_token: tokens.access_token,
            refresh_token,
            id_token: tokens.id_token,
            expires_at: Utc::now().timestamp_millis() + tokens.expires_in * 1000,
        }),
        identity,
    ))
}

async fn exchange_anthropic(
    context: &LoginContext,
    code: &str,
) -> Result<(ProviderSecret, ProviderIdentity), String> {
    let response = context
        .app
        .client
        .post("https://platform.claude.com/v1/oauth/token")
        .json(&json!({
            "grant_type": "authorization_code",
            "client_id": ANTHROPIC_CLIENT_ID,
            "code": code,
            "state": context.expected_state.clone(),
            "redirect_uri": context.redirect_uri.clone(),
            "code_verifier": context.verifier.clone(),
        }))
        .send()
        .await
        .map_err(|error| format!("Anthropic token exchange failed: {error}"))?;
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("Anthropic token exchange failed ({status})."));
    }
    let tokens: OAuthTokenResponse = serde_json::from_str(&body)
        .map_err(|error| format!("Invalid Anthropic token response: {error}"))?;
    let refresh_token = tokens
        .refresh_token
        .clone()
        .ok_or_else(|| "Anthropic did not return a refresh token.".to_string())?;
    let profile = fetch_json_with_headers(
        &context.app,
        "https://api.anthropic.com/api/auth/oauth/profile",
        &tokens.access_token,
        &[("anthropic-beta", "oauth-2025-04-20")],
    )
    .await
    .unwrap_or(Value::Null);
    let identity = ProviderIdentity {
        email: find_string(&profile, &["email", "email_address"]),
        account_id: find_string(&profile, &["account_id", "uuid"]),
        plan: find_string(
            &profile,
            &[
                "subscription_type",
                "subscription_tier",
                "rate_limit_tier",
                "plan",
            ],
        )
        .or_else(|| Some("Claude subscription".into())),
    };
    Ok((
        ProviderSecret::Anthropic(OAuthSecret {
            access_token: tokens.access_token,
            refresh_token,
            id_token: tokens.id_token,
            expires_at: Utc::now().timestamp_millis() + tokens.expires_in.unwrap_or(3600) * 1000,
        }),
        identity,
    ))
}

async fn exchange_antigravity(
    context: &LoginContext,
    code: &str,
) -> Result<(ProviderSecret, ProviderIdentity), String> {
    let client_secret = String::from_utf8_lossy(ANTIGRAVITY_CLIENT_SECRET_BYTES).to_string();
    let response = context
        .app
        .client
        .post("https://oauth2.googleapis.com/token")
        .form(&[
            ("client_id", ANTIGRAVITY_CLIENT_ID),
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
    let tokens: OAuthTokenResponse = serde_json::from_str(&body)
        .map_err(|error| format!("Invalid Google token response: {error}"))?;
    let refresh_token = tokens.refresh_token.clone().ok_or_else(|| {
        "Google did not return a refresh token. Revoke access and try again.".to_string()
    })?;
    let profile = fetch_json(
        &context.app,
        "https://www.googleapis.com/oauth2/v2/userinfo",
        &tokens.access_token,
    )
    .await
    .unwrap_or(Value::Null);
    let identity = ProviderIdentity {
        email: profile
            .get("email")
            .and_then(Value::as_str)
            .map(str::to_string),
        account_id: profile
            .get("id")
            .and_then(Value::as_str)
            .map(str::to_string),
        plan: Some("Antigravity".into()),
    };
    Ok((
        ProviderSecret::Antigravity(OAuthSecret {
            access_token: tokens.access_token,
            refresh_token,
            id_token: tokens.id_token,
            expires_at: Utc::now().timestamp_millis() + tokens.expires_in.unwrap_or(3600) * 1000,
        }),
        identity,
    ))
}

fn build_authorization_url(
    provider: &Provider,
    redirect_uri: &str,
    challenge: &str,
    state: &str,
) -> Result<String, String> {
    match provider {
        Provider::Openai => {
            let mut url = Url::parse(&format!("{OPENAI_ISSUER}/oauth/authorize"))
                .map_err(|error| error.to_string())?;
            url.query_pairs_mut()
                .append_pair("client_id", OPENAI_CLIENT_ID)
                .append_pair("redirect_uri", redirect_uri)
                .append_pair("response_type", "code")
                .append_pair("scope", "openid profile email offline_access")
                .append_pair("code_challenge", challenge)
                .append_pair("code_challenge_method", "S256")
                .append_pair("state", state)
                .append_pair("audience", "https://api.openai.com/v1")
                .append_pair("id_token_add_organizations", "true")
                .append_pair("originator", OPENAI_ORIGINATOR);
            Ok(url.to_string())
        }
        Provider::Anthropic => {
            let mut url = Url::parse("https://claude.ai/oauth/authorize")
                .map_err(|error| error.to_string())?;
            url.query_pairs_mut()
                .append_pair("code", "true")
                .append_pair("client_id", ANTHROPIC_CLIENT_ID)
                .append_pair("response_type", "code")
                .append_pair("redirect_uri", redirect_uri)
                .append_pair("scope", ANTHROPIC_SCOPES)
                .append_pair("code_challenge", challenge)
                .append_pair("code_challenge_method", "S256")
                .append_pair("state", state);
            Ok(url.to_string())
        }
        Provider::Antigravity => {
            let mut url = Url::parse("https://accounts.google.com/o/oauth2/auth")
                .map_err(|error| error.to_string())?;
            url.query_pairs_mut()
                .append_pair("client_id", ANTIGRAVITY_CLIENT_ID)
                .append_pair("redirect_uri", redirect_uri)
                .append_pair("response_type", "code")
                .append_pair(
                    "scope",
                    "openid https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/cclog https://www.googleapis.com/auth/experimentsandconfigs",
                )
                .append_pair("state", state)
                .append_pair("access_type", "offline")
                .append_pair("prompt", "consent");
            Ok(url.to_string())
        }
        Provider::GoogleAiStudio => {
            Err("Google AI Studio usage uses its dedicated Google Cloud authorization flow.".into())
        }
        Provider::Grok => Err("Grok uses the official Grok Build CLI login flow.".into()),
        Provider::OpencodeGo => Err("OpenCode Go does not use OAuth.".into()),
    }
}

fn redirect_uri(provider: &Provider, port: u16) -> String {
    match provider {
        Provider::Openai => format!("http://127.0.0.1:{port}/auth/callback"),
        Provider::Anthropic => format!("http://127.0.0.1:{port}/callback"),
        Provider::Antigravity => format!("http://127.0.0.1:{port}"),
        Provider::GoogleAiStudio | Provider::Grok | Provider::OpencodeGo => String::new(),
    }
}

async fn bind_callback_port(provider: &Provider) -> Result<(TcpListener, u16), String> {
    let ports: Vec<u16> = match provider {
        Provider::Openai => (1455..=1459).collect(),
        Provider::Anthropic => (53692..=53696).collect(),
        Provider::Antigravity => (11451..=11455).collect(),
        Provider::GoogleAiStudio | Provider::Grok | Provider::OpencodeGo => Vec::new(),
    };
    for port in ports {
        match TcpListener::bind(("127.0.0.1", port)).await {
            Ok(listener) => return Ok((listener, port)),
            Err(error) if error.kind() == std::io::ErrorKind::AddrInUse => continue,
            Err(error) => return Err(format!("Unable to start OAuth callback server: {error}")),
        }
    }
    Err(format!(
        "No callback port is available for {}.",
        provider.display_name()
    ))
}

async fn fetch_json(app: &AppState, url: &str, access_token: &str) -> Result<Value, String> {
    fetch_json_with_headers(app, url, access_token, &[]).await
}

async fn fetch_json_with_headers(
    app: &AppState,
    url: &str,
    access_token: &str,
    headers: &[(&str, &str)],
) -> Result<Value, String> {
    let mut request = app.client.get(url).bearer_auth(access_token);
    for (name, value) in headers {
        request = request.header(*name, *value);
    }
    let response = request
        .send()
        .await
        .map_err(|error| format!("Profile request failed: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("Profile request returned {}.", response.status()));
    }
    response
        .json()
        .await
        .map_err(|error| format!("Invalid profile response: {error}"))
}

fn random_base64(bytes: usize) -> String {
    let mut value = vec![0u8; bytes];
    rand::thread_rng().fill_bytes(&mut value);
    URL_SAFE_NO_PAD.encode(value)
}

fn identity_from_userinfo(value: &Value) -> ProviderIdentity {
    ProviderIdentity {
        email: find_string(value, &["email", "email_address"]),
        account_id: find_string(value, &["chatgpt_account_id", "account_id", "sub"]),
        plan: find_string(value, &["chatgpt_plan_type", "plan_type", "plan"]),
    }
}

#[cfg(test)]
use crate::model::TokenClaims;

#[cfg(test)]
pub fn decode_claims(token: &str) -> Option<TokenClaims> {
    let segment = token.split('.').nth(1)?;
    let decoded = URL_SAFE_NO_PAD.decode(segment).ok()?;
    let value: Value = serde_json::from_slice(&decoded).ok()?;
    let auth = value.get("https://api.openai.com/auth");
    let email =
        string_at(&value, "email").or_else(|| auth.and_then(|value| string_at(value, "email")));
    let account_id = auth
        .and_then(|value| string_at(value, "chatgpt_account_id"))
        .or_else(|| string_at(&value, "chatgpt_account_id"));
    let plan = auth
        .and_then(|value| string_at(value, "chatgpt_plan_type"))
        .or_else(|| string_at(&value, "chatgpt_plan_type"));
    let expires_at = value
        .get("exp")
        .and_then(Value::as_i64)
        .map(|seconds| seconds * 1000);
    Some(TokenClaims {
        email,
        account_id,
        plan,
        expires_at,
    })
}

fn find_string(value: &Value, keys: &[&str]) -> Option<String> {
    match value {
        Value::Object(object) => {
            for key in keys {
                if let Some(value) = object.get(*key).and_then(Value::as_str) {
                    if !value.trim().is_empty() {
                        return Some(value.to_string());
                    }
                }
            }
            object.values().find_map(|value| find_string(value, keys))
        }
        Value::Array(values) => values.iter().find_map(|value| find_string(value, keys)),
        _ => None,
    }
}

#[cfg(test)]
fn string_at(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_string)
}

fn fail_login(store: &RwLock<Option<LoginStatus>>, attempt_id: &str, message: String) {
    let mut pending = store.write();
    if pending
        .as_ref()
        .is_some_and(|login| login.attempt_id == attempt_id && login.status == "waiting")
    {
        *pending = Some(LoginStatus {
  attempt_id: attempt_id.into(),
  status: "failed".into(),
  message: Some(message),
  account: None,
  projects: None,
  selected_project_id: None,
        });
    }
}

async fn stop_callback(context: &LoginContext) {
    context.app.stop_login_shutdown(&context.attempt_id);
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
    fn extracts_openai_claims() {
        let payload = serde_json::json!({
            "email": "person@example.com",
            "exp": 2000000000,
            "https://api.openai.com/auth": {
                "chatgpt_account_id": "acct_123",
                "chatgpt_plan_type": "plus"
            }
        });
        let token = format!("x.{}.y", URL_SAFE_NO_PAD.encode(payload.to_string()));
        let claims = decode_claims(&token).unwrap();
        assert_eq!(claims.email.as_deref(), Some("person@example.com"));
        assert_eq!(claims.account_id.as_deref(), Some("acct_123"));
        assert_eq!(claims.plan.as_deref(), Some("plus"));
        assert_eq!(claims.expires_at, Some(2_000_000_000_000));
    }

    #[test]
    fn openai_identity_comes_from_userinfo() {
        let userinfo = serde_json::json!({
            "email": "person@example.com",
            "https://api.openai.com/auth": {
                "chatgpt_account_id": "acct_123",
                "chatgpt_plan_type": "plus"
            }
        });
        let identity = identity_from_userinfo(&userinfo);
        assert_eq!(identity.email.as_deref(), Some("person@example.com"));
        assert_eq!(identity.account_id.as_deref(), Some("acct_123"));
        assert_eq!(identity.plan.as_deref(), Some("plus"));
    }

    #[test]
    fn oauth_redirects_use_loopback_ipv4() {
        assert_eq!(
            redirect_uri(&Provider::Openai, 1455),
            "http://127.0.0.1:1455/auth/callback"
        );
        assert_eq!(
            redirect_uri(&Provider::Anthropic, 53692),
            "http://127.0.0.1:53692/callback"
        );
        assert_eq!(
            redirect_uri(&Provider::Antigravity, 11451),
            "http://127.0.0.1:11451"
        );
    }

    #[test]
    fn anthropic_authorize_url_omits_unused_scopes() {
        let url = build_authorization_url(
            &Provider::Anthropic,
            "http://127.0.0.1:53692/callback",
            "challenge",
            "state",
        )
        .unwrap();
        let parsed = Url::parse(&url).unwrap();
        let scopes = parsed
            .query_pairs()
            .find(|(key, _)| key == "scope")
            .map(|(_, value)| value.into_owned())
            .unwrap();
        assert_eq!(scopes, ANTHROPIC_SCOPES);
        for unused in [
            "org:create_api_key",
            "user:sessions:claude_code",
            "user:mcp_servers",
            "user:file_upload",
        ] {
            assert!(!scopes.split_whitespace().any(|scope| scope == unused));
        }
    }

    #[test]
    fn antigravity_authorize_url_omits_granted_scopes() {
        let url = build_authorization_url(
            &Provider::Antigravity,
            "http://127.0.0.1:11451",
            "challenge",
            "state",
        )
        .unwrap();
        let parsed = Url::parse(&url).unwrap();
        let pairs: Vec<(String, String)> = parsed
            .query_pairs()
            .map(|(key, value)| (key.into_owned(), value.into_owned()))
            .collect();
        assert!(!pairs
            .iter()
            .any(|(key, _)| key == "include_granted_scopes"));
    }

    #[test]
    fn openai_authorize_url_identifies_this_app() {
        let url = build_authorization_url(
            &Provider::Openai,
            "http://127.0.0.1:1455/auth/callback",
            "challenge",
            "state",
        )
        .unwrap();
        let parsed = Url::parse(&url).unwrap();
        let pairs: Vec<(String, String)> = parsed
            .query_pairs()
            .map(|(key, value)| (key.into_owned(), value.into_owned()))
            .collect();
        assert!(pairs.iter().any(|(key, value)| key == "originator" && value == OPENAI_ORIGINATOR));
        assert!(!pairs.iter().any(|(_, value)| value.contains("codex_cli")));
        assert!(!pairs.iter().any(|(key, _)| key == "codex_cli_simplified_flow"));
    }

    #[tokio::test]
    async fn rejects_start_login_when_another_login_in_progress() {
        let temp = tempfile::tempdir().unwrap();
        let app = Arc::new(AppState::new(temp.path().to_path_buf(), "test-token".into()).unwrap());

        for status in ["waiting", "choose_project", "monitoring_disabled"] {
            *app.pending_login.write() = Some(LoginStatus {
                attempt_id: "active-attempt".into(),
                status: status.into(),
                message: None,
                account: None,
                projects: None,
                selected_project_id: None,
            });

            let result = start_login(app.clone(), "Test".into(), Provider::Openai).await;
            assert!(result.is_err());
            assert_eq!(
                result.unwrap_err(),
                "Another provider login is already in progress."
            );
        }
    }
}

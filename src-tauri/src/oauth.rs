use crate::{
    model::{
        now_rfc3339, Account, LoginStart, LoginStatus, OAuthSecret, Provider, ProviderSecret,
    },
    state::AppState,
};
use axum::{
    extract::{Query, State},
    http::{HeaderMap, HeaderValue},
    response::{Html, IntoResponse},
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
/// Codex CLI Hydra allow-list: 1455 preferred, 1457 fallback.
const OPENAI_CALLBACK_PORTS: &[u16] = &[1455, 1457];
const ANTHROPIC_CLIENT_ID: &str = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
/// Profile identity plus subscription usage. Intentionally omits API-key creation,
/// Claude Code sessions, MCP servers, and file upload.
const ANTHROPIC_SCOPES: &str = "user:profile user:inference";
/// Identity plus Cloud access for quota APIs.
const ANTIGRAVITY_SCOPES: &str = "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/cloud-platform";
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
pub(crate) struct CallbackQuery {
    pub code: Option<String>,
    pub state: Option<String>,
    pub error: Option<String>,
    pub error_description: Option<String>,
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

    #[cfg(mobile)]
    {
        if let Err(error) = open_mobile_oauth(&app, context.clone(), &authorization_url) {
            fail_login(&app.pending_login, &attempt_id, error.clone());
            stop_callback(&context).await;
            return Err(error);
        }
        return Ok(LoginStart {
            attempt_id,
            authorization_url: String::new(),
            expires_at,
        });
    }

    #[cfg(desktop)]
    {
        Ok(LoginStart {
            attempt_id,
            authorization_url,
            expires_at,
        })
    }
}

#[cfg(mobile)]
fn open_mobile_oauth(
    app: &Arc<AppState>,
    context: Arc<LoginContext>,
    authorization_url: &str,
) -> Result<(), String> {
    let handle = app
        .app_handle
        .read()
        .clone()
        .ok_or_else(|| "The app is not ready for in-app sign-in.".to_string())?;
    let target = Url::parse(authorization_url).map_err(|error| error.to_string())?;
    let intercept_started = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    crate::mobile_auth::open_in_main_webview(
        handle,
        app.clone(),
        context.attempt_id.clone(),
        target,
        move |url| {
            if !looks_like_oauth_callback(&url) {
                return;
            }
            if intercept_started.swap(true, std::sync::atomic::Ordering::SeqCst) {
                return;
            }
            let context = context.clone();
            tauri::async_runtime::spawn(async move {
                let _ = handle_callback(context, callback_query_from_url(&url)).await;
            });
        },
    )
}

fn is_transient_network_error(err: &str) -> bool {
    let lower = err.to_lowercase();
    lower.contains("dns error")
        || lower.contains("connect")
        || lower.contains("no address associated")
        || lower.contains("connection refused")
        || lower.contains("network is unreachable")
        || lower.contains("timed out")
        || lower.contains("timeout")
}

pub async fn login_status(app: &Arc<AppState>, attempt_id: &str) -> Result<LoginStatus, String> {
    let pending_exchange = {
        let mut guard = app.pending_auth_exchange.lock();
        if guard.as_ref().is_some_and(|p| p.attempt_id == attempt_id) {
            guard.take()
        } else {
            None
        }
    };

    if let Some(exchange) = pending_exchange {
        if is_waiting(app.as_ref(), attempt_id) {
            let context = LoginContext {
                app: app.clone(),
                attempt_id: exchange.attempt_id.clone(),
                label: exchange.label.clone(),
                provider: exchange.provider.clone(),
                verifier: exchange.verifier.clone(),
                expected_state: exchange.expected_state.clone(),
                redirect_uri: exchange.redirect_uri.clone(),
            };
            match complete_exchange(&context, &exchange.code).await {
                Ok(account) => {
                    return Ok(LoginStatus {
                        attempt_id: attempt_id.into(),
                        status: "complete".into(),
                        message: None,
                        account: Some(account),
                        projects: None,
                        selected_project_id: None,
                    });
                }
                Err(error) => {
                    if is_transient_network_error(&error) {
                        // Keep exchange queued for when foreground connectivity is restored
                        *app.pending_auth_exchange.lock() = Some(exchange);
                    } else {
                        fail_login(&app.pending_login, attempt_id, error.clone());
                        return Ok(LoginStatus {
                            attempt_id: attempt_id.into(),
                            status: "failed".into(),
                            message: Some(error),
                            account: None,
                            projects: None,
                            selected_project_id: None,
                        });
                    }
                }
            }
        }
    }

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

#[cfg_attr(not(any(test, mobile)), allow(dead_code))]
pub(crate) fn looks_like_oauth_callback(url: &Url) -> bool {
    matches!(url.host_str(), Some("127.0.0.1") | Some("localhost"))
        && url
            .query_pairs()
            .any(|(key, _)| key == "code" || key == "error")
}

#[cfg_attr(not(any(test, mobile)), allow(dead_code))]
pub(crate) fn callback_query_from_url(url: &Url) -> CallbackQuery {
    let mut query = CallbackQuery {
        code: None,
        state: None,
        error: None,
        error_description: None,
    };
    for (key, value) in url.query_pairs() {
        match key.as_ref() {
            "code" => query.code = Some(value.into_owned()),
            "state" => query.state = Some(value.into_owned()),
            "error" => query.error = Some(value.into_owned()),
            "error_description" => query.error_description = Some(value.into_owned()),
            _ => {}
        }
    }
    query
}

async fn callback(
    State(context): State<Arc<LoginContext>>,
    Query(query): Query<CallbackQuery>,
) -> axum::response::Response {
    handle_callback(context, query).await.into_response()
}

async fn handle_callback(context: Arc<LoginContext>, query: CallbackQuery) -> axum::response::Response {
    if let Some(error) = query.error {
        let message = query.error_description.unwrap_or(error);
        fail_login(
            &context.app.pending_login,
            &context.attempt_id,
            message.clone(),
        );
        stop_callback(&context).await;
        return callback_html(format!(
            r#"<!doctype html><html><body style="background:#101412;color:#f4f6f8;font-family:system-ui;padding:50px;text-align:center"><h1>Authentication failed</h1><p style="color:#ff9d9d">{}</p><p style="color:#8e9791">Return to the app and try again.</p></body></html>"#,
            escape_html(&message)
        ));
    }
    let code = match query.code {
        Some(code) => code,
        None => {
            let message = format!(
                "{} did not return an authorization code.",
                context.provider.display_name()
            );
            fail_login(
                &context.app.pending_login,
                &context.attempt_id,
                message.clone(),
            );
            stop_callback(&context).await;
            return callback_html(format!(
                r#"<!doctype html><html><body style="background:#101412;color:#f4f6f8;font-family:system-ui;padding:50px;text-align:center"><h1>Authentication failed</h1><p style="color:#ff9d9d">{}</p><p style="color:#8e9791">Return to the app and try again.</p></body></html>"#,
                escape_html(&message)
            ));
        }
    };
    if query.state.as_deref() != Some(context.expected_state.as_str()) {
        let message = "OAuth state validation failed.".to_string();
        fail_login(
            &context.app.pending_login,
            &context.attempt_id,
            message.clone(),
        );
        stop_callback(&context).await;
        return callback_html(format!(
            r#"<!doctype html><html><body style="background:#101412;color:#f4f6f8;font-family:system-ui;padding:50px;text-align:center"><h1>Authentication failed</h1><p style="color:#ff9d9d">{}</p><p style="color:#8e9791">Return to the app and try again.</p></body></html>"#,
            escape_html(&message)
        ));
    }
    if !is_waiting(context.app.as_ref(), &context.attempt_id) {
        stop_callback(&context).await;
        return callback_html(
            r#"<!doctype html><html><body style="background:#101412;color:#f4f6f8;font-family:system-ui;padding:50px;text-align:center"><h1>Login cancelled</h1></body></html>"#
                .into(),
        );
    }

    match complete_exchange(&context, &code).await {
        Ok(account) => {
            stop_callback(&context).await;
            callback_html(format!(
                r#"<!doctype html><html><body style="background:#101412;color:#f4f6f8;font-family:system-ui;padding:50px;text-align:center"><h1>Account connected</h1><p>{}</p><p style="color:#8e9791">You can close this tab and return to AI Usage Tracker.</p></body></html>"#,
                escape_html(account.email.as_deref().unwrap_or(&account.label))
            ))
        }
        Err(_) => {
            {
                let mut pending = context.app.pending_auth_exchange.lock();
                *pending = Some(crate::state::PendingAuthExchange {
                    attempt_id: context.attempt_id.clone(),
                    provider: context.provider.clone(),
                    label: context.label.clone(),
                    code,
                    verifier: context.verifier.clone(),
                    expected_state: context.expected_state.clone(),
                    redirect_uri: context.redirect_uri.clone(),
                });
            }
            stop_callback(&context).await;
            callback_html(
                r#"<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="background:#101412;color:#f4f6f8;font-family:system-ui;padding:50px 20px;text-align:center"><h1 style="color:#4ade80">Authorization received</h1><p style="color:#d1d5db;font-size:16px;margin:16px 0">Return to AI Usage Tracker to complete connection.</p></body></html>"#
                    .into(),
            )
        }
    }
}

async fn complete_exchange(
    context: &LoginContext,
    code: &str,
) -> Result<Account, String> {
    let mut last_error = String::new();
    let mut exchanged = None;
    for attempt in 0..5 {
        if !is_waiting(context.app.as_ref(), &context.attempt_id) {
            return Err("The login attempt was cancelled.".into());
        }
        match exchange_tokens(context, code).await {
            Ok(res) => {
                exchanged = Some(res);
                break;
            }
            Err(err) => {
                last_error = err;
                if attempt < 4 {
                    tokio::time::sleep(std::time::Duration::from_millis(600)).await;
                }
            }
        }
    }
    let (secret, identity) = match exchanged {
        Some(res) => res,
        None => return Err(last_error),
    };
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
    if !is_waiting(context.app.as_ref(), &context.attempt_id) {
        return Err("The login attempt was cancelled.".into());
    }
    let account = context
        .app
        .persist_connected_account(account, &secret)
        .await
        .map_err(|error| error.to_string())?;
    let mut pending = context.app.pending_login.write();
    if pending
        .as_ref()
        .is_some_and(|login| login.attempt_id == context.attempt_id)
    {
        *pending = Some(LoginStatus {
            attempt_id: context.attempt_id.clone(),
            status: "complete".into(),
            message: None,
            account: Some(account.clone()),
            projects: None,
            selected_project_id: None,
        });
    }
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

fn format_reqwest_error(prefix: &str, error: &reqwest::Error) -> String {
    use std::error::Error;
    let mut message = format!("{prefix}: {error}");
    let mut current: Option<&(dyn Error + 'static)> = error.source();
    while let Some(source) = current {
        message.push_str(&format!(" -> {source}"));
        current = source.source();
    }
    message
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
        .map_err(|error| format_reqwest_error("OpenAI token exchange failed", &error))?;
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
        .map_err(|error| format_reqwest_error("Anthropic token exchange failed", &error))?;
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
            ("code_verifier", context.verifier.as_str()),
        ])
        .send()
        .await
        .map_err(|error| format_reqwest_error("Google token exchange failed", &error))?;
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
                .append_pair("response_type", "code")
                .append_pair("client_id", OPENAI_CLIENT_ID)
                .append_pair("redirect_uri", redirect_uri)
                .append_pair("scope", "openid profile email offline_access")
                .append_pair("code_challenge", challenge)
                .append_pair("code_challenge_method", "S256")
                .append_pair("id_token_add_organizations", "true")
                .append_pair("codex_cli_simplified_flow", "true")
                .append_pair("state", state)
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
                .append_pair("scope", ANTIGRAVITY_SCOPES)
                .append_pair("state", state)
                .append_pair("code_challenge", challenge)
                .append_pair("code_challenge_method", "S256")
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
        // OpenAI's Codex client allow-list is `http://localhost:<port>/auth/callback`
        // on 1455/1457. `127.0.0.1` is not an exact match and OpenAI returns a generic
        // Authentication Error page before the callback.
        Provider::Openai => format!("http://localhost:{port}/auth/callback"),
        // Claude Code advertises `http://localhost:<port>/callback`. Anthropic
        // matches that string; `127.0.0.1` is not an exact match.
        Provider::Anthropic => format!("http://localhost:{port}/callback"),
        Provider::Antigravity => format!("http://127.0.0.1:{port}"),
        Provider::GoogleAiStudio | Provider::Grok | Provider::OpencodeGo => String::new(),
    }
}

async fn bind_callback_port(provider: &Provider) -> Result<(TcpListener, u16), String> {
    if matches!(provider, Provider::Antigravity) {
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .await
            .map_err(|error| format!("Unable to start OAuth callback server: {error}"))?;
        let port = listener
            .local_addr()
            .map_err(|error| format!("Unable to read OAuth callback port: {error}"))?
            .port();
        return Ok((listener, port));
    }
    let ports: Vec<u16> = match provider {
        Provider::Openai => OPENAI_CALLBACK_PORTS.to_vec(),
        Provider::Anthropic => (53692..=53696).collect(),
        Provider::Antigravity => Vec::new(),
        Provider::GoogleAiStudio | Provider::Grok | Provider::OpencodeGo => Vec::new(),
    };
    for port in ports {
        match TcpListener::bind(("127.0.0.1", port)).await {
            Ok(listener) => return Ok((listener, port)),
            Err(error) if error.kind() == std::io::ErrorKind::AddrInUse => continue,
            Err(error) => return Err(format!("Unable to start OAuth callback server: {error}")),
        }
    }
    Err(if matches!(provider, Provider::Openai) {
        "GPT/Codex login needs localhost port 1455 (or 1457). Close another Codex login and try again.".into()
    } else {
        format!("No callback port is available for {}.", provider.display_name())
    })
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

fn callback_html(body: String) -> axum::response::Response {
    let mut headers = HeaderMap::new();
    headers.insert(
        axum::http::header::CACHE_CONTROL,
        HeaderValue::from_static("no-store, no-cache, must-revalidate"),
    );
    headers.insert(
        axum::http::header::PRAGMA,
        HeaderValue::from_static("no-cache"),
    );
    headers.insert(
        axum::http::header::HeaderName::from_static("content-security-policy"),
        HeaderValue::from_static(
            "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
        ),
    );
    headers.insert(
        axum::http::header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        axum::http::header::HeaderName::from_static("referrer-policy"),
        HeaderValue::from_static("no-referrer"),
    );
    (headers, Html(body)).into_response()
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
            "http://localhost:1455/auth/callback"
        );
        assert_eq!(
            redirect_uri(&Provider::Openai, 1457),
            "http://localhost:1457/auth/callback"
        );
        assert_eq!(
            redirect_uri(&Provider::Anthropic, 53692),
            "http://localhost:53692/callback"
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
            "http://localhost:53692/callback",
            "challenge",
            "state",
        )
        .unwrap();
        let parsed = Url::parse(&url).unwrap();
        let pairs: Vec<(String, String)> = parsed
            .query_pairs()
            .map(|(key, value)| (key.into_owned(), value.into_owned()))
            .collect();
        assert_eq!(
            pairs.iter().find(|(key, _)| key == "client_id").map(|(_, value)| value.as_str()),
            Some(ANTHROPIC_CLIENT_ID)
        );
        assert_eq!(
            pairs.iter().find(|(key, _)| key == "redirect_uri").map(|(_, value)| value.as_str()),
            Some("http://localhost:53692/callback")
        );
        assert!(pairs.iter().any(|(key, value)| key == "code" && value == "true"));
        assert_eq!(
            pairs.iter().find(|(key, _)| key == "response_type").map(|(_, value)| value.as_str()),
            Some("code")
        );
        assert_eq!(
            pairs.iter().find(|(key, _)| key == "code_challenge_method").map(|(_, value)| value.as_str()),
            Some("S256")
        );
        let scopes = pairs
            .iter()
            .find(|(key, _)| key == "scope")
            .map(|(_, value)| value.as_str())
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
    fn antigravity_authorize_url_uses_cloud_platform_scope() {
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
        let scopes = pairs
            .iter()
            .find(|(key, _)| key == "scope")
            .map(|(_, value)| value.as_str())
            .unwrap();
        assert_eq!(scopes, ANTIGRAVITY_SCOPES);
        assert!(!pairs
            .iter()
            .any(|(key, _)| key == "include_granted_scopes"));
        for unused in [
            "https://www.googleapis.com/auth/cclog",
            "https://www.googleapis.com/auth/experimentsandconfigs",
        ] {
            assert!(!scopes.split_whitespace().any(|scope| scope == unused));
        }
        assert!(scopes
            .split_whitespace()
            .any(|scope| scope == "https://www.googleapis.com/auth/cloud-platform"));
    }

    #[test]
    fn detects_loopback_oauth_callback_urls() {
        assert!(looks_like_oauth_callback(
            &Url::parse("http://127.0.0.1:11451/?code=abc&state=xyz").unwrap()
        ));
        assert!(looks_like_oauth_callback(
            &Url::parse("http://127.0.0.1:1455/auth/callback?error=access_denied").unwrap()
        ));
        assert!(looks_like_oauth_callback(
            &Url::parse("http://localhost:1455/auth/callback?code=abc&state=xyz").unwrap()
        ));
        assert!(looks_like_oauth_callback(
            &Url::parse("http://localhost:53692/callback?code=abc&state=xyz").unwrap()
        ));
        assert!(!looks_like_oauth_callback(
            &Url::parse("https://accounts.google.com/o/oauth2/auth?code=abc").unwrap()
        ));
        assert!(!looks_like_oauth_callback(
            &Url::parse("http://127.0.0.1:11451/").unwrap()
        ));
        let query = callback_query_from_url(
            &Url::parse("http://127.0.0.1:11451/?code=abc&state=xyz").unwrap(),
        );
        assert_eq!(query.code.as_deref(), Some("abc"));
        assert_eq!(query.state.as_deref(), Some("xyz"));
    }

    #[test]
    fn openai_authorize_url_identifies_this_app() {
        let url = build_authorization_url(
            &Provider::Openai,
            "http://localhost:1455/auth/callback",
            "challenge",
            "state",
        )
        .unwrap();
        let parsed = Url::parse(&url).unwrap();
        let pairs: Vec<(String, String)> = parsed
            .query_pairs()
            .map(|(key, value)| (key.into_owned(), value.into_owned()))
            .collect();
        assert_eq!(
            pairs.iter().find(|(key, _)| key == "response_type").map(|(_, value)| value.as_str()),
            Some("code")
        );
        assert_eq!(
            pairs.iter().find(|(key, _)| key == "client_id").map(|(_, value)| value.as_str()),
            Some(OPENAI_CLIENT_ID)
        );
        assert_eq!(
            pairs.iter().find(|(key, _)| key == "redirect_uri").map(|(_, value)| value.as_str()),
            Some("http://localhost:1455/auth/callback")
        );
        assert_eq!(
            pairs.iter().find(|(key, _)| key == "scope").map(|(_, value)| value.as_str()),
            Some("openid profile email offline_access")
        );
        assert_eq!(
            pairs.iter().find(|(key, _)| key == "code_challenge_method").map(|(_, value)| value.as_str()),
            Some("S256")
        );
        assert!(pairs.iter().any(|(key, value)| key == "id_token_add_organizations" && value == "true"));
        assert!(pairs.iter().any(|(key, value)| key == "codex_cli_simplified_flow" && value == "true"));
        assert!(pairs.iter().any(|(key, value)| key == "originator" && value == OPENAI_ORIGINATOR));
        assert!(!pairs.iter().any(|(key, _)| key == "audience"));
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

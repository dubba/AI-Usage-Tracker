#[cfg(desktop)]
use crate::auth::login_window::{self, LoginWindowSpec, LOGIN_USER_AGENT};
use crate::{
    auth::google_client::{client_secret, CLIENT_ID, TOKEN_URL as GOOGLE_TOKEN_URL},
    auth::login_window::{is_back_request, BACK_QUERY_FLAG},
    auth::oauth_common::{
        account_connected_html, auth_failure_html, callback_html, merge_into_existing,
        pkce_challenge, random_base64, spawn_callback_server, spawn_login_timeout, CallbackQuery,
        ConnectedFields, OAUTH_LOGIN_TIMEOUT_MINUTES,
    },
    model::{Account, LoginStart, LoginState, LoginStatus, OAuthSecret, Provider, ProviderSecret},
    providers::{
        anthropic::{CLIENT_ID as ANTHROPIC_CLIENT_ID, TOKEN_URL as ANTHROPIC_TOKEN_URL},
        oauth_refresh::{Lifetime, RefreshBody, TokenResponse},
        openai::{CLIENT_ID as OPENAI_CLIENT_ID, TOKEN_URL as OPENAI_TOKEN_URL},
    },
    state::AppState,
};
use axum::{
    extract::{Query, State},
    response::IntoResponse,
    routing::get,
    Router,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use chrono::{Duration, Utc};
use serde_json::{json, Value};
#[cfg(desktop)]
use std::sync::atomic::{AtomicBool, Ordering};
use std::{
    net::{IpAddr, SocketAddr},
    sync::Arc,
};
#[cfg(desktop)]
use tauri::{
    webview::{NewWindowResponse, PageLoadEvent},
    Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};
use tokio::{net::TcpListener, sync::oneshot};
use url::Url;
use uuid::Uuid;

const OPENAI_ISSUER: &str = "https://auth.openai.com";
const OPENAI_ORIGINATOR: &str = "ai_usage_tracker";
/// Codex CLI Hydra allow-list: 1455 preferred, 1457 fallback.
const OPENAI_CALLBACK_PORTS: &[u16] = &[1455, 1457];
/// Profile identity plus subscription usage. Intentionally omits API-key creation,
/// Claude Code sessions, MCP servers, and file upload.
const ANTHROPIC_SCOPES: &str = "user:profile user:inference";
/// Identity plus Cloud access for quota APIs.
const ANTIGRAVITY_SCOPES: &str = "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/cloud-platform";

#[derive(Clone)]
struct LoginContext {
    app: Arc<AppState>,
    attempt_id: String,
    label: String,
    reconnect_account_id: Option<String>,
    provider: Provider,
    verifier: String,
    expected_state: String,
    redirect_uri: String,
    /// The callback can arrive twice (the loopback server and the mobile WebView URL poll both
    /// see it), and an authorization code works once.
    callback_claimed: Arc<std::sync::atomic::AtomicBool>,
}

pub async fn start_login(
    app: Arc<AppState>,
    label: String,
    provider: Provider,
    email: Option<String>,
    reconnect_account_id: Option<String>,
) -> Result<LoginStart, String> {
    if matches!(provider, Provider::OpencodeGo | Provider::Grok) {
        return Err(format!(
            "{} uses its dedicated login flow instead of browser OAuth.",
            provider.display_name()
        ));
    }

    let attempt_id = Uuid::new_v4().to_string();
    app.begin_login(&attempt_id, None)?;

    let (listener, addr) = match bind_callback_port(&provider).await {
        Ok(bound) => bound,
        Err(error) => {
            app.clear_pending_login(&attempt_id);
            return Err(error);
        }
    };
    let verifier = random_base64(32);
    let challenge = pkce_challenge(&verifier);
    let expected_state = random_base64(24);
    let redirect_uri = redirect_uri(&provider, addr);
    let authorization_url = match build_authorization_url(
        &provider,
        &redirect_uri,
        &challenge,
        &expected_state,
        email.as_deref(),
    ) {
        Ok(url) => url,
        Err(error) => {
            app.clear_pending_login(&attempt_id);
            return Err(error);
        }
    };
    let expires_at = (Utc::now() + Duration::minutes(OAUTH_LOGIN_TIMEOUT_MINUTES)).to_rfc3339();

    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    app.register_login_shutdown(attempt_id.clone(), shutdown_tx);
    let context = Arc::new(LoginContext {
        app: app.clone(),
        attempt_id: attempt_id.clone(),
        label,
        reconnect_account_id,
        provider,
        verifier,
        expected_state,
        redirect_uri,
        callback_claimed: Arc::new(std::sync::atomic::AtomicBool::new(false)),
    });
    let router = Router::new()
        .route("/", get(callback))
        .route("/callback", get(callback))
        .route("/auth/callback", get(callback))
        .with_state(context.clone());

    let server_context = context.clone();
    spawn_callback_server(
        app.clone(),
        attempt_id.clone(),
        listener,
        router,
        shutdown_rx,
        "Callback server failed",
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
        format!(
            "{} login timed out. Start the login again.",
            context.provider.display_name()
        ),
        move |message| {
            timeout_context
                .app
                .fail_login_if_waiting(&timeout_context.attempt_id, message)
        },
    );

    #[cfg(mobile)]
    {
        if let Err(error) = open_mobile_oauth(&app, context.clone(), &authorization_url) {
            app.fail_login_if_waiting(&attempt_id, error.clone());
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
        // The sign-in page opens in this app's window, not the system browser,
        // so the top-left Back button can sit on the provider page (the Google
        // account chooser included) and a fresh profile can ask for the account.
        if let Err(error) = open_provider_login_window(
            &app,
            &attempt_id,
            &authorization_url,
            &format!("Sign in to {}", context.provider.display_name()),
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
}

pub async fn login_status(app: &Arc<AppState>, attempt_id: &str) -> Result<LoginStatus, String> {
    let _poll_guard = app.login_status_lock.lock().await;
    let pending_exchange = {
        let mut guard = app.pending_auth_exchange.lock();
        if guard.as_ref().is_some_and(|p| p.attempt_id == attempt_id) {
            guard.take()
        } else {
            None
        }
    };

    if let Some(exchange) = pending_exchange {
        if app.login_is_waiting(attempt_id) {
            let context = LoginContext {
                app: app.clone(),
                attempt_id: exchange.attempt_id.clone(),
                label: exchange.label.clone(),
                reconnect_account_id: exchange.reconnect_account_id.clone(),
                provider: exchange.provider.clone(),
                verifier: exchange.verifier.clone(),
                expected_state: exchange.expected_state.clone(),
                redirect_uri: exchange.redirect_uri.clone(),
                callback_claimed: Arc::new(std::sync::atomic::AtomicBool::new(true)),
            };
            match complete_exchange(&context, &exchange.code).await {
                Ok(account) => {
                    return Ok(LoginStatus::complete(attempt_id, account));
                }
                Err(error) => {
                    // Authorization codes are single-use. Never restore or
                    // retry the same code on a later poll.
                    let error = error.into_message();
                    app.fail_login_if_waiting(attempt_id, error.clone());
                    app.abort_login_resources(attempt_id);
                    return Ok(LoginStatus {
                        attempt_id: attempt_id.into(),
                        status: LoginState::Failed,
                        message: Some(error),
                        account: None,
                        projects: None,
                        selected_project_id: None,
                    });
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

fn build_authorization_url(
    provider: &Provider,
    redirect_uri: &str,
    challenge: &str,
    state: &str,
    email: Option<&str>,
) -> Result<String, String> {
    // A second (or third) account must be addable while another session is
    // active, so every URL below nudges the provider toward its account
    // chooser instead of silently reusing the signed-in session. `login_hint`
    // is honored by all three endpoints and only pre-selects an address.
    let login_hint = email.map(str::trim).filter(|hint| !hint.is_empty());
    match provider {
        Provider::Openai => {
            let mut url = Url::parse(&format!("{OPENAI_ISSUER}/oauth/authorize"))
                .map_err(|error| error.to_string())?;
            {
                let mut pairs = url.query_pairs_mut();
                pairs
                    .append_pair("response_type", "code")
                    .append_pair("client_id", OPENAI_CLIENT_ID)
                    .append_pair("redirect_uri", redirect_uri)
                    .append_pair("scope", "openid profile email offline_access")
                    .append_pair("code_challenge", challenge)
                    .append_pair("code_challenge_method", "S256")
                    .append_pair("id_token_add_organizations", "true")
                    .append_pair("codex_cli_simplified_flow", "true")
                    .append_pair("state", state)
                    .append_pair("originator", OPENAI_ORIGINATOR)
                    // Auth0 shows the login page even when an SSO session
                    // exists, so a different address can be entered.
                    .append_pair("prompt", "login");
                if let Some(hint) = login_hint {
                    pairs.append_pair("login_hint", hint);
                }
            }
            Ok(url.to_string())
        }
        Provider::Anthropic => {
            let mut url = Url::parse("https://claude.ai/oauth/authorize")
                .map_err(|error| error.to_string())?;
            {
                let mut pairs = url.query_pairs_mut();
                pairs
                    .append_pair("code", "true")
                    .append_pair("client_id", ANTHROPIC_CLIENT_ID)
                    .append_pair("response_type", "code")
                    .append_pair("redirect_uri", redirect_uri)
                    .append_pair("scope", ANTHROPIC_SCOPES)
                    .append_pair("code_challenge", challenge)
                    .append_pair("code_challenge_method", "S256")
                    // Always show the sign-in page instead of jumping straight
                    // to consent with the active session, so a second account
                    // starts at the login screen. Safe per RFC 6749 section
                    // 3.1: an authorization server must ignore parameters it
                    // does not know, so this degrades to the old behavior if
                    // claude.ai does not honor it.
                    .append_pair("prompt", "login")
                    .append_pair("state", state);
                if let Some(hint) = login_hint {
                    pairs.append_pair("login_hint", hint);
                }
            }
            Ok(url.to_string())
        }
        Provider::Antigravity => {
            let mut url = Url::parse("https://accounts.google.com/o/oauth2/auth")
                .map_err(|error| error.to_string())?;
            {
                let mut pairs = url.query_pairs_mut();
                pairs
                    .append_pair("client_id", CLIENT_ID)
                    .append_pair("redirect_uri", redirect_uri)
                    .append_pair("response_type", "code")
                    .append_pair("scope", ANTIGRAVITY_SCOPES)
                    .append_pair("state", state)
                    .append_pair("code_challenge", challenge)
                    .append_pair("code_challenge_method", "S256")
                    .append_pair("access_type", "offline")
                    // `select_account` always shows Google's account chooser
                    // (combinable with `consent`, which keeps returning a
                    // refresh token for a second account).
                    .append_pair("prompt", "select_account consent");
                if let Some(hint) = login_hint {
                    pairs.append_pair("login_hint", hint);
                }
            }
            Ok(url.to_string())
        }
        Provider::GoogleAiStudio => {
            Err("Google AI Studio usage uses its dedicated Google Cloud authorization flow.".into())
        }
        Provider::Grok => Err("Grok uses the official Grok Build CLI login flow.".into()),
        Provider::OpencodeGo => Err("OpenCode Go does not use OAuth.".into()),
    }
}

fn redirect_uri(provider: &Provider, addr: SocketAddr) -> String {
    match provider {
        // OpenAI's Codex client allow-list is `http://localhost:<port>/auth/callback`
        // on 1455/1457. `127.0.0.1` is not an exact match and OpenAI returns a generic
        // Authentication Error page before the callback.
        Provider::Openai => format!("http://localhost:{}/auth/callback", addr.port()),
        // Claude Code advertises `http://localhost:<port>/callback`. Anthropic
        // matches that string; `127.0.0.1` is not an exact match.
        Provider::Anthropic => format!("http://localhost:{}/callback", addr.port()),
        Provider::Antigravity => loopback_http_origin(addr),
        Provider::GoogleAiStudio | Provider::Grok | Provider::OpencodeGo => String::new(),
    }
}

use crate::model::TokenClaims;

mod callback_server;
mod desktop_window;
mod exchange;
mod identity;
#[cfg(mobile)]
mod mobile;

pub(crate) use callback_server::*;
pub(crate) use desktop_window::*;
use exchange::*;
use identity::*;
#[cfg(mobile)]
use mobile::*;

#[cfg(test)]
mod tests;

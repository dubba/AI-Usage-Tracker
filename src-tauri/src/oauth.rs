use crate::{
    google_client::{client_secret, CLIENT_ID, TOKEN_URL as GOOGLE_TOKEN_URL},
    model::{
        now_rfc3339, Account, LoginStart, LoginState, LoginStatus, OAuthSecret, Provider,
        ProviderSecret,
    },
    oauth_common::{
        account_connected_html, auth_failure_html, callback_html, pkce_challenge, random_base64,
        spawn_callback_server, spawn_login_timeout, CallbackQuery, LOGIN_TIMEOUT_MINUTES,
    },
    providers::{
        anthropic::{CLIENT_ID as ANTHROPIC_CLIENT_ID, TOKEN_URL as ANTHROPIC_TOKEN_URL},
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
use serde::Deserialize;
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

#[derive(Deserialize)]
struct OAuthTokenResponse {
    access_token: String,
    refresh_token: Option<String>,
    id_token: Option<String>,
    expires_in: Option<i64>,
}

impl std::fmt::Debug for OAuthTokenResponse {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("OAuthTokenResponse")
            .field("expires_in", &self.expires_in)
            .finish_non_exhaustive()
    }
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
    {
        let mut pending = app.pending_login.write();
        if pending
            .as_ref()
            .is_some_and(|login| login.status.is_in_progress())
        {
            return Err("Another provider login is already in progress.".into());
        }
        *pending = Some(LoginStatus {
            attempt_id: attempt_id.clone(),
            status: LoginState::Waiting,
            message: None,
            account: None,
            projects: None,
            selected_project_id: None,
        });
    }

    let (listener, addr) = match bind_callback_port(&provider).await {
        Ok(bound) => bound,
        Err(error) => {
            let mut pending = app.pending_login.write();
            if pending
                .as_ref()
                .is_some_and(|login| login.attempt_id == attempt_id)
            {
                *pending = None;
            }
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
            let mut pending = app.pending_login.write();
            if pending
                .as_ref()
                .is_some_and(|login| login.attempt_id == attempt_id)
            {
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
        std::time::Duration::from_secs((LOGIN_TIMEOUT_MINUTES * 60) as u64),
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

const PROVIDER_LOGIN_WINDOW: &str = "provider-login";
/// Label prefix of the popups a sign-in page opens (see `open_provider_login_popup`).
const PROVIDER_LOGIN_POPUP_PREFIX: &str = "provider-login-popup-";
const PROVIDER_LOGIN_USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Safari/605.1.15";
pub(crate) const PROVIDER_LOGIN_PROFILE_PREFIX: &str = "ai-usage-oauth-";

/// Query flag the injected top-left Back button appends. `on_navigation`
/// blocks that load, cancels the attempt, and closes the window.
const BACK_QUERY_FLAG: &str = "ai-usage-tracker-back";

/// Top-left Back button for a provider page that has no browser chrome.
/// Built without `innerHTML` and reattached if removed: Antigravity loads
/// `accounts.google.com`, which rejects HTML assignment and drops nodes it
/// did not create. Claude and ChatGPT leave the button in place.
const LOGIN_BACK_BUTTON_SCRIPT: &str = r#"
(() => {
  try {
    if (window.top !== window || !document.documentElement) return;
    // A sign-in popup (Google's, opened by Claude) shares this window's WebView
    // configuration and so this script; it is closed by the app, not Back.
    if (window.opener) return;
    const id = '__ai_tracker_back';
    const install = () => {
      if (!document.documentElement || document.getElementById(id)) return;
      const button = document.createElement('button');
      button.id = id;
      button.type = 'button';
      button.textContent = '‹ Back';
      button.setAttribute('aria-label', 'Back to AI Usage Tracker');
      button.style.cssText = [
        'position:fixed', 'top:12px', 'left:12px', 'z-index:2147483647',
        'padding:8px 14px', 'border:0', 'border-radius:999px', 'background:#6d3bd7', 'color:#fff',
        'font:600 14px -apple-system,system-ui,sans-serif', 'box-shadow:0 2px 10px rgba(0,0,0,.4)',
        'cursor:pointer',
      ].join(';');
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        try {
          const url = new URL(window.location.href);
          url.searchParams.set('ai-usage-tracker-back', '1');
          window.location.href = url.toString();
        } catch (e) {}
      }, true);
      document.documentElement.appendChild(button);
    };
    install();
    if (window.__aiTrackerBackRoot !== document.documentElement) {
      window.__aiTrackerBackRoot = document.documentElement;
      new MutationObserver(install).observe(document.documentElement, { childList: true });
    }
  } catch (e) {}
})();
"#;

pub(crate) fn is_provider_login_back_request(url: &Url) -> bool {
    url.query_pairs()
        .any(|(key, value)| key == BACK_QUERY_FLAG && value == "1")
}

/// Query flag injected into popups when `window.close()` is called or when
/// credentials have been handed to the opener.
const POPUP_CLOSE_QUERY_FLAG: &str = "ai-usage-tracker-popup-close";

pub(crate) fn is_provider_login_popup_close_request(url: &Url) -> bool {
    url.query_pairs()
        .any(|(key, value)| key == POPUP_CLOSE_QUERY_FLAG && value == "1")
}

/// Script injected into sign-in popups. Google Identity Services calls
/// `window.close()` when the user finishes or cancels, but Tauri/wry does not
/// act on `window.close()`, so this intercepts it and navigates with a flag that
/// `on_navigation` uses to dismiss the popup window.
const POPUP_AUTO_CLOSE_SCRIPT: &str = r#"
(() => {
  try {
    const origClose = window.close;
    const triggerClose = () => {
      try {
        const u = new URL(window.location.href);
        u.searchParams.set('ai-usage-tracker-popup-close', '1');
        window.location.replace(u.toString());
      } catch (e) {
        try {
          window.location.replace('about:blank?ai-usage-tracker-popup-close=1');
        } catch (e2) {}
      }
    };
    const closeHandler = function () {
      try {
        if (origClose) origClose.call(window);
      } catch (e) {}
      setTimeout(triggerClose, 50);
    };
    try { window.close = closeHandler; } catch (e) {}
    try {
      Object.defineProperty(window, 'close', {
        value: closeHandler,
        writable: true,
        configurable: true,
      });
    } catch (e) {}
  } catch (e) {}
})();
"#;

/// The first page of a desktop sign-in window. Narrower than the pages a
/// sign-in may pass through afterwards.
pub(crate) fn is_allowed_provider_login_start(url: &Url) -> bool {
    if is_provider_login_back_request(url) || is_provider_login_popup_close_request(url) {
        return false;
    }
    if url.scheme() != "https" || url.port().is_some() || !url.username().is_empty() {
        return false;
    }
    let Some(host) = url.host_str() else {
        return false;
    };
    let host = host.to_ascii_lowercase();
    ["openai.com", "claude.ai", "anthropic.com", "google.com"]
        .iter()
        .any(|allowed| host == *allowed || host.ends_with(&format!(".{allowed}")))
}

/// Pages the desktop sign-in window may load after it opens: provider and
/// single-sign-on hosts, plus the loopback callback that finishes the login.
/// A Back request is never loaded.
pub(crate) fn is_allowed_provider_login_navigation(url: &Url) -> bool {
    if is_provider_login_back_request(url) || is_provider_login_popup_close_request(url) {
        return false;
    }
    if url.as_str() == "about:blank" {
        return true;
    }
    if looks_like_oauth_callback(url) && url.scheme() == "http" && url.username().is_empty() {
        return true;
    }
    if url.scheme() != "https" || url.port().is_some() || !url.username().is_empty() {
        return false;
    }
    url.host_str()
        .is_some_and(crate::signin_navigation::host_is_sign_in)
}

/// Opens `authorization_url` in a private window with a top-left Back button.
/// The loopback callback server is already listening; this window does not
/// receive the app's privileged IPC.
#[cfg(desktop)]
pub(crate) fn open_provider_login_window(
    app: &Arc<AppState>,
    attempt_id: &str,
    authorization_url: &str,
    title: &str,
) -> Result<(), String> {
    let target = Url::parse(authorization_url).map_err(|error| error.to_string())?;
    if !is_allowed_provider_login_start(&target) {
        return Err("Disallowed authorization URL host".into());
    }
    let handle = app
        .app_handle
        .read()
        .clone()
        .ok_or_else(|| "The app is not ready to open sign-in.".to_string())?;
    if let Some(window) = handle.get_webview_window(PROVIDER_LOGIN_WINDOW) {
        crate::mobile_auth::dismiss_login_window(&window);
    }
    crate::login_profile::sweep_stale_profiles(PROVIDER_LOGIN_PROFILE_PREFIX);
    let profile_dir = crate::login_profile::create_private_profile_dir(
        PROVIDER_LOGIN_PROFILE_PREFIX,
        attempt_id,
    )?;
    let callback_seen = Arc::new(AtomicBool::new(false));
    let close_scheduled = Arc::new(AtomicBool::new(false));
    let back_handle = handle.clone();
    let back_state = app.clone();
    let back_attempt = attempt_id.to_string();
    let nav_callback_seen = callback_seen.clone();
    let nav_popups_handle = handle.clone();
    let load_dir = profile_dir.clone();
    let popup_handle = handle.clone();
    let (width, height, position) =
        crate::oauth_common::window_geometry_centered_on(&handle, "main", 1.0, 0.96, 820.0, 620.0);
    let mut builder =
        WebviewWindowBuilder::new(&handle, PROVIDER_LOGIN_WINDOW, WebviewUrl::External(target))
            .title(title)
            .inner_size(width, height)
            .min_inner_size(820.0, 620.0)
            .resizable(true)
            .data_directory(profile_dir.clone())
            .incognito(true)
            .devtools(false)
            .initialization_script(LOGIN_BACK_BUTTON_SCRIPT)
            .user_agent(PROVIDER_LOGIN_USER_AGENT)
            .on_page_load(move |window, payload| {
                if matches!(payload.event(), PageLoadEvent::Finished) {
                    let _ = window.eval(LOGIN_BACK_BUTTON_SCRIPT);
                    // A new page here means the popup's job is done: Claude moves on once
                    // Google's popup has handed it the sign-in result.
                    close_provider_login_popups(window.app_handle());
                    // Time the close from when the result page is shown, not from when
                    // the callback was requested: the callback server answers only after
                    // the token exchange (and, for Antigravity, the project lookup),
                    // which can take seconds and would cut the page's countdown short.
                    if is_loopback_callback(payload.url())
                        && !close_scheduled.swap(true, Ordering::SeqCst)
                    {
                        let close_dir = load_dir.clone();
                        tauri::async_runtime::spawn(async move {
                            tokio::time::sleep(crate::oauth_common::CONNECTED_PAGE_DISPLAY).await;
                            let _ = std::fs::remove_dir_all(&close_dir);
                            crate::mobile_auth::dismiss_login_window(&window);
                        });
                    }
                }
            })
            .on_new_window(move |url, features| {
                // Claude's "Continue with Google" is a Google Identity Services popup
                // that hands the result back through `window.opener`, so it needs a
                // real window; without one Claude reports an error.
                if url.scheme() != "https" || !is_allowed_provider_login_navigation(&url) {
                    crate::diagnostics::warn(&format!(
                        "Sign-in blocked a popup to host {}",
                        url.host_str().unwrap_or("(none)")
                    ));
                    return NewWindowResponse::Deny;
                }
                match open_provider_login_popup(&popup_handle, features) {
                    Ok(window) => NewWindowResponse::Create { window },
                    Err(error) => {
                        crate::diagnostics::warn(&format!(
                            "Unable to open the sign-in popup: {}",
                            crate::diagnostics::command_error(error)
                        ));
                        NewWindowResponse::Deny
                    }
                }
            })
            .on_navigation(move |url| {
                if is_provider_login_back_request(url) {
                    back_state.fail_login_if_waiting(&back_attempt, "Sign-in was canceled.".into());
                    back_state.abort_login_resources(&back_attempt);
                    if let Some(window) = back_handle.get_webview_window(PROVIDER_LOGIN_WINDOW) {
                        crate::mobile_auth::dismiss_login_window(&window);
                    }
                    return false;
                }
                if is_loopback_callback(url) {
                    close_provider_login_popups(&nav_popups_handle);
                    // The window closes once the result page has been shown (on_page_load).
                    nav_callback_seen.store(true, Ordering::SeqCst);
                    return true;
                }
                let allowed = is_allowed_provider_login_navigation(url);
                if !allowed {
                    crate::diagnostics::warn(&format!(
                        "Sign-in blocked navigation to host {}",
                        url.host_str().unwrap_or("(none)")
                    ));
                }
                allowed
            });
    if let Some((x, y)) = position {
        builder = builder.position(x, y);
    } else {
        builder = builder.center();
    }
    let window = match builder.build() {
        Ok(window) => window,
        Err(error) => {
            let _ = std::fs::remove_dir_all(&profile_dir);
            return Err(format!(
                "Unable to open the sign-in window: {}",
                crate::diagnostics::command_error(error)
            ));
        }
    };
    if let Some((x, y)) = position {
        let _ = window.set_position(tauri::LogicalPosition::new(x, y));
    }
    let close_state = app.clone();
    let close_attempt = attempt_id.to_string();
    let close_dir = profile_dir;
    let close_seen = callback_seen;
    let close_handle = handle.clone();
    window.on_window_event(move |event| {
        if matches!(
            event,
            WindowEvent::CloseRequested { .. } | WindowEvent::Destroyed
        ) {
            close_provider_login_popups(&close_handle);
        }
        if matches!(event, WindowEvent::CloseRequested { .. }) {
            let _ = std::fs::remove_dir_all(&close_dir);
            if !close_seen.load(Ordering::SeqCst) {
                close_state.fail_login_if_waiting(&close_attempt, "Sign-in was canceled.".into());
                close_state.abort_login_resources(&close_attempt);
            }
        }
    });
    Ok(())
}

/// A popup opened by the sign-in page. Built from the opener's WebView
/// configuration (`window_features`) so WebKit links it to its opener and it
/// shares the sign-in session, and held to the same hosts as the sign-in window.
#[cfg(desktop)]
fn open_provider_login_popup(
    handle: &tauri::AppHandle,
    features: tauri::webview::NewWindowFeatures,
) -> tauri::Result<tauri::WebviewWindow> {
    static NEXT_POPUP: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let label = format!(
        "{PROVIDER_LOGIN_POPUP_PREFIX}{}",
        NEXT_POPUP.fetch_add(1, Ordering::Relaxed)
    );
    let close_handle = handle.clone();
    // The page's own window.open size is about 640×800 and clips 2-step
    // verification. Open taller than that, then apply it again after build so
    // the requested size does not stick.
    let (width, height, position) = crate::oauth_common::window_geometry_centered_on(
        handle,
        PROVIDER_LOGIN_WINDOW,
        0.0,
        0.0,
        640.0,
        1040.0,
    );
    let mut window_builder = WebviewWindowBuilder::new(
        handle,
        label,
        WebviewUrl::External(Url::parse("about:blank").expect("about:blank is a valid URL")),
    )
    .title("Sign in with Google")
    .window_features(features)
    .inner_size(width, height)
    .min_inner_size(520.0, 680.0)
    .resizable(true)
    .devtools(false)
    .initialization_script(POPUP_AUTO_CLOSE_SCRIPT)
    .user_agent(PROVIDER_LOGIN_USER_AGENT);
    if let Some((x, y)) = position {
        window_builder = window_builder.position(x, y);
    } else {
        window_builder = window_builder.center();
    }
    let window = window_builder
        .on_navigation(move |url| {
            if is_provider_login_popup_close_request(url) {
                close_provider_login_popups(&close_handle);
                return false;
            }
            let allowed = url.as_str() == "about:blank"
                || (url.scheme() == "https" && is_allowed_provider_login_navigation(url));
            if !allowed {
                crate::diagnostics::warn(&format!(
                    "Sign-in popup blocked navigation to host {}",
                    url.host_str().unwrap_or("(none)")
                ));
            }
            allowed
        })
        .build()?;
    let _ = window.set_size(tauri::LogicalSize::new(width, height));
    if let Some((x, y)) = position {
        let _ = window.set_position(tauri::LogicalPosition::new(x, y));
    }

    let watch_handle = handle.clone();
    let watch_label = window.label().to_string();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            let Some(popup) = watch_handle.get_webview_window(&watch_label) else {
                break;
            };
            let Some(opener) = watch_handle.get_webview_window(PROVIDER_LOGIN_WINDOW) else {
                crate::mobile_auth::dismiss_login_window(&popup);
                break;
            };
            if let Ok(current) = opener.url() {
                if is_loopback_callback(&current) {
                    crate::mobile_auth::dismiss_login_window(&popup);
                    break;
                }
            }
        }
    });

    Ok(window)
}

/// Closes any sign-in popups. Google's popup calls `window.close()` when it is
/// done, which Tauri does not act on, so the app closes it instead.
#[cfg(desktop)]
fn close_provider_login_popups(handle: &tauri::AppHandle) {
    for (label, popup) in handle.webview_windows() {
        if label.starts_with(PROVIDER_LOGIN_POPUP_PREFIX) {
            crate::mobile_auth::dismiss_login_window(&popup);
        }
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
    if target.scheme() != "https" {
        return Err("Authorization URL must use HTTPS".to_string());
    }
    let host = target.host_str().unwrap_or("");
    let allowed = ["auth.openai.com", "claude.ai", "accounts.google.com"];
    if !allowed
        .iter()
        .any(|&h| host == h || host.ends_with(&format!(".{h}")))
    {
        return Err("Disallowed authorization URL host".to_string());
    }
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

/// Why an authorization code could not be exchanged for tokens.
#[derive(Debug, PartialEq, Eq)]
enum ExchangeError {
    /// The provider could not be reached, or did not answer in time. The same code is still good,
    /// so the exchange is worth retrying.
    Unreachable(String),
    /// The provider refused or answered badly, or something local failed. Retrying cannot help.
    Failed(String),
}

type ExchangeResult<T> = Result<T, ExchangeError>;

impl From<String> for ExchangeError {
    fn from(message: String) -> Self {
        Self::Failed(message)
    }
}

impl From<&str> for ExchangeError {
    fn from(message: &str) -> Self {
        Self::Failed(message.to_string())
    }
}

impl ExchangeError {
    fn message(&self) -> &str {
        match self {
            Self::Unreachable(message) | Self::Failed(message) => message,
        }
    }

    fn into_message(self) -> String {
        match self {
            Self::Unreachable(message) | Self::Failed(message) => message,
        }
    }

    fn is_retryable(&self) -> bool {
        matches!(self, Self::Unreachable(_))
    }

    /// A request that never got an answer. The message names the whole cause chain, so a failure
    /// can be told apart from the user's side (no network, DNS, a firewall).
    fn from_send(prefix: &str, error: &reqwest::Error) -> Self {
        use std::error::Error;
        let mut message = format!("{prefix}: {error}");
        let mut current: Option<&(dyn Error + 'static)> = error.source();
        while let Some(source) = current {
            message.push_str(&format!(" -> {source}"));
            current = source.source();
        }
        if error.is_connect() || error.is_timeout() || looks_unreachable(&message) {
            Self::Unreachable(message)
        } else {
            Self::Failed(message)
        }
    }

    /// The provider answered with a non-success status. Only a gateway or request timeout (408,
    /// 504) says the answer may simply be late.
    fn from_status(message: String, status: reqwest::StatusCode) -> Self {
        if matches!(status.as_u16(), 408 | 504) {
            Self::Unreachable(message)
        } else {
            Self::Failed(message)
        }
    }
}

/// Wording the network stack uses for "could not get through" that reqwest does not flag itself
/// (for example a connection reset partway through the request).
fn looks_unreachable(message: &str) -> bool {
    let lower = message.to_lowercase();
    [
        "dns error",
        "connect",
        "no address associated",
        "network is unreachable",
        "timed out",
        "timeout",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
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
                    return Ok(LoginStatus {
                        attempt_id: attempt_id.into(),
                        status: LoginState::Complete,
                        message: None,
                        account: Some(account),
                        projects: None,
                        selected_project_id: None,
                    });
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

#[cfg_attr(not(any(test, mobile)), allow(dead_code))]
/// The app's own loopback callback page, as a sign-in window (desktop) or the
/// main window (mobile) loads it.
pub(crate) fn is_loopback_callback(url: &Url) -> bool {
    looks_like_oauth_callback(url) && url.scheme() == "http" && url.username().is_empty()
}

pub(crate) fn looks_like_oauth_callback(url: &Url) -> bool {
    let is_loopback = url
        .host_str()
        .map(|host| {
            let host = host
                .strip_prefix('[')
                .and_then(|h| h.strip_suffix(']'))
                .unwrap_or(host);
            matches!(host, "127.0.0.1" | "localhost" | "::1")
                || host.parse::<IpAddr>().is_ok_and(|ip| ip.is_loopback())
        })
        .unwrap_or(false);
    is_loopback
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

async fn handle_callback(
    context: Arc<LoginContext>,
    query: CallbackQuery,
) -> axum::response::Response {
    // Only the provider's redirect carries this attempt's state. Any other
    // request to the callback (a local process, or a web page that knows the
    // port) is answered without claiming the callback, failing the sign-in, or
    // showing its text in the app.
    if query.state.as_deref() != Some(context.expected_state.as_str()) {
        return crate::oauth_common::unrecognized_callback_response();
    }
    if context
        .callback_claimed
        .swap(true, std::sync::atomic::Ordering::SeqCst)
    {
        return callback_html(
            r#"<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0;min-height:100vh;min-height:100dvh;box-sizing:border-box;display:flex;flex-direction:column;align-items:center;justify-content:center;background:#000000;color:#f4f6f8;font-family:system-ui;padding:24px 20px;text-align:center"><div style="max-width:480px;width:100%"><h1 style="margin:0 0 12px;font-size:28px">Finishing sign-in</h1><p style="color:#d1d5db;margin:0">Return to AI Usage Tracker.</p></div></body></html>"#
                .into(),
        );
    }
    if let Some(error) = query.error {
        let message = query.error_description.unwrap_or(error);
        context
            .app
            .fail_login_if_waiting(&context.attempt_id, message.clone());
        stop_callback(&context).await;
        return callback_html(auth_failure_html("Authentication failed", &message));
    }
    let code = match query.code {
        Some(code) => code,
        None => {
            let message = format!(
                "{} did not return an authorization code.",
                context.provider.display_name()
            );
            context
                .app
                .fail_login_if_waiting(&context.attempt_id, message.clone());
            stop_callback(&context).await;
            return callback_html(auth_failure_html("Authentication failed", &message));
        }
    };
    if !context.app.login_is_waiting(&context.attempt_id) {
        stop_callback(&context).await;
        return callback_html(
            r#"<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0;min-height:100vh;min-height:100dvh;box-sizing:border-box;display:flex;flex-direction:column;align-items:center;justify-content:center;background:#000000;color:#f4f6f8;font-family:system-ui;padding:24px 20px;text-align:center"><div style="max-width:480px;width:100%"><h1 style="margin:0;font-size:28px">Login canceled</h1></div></body></html>"#
                .into(),
        );
    }

    match complete_exchange(&context, &code).await {
        Ok(account) => {
            stop_callback(&context).await;
            callback_html(account_connected_html("Account connected", &account))
        }
        Err(error) => {
            if error.is_retryable() && context.app.login_is_waiting(&context.attempt_id) {
                {
                    let mut pending = context.app.pending_auth_exchange.lock();
                    *pending = Some(crate::state::PendingAuthExchange {
                        attempt_id: context.attempt_id.clone(),
                        provider: context.provider.clone(),
                        label: context.label.clone(),
                        reconnect_account_id: context.reconnect_account_id.clone(),
                        code,
                        verifier: context.verifier.clone(),
                        expected_state: context.expected_state.clone(),
                        redirect_uri: context.redirect_uri.clone(),
                    });
                }
                stop_callback(&context).await;
                callback_html(
                    r#"<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0;min-height:100vh;min-height:100dvh;box-sizing:border-box;display:flex;flex-direction:column;align-items:center;justify-content:center;background:#000000;color:#f4f6f8;font-family:system-ui;padding:24px 20px;text-align:center"><div style="max-width:480px;width:100%"><h1 style="color:#4ade80;margin:0 0 12px;font-size:28px">Authorization received</h1><p style="color:#d1d5db;font-size:16px;margin:16px 0 0">Return to AI Usage Tracker to complete connection.</p></div></body></html>"#
                        .into(),
                )
            } else {
                context
                    .app
                    .fail_login_if_waiting(&context.attempt_id, error.message().to_string());
                stop_callback(&context).await;
                callback_html(auth_failure_html("Authentication failed", error.message()))
            }
        }
    }
}

/// Picks the stored account a finished sign-in should update.
fn find_account_to_update(context: &LoginContext, identity: &ProviderIdentity) -> Option<Account> {
    context.app.store.account_to_update(
        &context.provider,
        context.reconnect_account_id.as_deref(),
        identity.account_id.as_deref(),
        identity.email.as_deref(),
    )
}

async fn complete_exchange(context: &LoginContext, code: &str) -> ExchangeResult<Account> {
    let mut last_error: Option<ExchangeError> = None;
    let mut exchanged = None;
    for attempt in 0..5 {
        if !context.app.login_is_waiting(&context.attempt_id) {
            return Err("The login attempt was canceled.".into());
        }
        match exchange_tokens(context, code).await {
            Ok(res) => {
                exchanged = Some(res);
                break;
            }
            Err(err) => {
                let retry = attempt < 4 && err.is_retryable();
                last_error = Some(err);
                if retry {
                    tokio::time::sleep(std::time::Duration::from_millis(600)).await;
                } else {
                    break;
                }
            }
        }
    }
    let (secret, identity) = match (exchanged, last_error) {
        (Some(res), _) => res,
        (None, Some(error)) => return Err(error),
        (None, None) => return Err("The token exchange did not run.".into()),
    };
    if !context.app.login_is_waiting(&context.attempt_id) {
        return Err("The login attempt was canceled.".into());
    }
    let duplicate = find_account_to_update(context, &identity);
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
    if !context.app.login_is_waiting(&context.attempt_id) {
        return Err("The login attempt was canceled.".into());
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
            status: LoginState::Complete,
            message: None,
            account: Some(account.clone()),
            projects: None,
            selected_project_id: None,
        });
    }
    let refresh_app = context.app.clone();
    let refresh_account_id = account.id.clone();
    let refresh_attempt_id = context.attempt_id.clone();
    tauri::async_runtime::spawn(async move {
        if let Ok(refreshed) =
            crate::usage::refresh_account(refresh_app.clone(), &refresh_account_id).await
        {
            refresh_app.update_login_account(&refresh_attempt_id, refreshed);
        }
    });
    Ok(account)
}

async fn exchange_tokens(
    context: &LoginContext,
    code: &str,
) -> ExchangeResult<(ProviderSecret, ProviderIdentity)> {
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
) -> ExchangeResult<(ProviderSecret, ProviderIdentity)> {
    let response = context
        .app
        .client
        .post(OPENAI_TOKEN_URL)
        .form(&[
            ("grant_type", "authorization_code"),
            ("client_id", OPENAI_CLIENT_ID),
            ("code", code),
            ("code_verifier", context.verifier.as_str()),
            ("redirect_uri", context.redirect_uri.as_str()),
        ])
        .send()
        .await
        .map_err(|error| ExchangeError::from_send("OpenAI token exchange failed", &error))?;
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(ExchangeError::from_status(
            format!("OpenAI token exchange failed ({status})."),
            status,
        ));
    }
    let tokens: OAuthTokenResponse =
        serde_json::from_str(&body).map_err(|_| String::from("Invalid OpenAI token response."))?;
    // Unlike the other providers, OpenAI always reports a lifetime; a response without one is malformed.
    let expires_in = tokens
        .expires_in
        .ok_or_else(|| "Invalid OpenAI token response: missing field `expires_in`".to_string())?;
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
    let mut identity = identity_from_userinfo(&userinfo);
    if let Some(claims) = tokens.id_token.as_deref().and_then(decode_claims) {
        identity.email = identity.email.or(claims.email);
        identity.account_id = identity.account_id.or(claims.account_id);
        identity.plan = identity.plan.or(claims.plan);
    }
    Ok((
        ProviderSecret::Openai(OAuthSecret {
            access_token: tokens.access_token,
            refresh_token,
            id_token: tokens.id_token,
            expires_at: Utc::now().timestamp_millis() + expires_in * 1000,
        }),
        identity,
    ))
}

async fn exchange_anthropic(
    context: &LoginContext,
    code: &str,
) -> ExchangeResult<(ProviderSecret, ProviderIdentity)> {
    let response = context
        .app
        .client
        .post(ANTHROPIC_TOKEN_URL)
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
        .map_err(|error| ExchangeError::from_send("Anthropic token exchange failed", &error))?;
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(ExchangeError::from_status(
            format!("Anthropic token exchange failed ({status})."),
            status,
        ));
    }
    let token_json: Value = serde_json::from_str(&body)
        .map_err(|_| String::from("Invalid Anthropic token response."))?;
    let tokens: OAuthTokenResponse = serde_json::from_value(token_json.clone())
        .map_err(|_| String::from("Invalid Anthropic token response."))?;
    let refresh_token = tokens
        .refresh_token
        .clone()
        .ok_or_else(|| "Anthropic did not return a refresh token.".to_string())?;
    let profile = fetch_anthropic_profile(&context.app, &tokens.access_token)
        .await
        .unwrap_or(Value::Null);
    let identity = anthropic_identity(&profile, &token_json);
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
) -> ExchangeResult<(ProviderSecret, ProviderIdentity)> {
    let client_secret = client_secret();
    let response = context
        .app
        .client
        .post(GOOGLE_TOKEN_URL)
        .form(&[
            ("client_id", CLIENT_ID),
            ("client_secret", client_secret.as_str()),
            ("code", code),
            ("redirect_uri", context.redirect_uri.as_str()),
            ("grant_type", "authorization_code"),
            ("code_verifier", context.verifier.as_str()),
        ])
        .send()
        .await
        .map_err(|error| ExchangeError::from_send("Google token exchange failed", &error))?;
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(ExchangeError::from_status(
            format!("Google token exchange failed ({status})."),
            status,
        ));
    }
    let tokens: OAuthTokenResponse =
        serde_json::from_str(&body).map_err(|_| String::from("Invalid Google token response."))?;
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
    // Identity comes from Google's userinfo API (TLS + bearer token), never
    // from decoded-but-unverified ID-token claims.
    let identity = identity_from_google_userinfo(&profile);
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

/// HTTP origin for a bound loopback socket, with IPv6 literals bracketed.
pub(crate) fn loopback_http_origin(addr: SocketAddr) -> String {
    match addr.ip() {
        IpAddr::V4(ip) => format!("http://{ip}:{}", addr.port()),
        IpAddr::V6(ip) => format!("http://[{ip}]:{}", addr.port()),
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

pub(crate) async fn bind_loopback_listener(port: u16) -> std::io::Result<TcpListener> {
    match TcpListener::bind(("127.0.0.1", port)).await {
        Ok(listener) => Ok(listener),
        Err(error) if error.kind() == std::io::ErrorKind::AddrInUse => Err(error),
        Err(ipv4_error) => match TcpListener::bind(("::1", port)).await {
            Ok(listener) => Ok(listener),
            Err(_) => Err(ipv4_error),
        },
    }
}

pub(crate) async fn bind_ephemeral_loopback() -> Result<(TcpListener, SocketAddr), String> {
    let listener = bind_loopback_listener(0)
        .await
        .map_err(|error| format!("Unable to start OAuth callback server: {error}"))?;
    let addr = listener
        .local_addr()
        .map_err(|error| format!("Unable to read OAuth callback address: {error}"))?;
    Ok((listener, addr))
}

async fn bind_callback_port(provider: &Provider) -> Result<(TcpListener, SocketAddr), String> {
    if matches!(provider, Provider::Antigravity) {
        return bind_ephemeral_loopback().await;
    }
    let ports: Vec<u16> = match provider {
        Provider::Openai => OPENAI_CALLBACK_PORTS.to_vec(),
        Provider::Anthropic => (53692..=53696).collect(),
        Provider::Antigravity => Vec::new(),
        Provider::GoogleAiStudio | Provider::Grok | Provider::OpencodeGo => Vec::new(),
    };
    for port in ports {
        match bind_loopback_listener(port).await {
            Ok(listener) => {
                let addr = listener
                    .local_addr()
                    .map_err(|error| format!("Unable to read OAuth callback address: {error}"))?;
                return Ok((listener, addr));
            }
            Err(error) if error.kind() == std::io::ErrorKind::AddrInUse => continue,
            Err(error) => return Err(format!("Unable to start OAuth callback server: {error}")),
        }
    }
    Err(if matches!(provider, Provider::Openai) {
        "ChatGPT login needs localhost port 1455 (or 1457). Close another ChatGPT login and try again.".into()
    } else {
        format!(
            "No callback port is available for {}.",
            provider.display_name()
        )
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
        .map_err(|_| String::from("Invalid profile response."))
}

/// Decodes the payload segment of a JWT without verifying the signature.
/// Claims from this helper are informational only and must not be used as
/// authentication identity.
#[cfg(test)]
fn decode_jwt_payload(token: &str) -> Option<Value> {
    let segment = token.split('.').nth(1)?;
    let decoded = URL_SAFE_NO_PAD.decode(segment).ok()?;
    serde_json::from_slice(&decoded).ok()
}

fn identity_from_google_userinfo(profile: &Value) -> ProviderIdentity {
    ProviderIdentity {
        email: profile
            .get("email")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .map(str::to_string),
        account_id: profile
            .get("id")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .map(str::to_string),
        plan: Some("Antigravity".into()),
    }
}

async fn fetch_anthropic_profile(app: &AppState, access_token: &str) -> Result<Value, String> {
    const PROFILE_URL: &str = "https://api.anthropic.com/api/oauth/profile";
    const LEGACY_PROFILE_URL: &str = "https://api.anthropic.com/api/auth/oauth/profile";
    const HEADERS: &[(&str, &str)] = &[("anthropic-beta", "oauth-2025-04-20")];
    match fetch_json_with_headers(app, PROFILE_URL, access_token, HEADERS).await {
        Ok(profile) => Ok(profile),
        Err(_) => fetch_json_with_headers(app, LEGACY_PROFILE_URL, access_token, HEADERS).await,
    }
}

fn anthropic_identity(profile: &Value, token: &Value) -> ProviderIdentity {
    ProviderIdentity {
        email: crate::providers::anthropic::email_from_profile(profile)
            .or_else(|| crate::providers::anthropic::email_from_profile(token)),
        account_id: crate::providers::anthropic::account_id_from_profile(profile)
            .or_else(|| crate::providers::anthropic::account_id_from_profile(token)),
        plan: crate::providers::anthropic::plan_from_profile(profile),
    }
}

fn identity_from_userinfo(value: &Value) -> ProviderIdentity {
    ProviderIdentity {
        email: find_string(value, &["email", "email_address"]),
        account_id: find_string(value, &["chatgpt_account_id", "account_id", "sub"]),
        plan: find_string(value, &["chatgpt_plan_type", "plan_type", "plan"]),
    }
}

use crate::model::TokenClaims;

fn decode_claims(token: &str) -> Option<TokenClaims> {
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
    Some(TokenClaims {
        email,
        account_id,
        plan,
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

fn string_at(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_string)
}

async fn stop_callback(context: &LoginContext) {
    context.app.stop_login_shutdown(&context.attempt_id);
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
    }

    fn reconnect_context(app: Arc<AppState>, target: Option<&str>) -> LoginContext {
        LoginContext {
            app,
            attempt_id: "attempt".into(),
            label: "Work".into(),
            reconnect_account_id: target.map(str::to_string),
            provider: Provider::Openai,
            verifier: "v".into(),
            expected_state: "s".into(),
            redirect_uri: "http://localhost:1455/auth/callback".into(),
            callback_claimed: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        }
    }

    fn stored_openai(app: &AppState, email: Option<&str>, account_id: Option<&str>) -> Account {
        let now = now_rfc3339();
        app.store
            .upsert(Account {
                id: "existing".into(),
                label: "Work".into(),
                provider: Provider::Openai,
                email: email.map(str::to_string),
                provider_account_id: account_id.map(str::to_string),
                chatgpt_account_id: account_id.map(str::to_string),
                plan: None,
                created_at: now.clone(),
                updated_at: now,
                last_usage: None,
                last_error: Some("expired".into()),
                auth_required: true,
            })
            .unwrap()
    }

    #[test]
    fn reconnect_updates_the_account_even_when_sign_in_reports_a_different_id() {
        let temp = tempfile::tempdir().unwrap();
        let app = Arc::new(AppState::new(temp.path().to_path_buf(), "t".into()).unwrap());
        stored_openai(&app, Some("me@example.com"), Some("acct_old"));
        let context = reconnect_context(app, Some("existing"));
        let identity = ProviderIdentity {
            email: Some("ME@example.com".into()),
            account_id: Some("user-sub".into()),
            plan: None,
        };
        assert_eq!(
            find_account_to_update(&context, &identity).map(|a| a.id),
            Some("existing".into())
        );
    }

    #[test]
    fn reconnect_updates_the_account_when_sign_in_reports_no_identity() {
        let temp = tempfile::tempdir().unwrap();
        let app = Arc::new(AppState::new(temp.path().to_path_buf(), "t".into()).unwrap());
        stored_openai(&app, Some("me@example.com"), Some("acct_old"));
        let context = reconnect_context(app, Some("existing"));
        assert_eq!(
            find_account_to_update(&context, &ProviderIdentity::default()).map(|a| a.id),
            Some("existing".into())
        );
    }

    #[test]
    fn reconnect_does_not_overwrite_an_account_when_a_different_person_signs_in() {
        let temp = tempfile::tempdir().unwrap();
        let app = Arc::new(AppState::new(temp.path().to_path_buf(), "t".into()).unwrap());
        stored_openai(&app, Some("me@example.com"), Some("acct_old"));
        let context = reconnect_context(app, Some("existing"));
        let identity = ProviderIdentity {
            email: Some("other@example.com".into()),
            account_id: Some("acct_other".into()),
            plan: None,
        };
        assert!(find_account_to_update(&context, &identity).is_none());
    }

    #[test]
    fn reconnect_without_a_stored_email_rejects_a_conflicting_account_id() {
        let temp = tempfile::tempdir().unwrap();
        let app = Arc::new(AppState::new(temp.path().to_path_buf(), "t".into()).unwrap());
        stored_openai(&app, None, Some("acct_old"));
        let context = reconnect_context(app, Some("existing"));
        let identity = ProviderIdentity {
            email: Some("other@example.com".into()),
            account_id: Some("acct_other".into()),
            plan: None,
        };
        assert!(find_account_to_update(&context, &identity).is_none());
    }

    #[test]
    fn id_token_claims_fill_identity_gaps() {
        let payload = serde_json::json!({
            "email": "person@example.com",
            "https://api.openai.com/auth": { "chatgpt_account_id": "acct_123" }
        });
        let token = format!("x.{}.y", URL_SAFE_NO_PAD.encode(payload.to_string()));
        let claims = decode_claims(&token).unwrap();
        assert_eq!(claims.account_id.as_deref(), Some("acct_123"));
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
        let openai: SocketAddr = "127.0.0.1:1455".parse().unwrap();
        let openai_fallback: SocketAddr = "127.0.0.1:1457".parse().unwrap();
        let anthropic: SocketAddr = "127.0.0.1:53692".parse().unwrap();
        let antigravity: SocketAddr = "127.0.0.1:11451".parse().unwrap();
        assert_eq!(
            redirect_uri(&Provider::Openai, openai),
            "http://localhost:1455/auth/callback"
        );
        assert_eq!(
            redirect_uri(&Provider::Openai, openai_fallback),
            "http://localhost:1457/auth/callback"
        );
        assert_eq!(
            redirect_uri(&Provider::Anthropic, anthropic),
            "http://localhost:53692/callback"
        );
        assert_eq!(
            redirect_uri(&Provider::Antigravity, antigravity),
            "http://127.0.0.1:11451"
        );
        assert_eq!(loopback_http_origin(antigravity), "http://127.0.0.1:11451");
    }

    #[tokio::test]
    async fn ephemeral_loopback_advertises_the_bound_address() {
        let (listener, addr) = bind_ephemeral_loopback().await.unwrap();
        assert!(addr.ip().is_loopback());
        let origin = loopback_http_origin(addr);
        if addr.is_ipv6() {
            assert!(
                origin.starts_with("http://[") && origin.contains("]:"),
                "IPv6 loopback origin must bracket the host: {origin}"
            );
        } else {
            assert!(
                origin.starts_with("http://127.0.0.1:"),
                "IPv4 loopback origin should use 127.0.0.1: {origin}"
            );
        }
        drop(listener);
    }

    #[test]
    fn oauth_redirects_bracket_loopback_ipv6() {
        let antigravity: SocketAddr = "[::1]:11451".parse().unwrap();
        let openai: SocketAddr = "[::1]:1455".parse().unwrap();
        assert_eq!(
            redirect_uri(&Provider::Antigravity, antigravity),
            "http://[::1]:11451"
        );
        assert_eq!(loopback_http_origin(antigravity), "http://[::1]:11451");
        assert_eq!(
            redirect_uri(&Provider::Openai, openai),
            "http://localhost:1455/auth/callback"
        );
    }

    #[test]
    fn anthropic_authorize_url_omits_unused_scopes() {
        let url = build_authorization_url(
            &Provider::Anthropic,
            "http://localhost:53692/callback",
            "challenge",
            "state",
            None,
        )
        .unwrap();
        let parsed = Url::parse(&url).unwrap();
        let pairs: Vec<(String, String)> = parsed
            .query_pairs()
            .map(|(key, value)| (key.into_owned(), value.into_owned()))
            .collect();
        assert_eq!(
            pairs
                .iter()
                .find(|(key, _)| key == "client_id")
                .map(|(_, value)| value.as_str()),
            Some(ANTHROPIC_CLIENT_ID)
        );
        assert_eq!(
            pairs
                .iter()
                .find(|(key, _)| key == "redirect_uri")
                .map(|(_, value)| value.as_str()),
            Some("http://localhost:53692/callback")
        );
        // `prompt=login` asks claude.ai to show its sign-in page even when a
        // session exists, so connecting a second account does not skip
        // straight to the consent screen for the first one.
        assert!(pairs
            .iter()
            .any(|(key, value)| key == "prompt" && value == "login"));
        assert!(pairs
            .iter()
            .any(|(key, value)| key == "code" && value == "true"));
        assert_eq!(
            pairs
                .iter()
                .find(|(key, _)| key == "response_type")
                .map(|(_, value)| value.as_str()),
            Some("code")
        );
        assert_eq!(
            pairs
                .iter()
                .find(|(key, _)| key == "code_challenge_method")
                .map(|(_, value)| value.as_str()),
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
            None,
        )
        .unwrap();
        let parsed = Url::parse(&url).unwrap();
        let pairs: Vec<(String, String)> = parsed
            .query_pairs()
            .map(|(key, value)| (key.into_owned(), value.into_owned()))
            .collect();
        // `select_account` forces Google's account chooser so a second account
        // can be added while one session is active; `consent` keeps the
        // refresh token coming for that second account.
        assert_eq!(
            pairs
                .iter()
                .find(|(key, _)| key == "prompt")
                .map(|(_, value)| value.as_str()),
            Some("select_account consent")
        );
        assert_eq!(
            pairs
                .iter()
                .find(|(key, _)| key == "access_type")
                .map(|(_, value)| value.as_str()),
            Some("offline")
        );
        let scopes = pairs
            .iter()
            .find(|(key, _)| key == "scope")
            .map(|(_, value)| value.as_str())
            .unwrap();
        assert_eq!(scopes, ANTIGRAVITY_SCOPES);
        assert!(!pairs.iter().any(|(key, _)| key == "include_granted_scopes"));
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
        assert!(looks_like_oauth_callback(
            &Url::parse("http://[::1]:11451/?code=abc&state=xyz").unwrap()
        ));
        assert!(looks_like_oauth_callback(
            &Url::parse("http://[::1]:1455/auth/callback?error=access_denied").unwrap()
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
            None,
        )
        .unwrap();
        let parsed = Url::parse(&url).unwrap();
        let pairs: Vec<(String, String)> = parsed
            .query_pairs()
            .map(|(key, value)| (key.into_owned(), value.into_owned()))
            .collect();
        assert_eq!(
            pairs
                .iter()
                .find(|(key, _)| key == "response_type")
                .map(|(_, value)| value.as_str()),
            Some("code")
        );
        assert_eq!(
            pairs
                .iter()
                .find(|(key, _)| key == "client_id")
                .map(|(_, value)| value.as_str()),
            Some(OPENAI_CLIENT_ID)
        );
        assert_eq!(
            pairs
                .iter()
                .find(|(key, _)| key == "redirect_uri")
                .map(|(_, value)| value.as_str()),
            Some("http://localhost:1455/auth/callback")
        );
        assert_eq!(
            pairs
                .iter()
                .find(|(key, _)| key == "scope")
                .map(|(_, value)| value.as_str()),
            Some("openid profile email offline_access")
        );
        assert_eq!(
            pairs
                .iter()
                .find(|(key, _)| key == "code_challenge_method")
                .map(|(_, value)| value.as_str()),
            Some("S256")
        );
        assert!(pairs
            .iter()
            .any(|(key, value)| key == "id_token_add_organizations" && value == "true"));
        assert!(pairs
            .iter()
            .any(|(key, value)| key == "codex_cli_simplified_flow" && value == "true"));
        assert!(pairs
            .iter()
            .any(|(key, value)| key == "originator" && value == OPENAI_ORIGINATOR));
        assert!(!pairs.iter().any(|(key, _)| key == "audience"));
        // `prompt=login` makes Auth0 show the login page even when an SSO
        // session exists, so a different address can be entered for a second
        // account instead of silently reusing the first.
        assert!(pairs
            .iter()
            .any(|(key, value)| key == "prompt" && value == "login"));
    }

    #[test]
    fn authorize_urls_carry_login_hint_for_the_intended_account() {
        for provider in [Provider::Openai, Provider::Anthropic, Provider::Antigravity] {
            let without = build_authorization_url(
                &provider,
                "http://localhost:1455/auth/callback",
                "challenge",
                "state",
                None,
            )
            .unwrap();
            assert!(
                !Url::parse(&without)
                    .unwrap()
                    .query_pairs()
                    .any(|(key, _)| key == "login_hint"),
                "{provider:?} must omit login_hint without an email"
            );
            // Blank or whitespace-only hints are dropped, never sent empty.
            let blank = build_authorization_url(
                &provider,
                "http://localhost:1455/auth/callback",
                "challenge",
                "state",
                Some("   "),
            )
            .unwrap();
            assert!(
                !Url::parse(&blank)
                    .unwrap()
                    .query_pairs()
                    .any(|(key, _)| key == "login_hint"),
                "{provider:?} must drop a blank login_hint"
            );
            let with = build_authorization_url(
                &provider,
                "http://localhost:1455/auth/callback",
                "challenge",
                "state",
                Some("  second@example.com  "),
            )
            .unwrap();
            assert_eq!(
                Url::parse(&with)
                    .unwrap()
                    .query_pairs()
                    .find(|(key, _)| key == "login_hint")
                    .map(|(_, value)| value.into_owned())
                    .as_deref(),
                Some("second@example.com"),
                "{provider:?} must hint the intended account, trimmed"
            );
        }
    }

    #[test]
    fn back_button_stays_out_of_sign_in_popups() {
        // Popups share the sign-in window's scripts; only the window itself gets Back.
        assert!(LOGIN_BACK_BUTTON_SCRIPT.contains("if (window.opener) return;"));
        assert!(PROVIDER_LOGIN_POPUP_PREFIX.starts_with(PROVIDER_LOGIN_WINDOW));
        assert_ne!(PROVIDER_LOGIN_POPUP_PREFIX, PROVIDER_LOGIN_WINDOW);
    }

    #[test]
    fn provider_login_window_stays_on_sign_in_pages() {
        for url in [
            "https://accounts.google.com/o/oauth2/auth",
            "https://claude.ai/oauth/authorize",
            "https://auth.openai.com/oauth/authorize",
            "https://appleid.apple.com/auth/authorize",
            "https://login.microsoftonline.com/common/oauth2",
            "about:blank",
            "http://127.0.0.1:1455/auth/callback?code=abc&state=xyz",
            "http://localhost:53692/callback?code=abc",
            "http://[::1]:11451/?code=abc",
        ] {
            assert!(
                is_allowed_provider_login_navigation(&Url::parse(url).unwrap()),
                "{url}"
            );
        }
        for url in [
            "https://evil.example/login",
            "https://claude.ai.evil.example/",
            "https://notgoogle.com/",
            "http://claude.ai/oauth/authorize",
            "https://accounts.google.com:8443/",
            "https://user@accounts.google.com/",
            "javascript:alert(1)",
            "file:///tmp/secret",
            "http://127.0.0.1:1455/",
            "https://accounts.google.com/o/oauth2/auth?ai-usage-tracker-back=1",
            "https://accounts.google.com/o/oauth2/auth?ai-usage-tracker-popup-close=1",
        ] {
            assert!(
                !is_allowed_provider_login_navigation(&Url::parse(url).unwrap()),
                "{url}"
            );
        }
    }

    #[test]
    fn popup_close_request_is_detected_and_blocks_navigation() {
        let close_url =
            Url::parse("https://accounts.google.com/o/oauth2/auth?ai-usage-tracker-popup-close=1")
                .unwrap();
        let other_url = Url::parse("https://accounts.google.com/o/oauth2/auth").unwrap();
        assert!(is_provider_login_popup_close_request(&close_url));
        assert!(!is_provider_login_popup_close_request(&other_url));
        assert!(!is_allowed_provider_login_navigation(&close_url));
        assert!(POPUP_AUTO_CLOSE_SCRIPT.contains("window.close = closeHandler"));
        assert!(POPUP_AUTO_CLOSE_SCRIPT.contains(POPUP_CLOSE_QUERY_FLAG));
        assert!(!POPUP_AUTO_CLOSE_SCRIPT.contains("postMessage"));
    }

    #[test]
    fn provider_login_window_only_starts_on_provider_authorize_hosts() {
        for url in [
            "https://accounts.google.com/o/oauth2/auth",
            "https://claude.ai/oauth/authorize",
            "https://auth.openai.com/oauth/authorize",
        ] {
            assert!(
                is_allowed_provider_login_start(&Url::parse(url).unwrap()),
                "{url}"
            );
        }
        // SSO hosts may appear later in the flow. They are not a start URL,
        // and neither is an arbitrary site or a Back request.
        for url in [
            "https://appleid.apple.com/auth/authorize",
            "https://evil.example/",
            "http://accounts.google.com/o/oauth2/auth",
            "https://accounts.google.com/o/oauth2/auth?ai-usage-tracker-back=1",
        ] {
            assert!(
                !is_allowed_provider_login_start(&Url::parse(url).unwrap()),
                "{url}"
            );
        }
    }

    #[test]
    fn anthropic_identity_prefers_nested_account_email() {
        let profile = serde_json::json!({
            "account": { "uuid": "acct-22", "email": "claude.user@example.com" },
            "organization": { "uuid": "org-1", "name": "Personal" }
        });
        let token = serde_json::json!({
            "access_token": "tok",
            "account": { "email_address": "from-token@example.com" }
        });
        let identity = anthropic_identity(&profile, &token);
        assert_eq!(identity.email.as_deref(), Some("claude.user@example.com"));
        assert_eq!(identity.account_id.as_deref(), Some("acct-22"));
        let from_token = anthropic_identity(&Value::Null, &token);
        assert_eq!(from_token.email.as_deref(), Some("from-token@example.com"));
    }

    #[test]
    fn unverified_id_token_claims_are_informational_only() {
        let payload = serde_json::json!({
            "email": "injected@example.com",
            "sub": "attacker-sub"
        });
        let token = format!("x.{}.y", URL_SAFE_NO_PAD.encode(payload.to_string()));
        let claims = decode_jwt_payload(&token).unwrap();
        assert_eq!(
            claims.get("email").and_then(Value::as_str),
            Some("injected@example.com")
        );
        assert_eq!(
            claims.get("sub").and_then(Value::as_str),
            Some("attacker-sub")
        );
        let empty = identity_from_google_userinfo(&Value::Null);
        assert!(empty.email.is_none());
        assert!(empty.account_id.is_none());
        let identity = identity_from_google_userinfo(&serde_json::json!({
            "email": "real@example.com",
            "id": "google-user-id"
        }));
        assert_eq!(identity.email.as_deref(), Some("real@example.com"));
        assert_eq!(identity.account_id.as_deref(), Some("google-user-id"));
    }

    #[tokio::test]
    async fn login_status_does_not_restore_authorization_code_after_poll() {
        let temp = tempfile::tempdir().unwrap();
        let app = Arc::new(AppState::new(temp.path().to_path_buf(), "test-token".into()).unwrap());
        *app.pending_login.write() = Some(LoginStatus {
            attempt_id: "attempt".into(),
            status: LoginState::Waiting,
            message: None,
            account: None,
            projects: None,
            selected_project_id: None,
        });
        *app.pending_auth_exchange.lock() = Some(crate::state::PendingAuthExchange {
            attempt_id: "attempt".into(),
            provider: Provider::GoogleAiStudio,
            label: "Test".into(),
            reconnect_account_id: None,
            code: "single-use-code".into(),
            verifier: "verifier".into(),
            expected_state: "state".into(),
            redirect_uri: "http://127.0.0.1:1".into(),
        });

        let status = login_status(&app, "attempt").await.unwrap();
        assert_eq!(status.status, LoginState::Failed);
        assert!(app.pending_auth_exchange.lock().is_none());
    }

    #[tokio::test]
    async fn abort_login_resources_stops_server_and_drops_queued_code() {
        let temp = tempfile::tempdir().unwrap();
        let app = Arc::new(AppState::new(temp.path().to_path_buf(), "test-token".into()).unwrap());
        let (tx, rx) = oneshot::channel();
        app.register_login_shutdown("attempt".into(), tx);
        *app.pending_auth_exchange.lock() = Some(crate::state::PendingAuthExchange {
            attempt_id: "attempt".into(),
            provider: Provider::Openai,
            label: "Test".into(),
            reconnect_account_id: None,
            code: "single-use-code".into(),
            verifier: "verifier".into(),
            expected_state: "state".into(),
            redirect_uri: "http://localhost:1455/auth/callback".into(),
        });

        app.abort_login_resources("attempt");
        assert!(app.pending_auth_exchange.lock().is_none());
        assert!(rx.await.is_ok());
    }

    #[tokio::test]
    async fn rejects_start_login_when_another_login_in_progress() {
        let temp = tempfile::tempdir().unwrap();
        let app = Arc::new(AppState::new(temp.path().to_path_buf(), "test-token".into()).unwrap());

        for status in [
            LoginState::Waiting,
            LoginState::ChooseProject,
            LoginState::MonitoringDisabled,
        ] {
            *app.pending_login.write() = Some(LoginStatus {
                attempt_id: "active-attempt".into(),
                status,
                message: None,
                account: None,
                projects: None,
                selected_project_id: None,
            });

            let result =
                start_login(app.clone(), "Test".into(), Provider::Openai, None, None).await;
            assert!(result.is_err());
            assert_eq!(
                result.unwrap_err(),
                "Another provider login is already in progress."
            );
        }
    }

    #[test]
    fn only_timeouts_among_http_statuses_are_worth_retrying() {
        use reqwest::StatusCode;
        for status in [StatusCode::REQUEST_TIMEOUT, StatusCode::GATEWAY_TIMEOUT] {
            let error = ExchangeError::from_status("late".into(), status);
            assert!(error.is_retryable(), "{status}");
        }
        for status in [
            StatusCode::BAD_REQUEST,
            StatusCode::UNAUTHORIZED,
            StatusCode::TOO_MANY_REQUESTS,
            StatusCode::INTERNAL_SERVER_ERROR,
            StatusCode::BAD_GATEWAY,
            StatusCode::SERVICE_UNAVAILABLE,
        ] {
            let error = ExchangeError::from_status("no".into(), status);
            assert_eq!(error, ExchangeError::Failed("no".into()), "{status}");
        }
    }

    #[test]
    fn plain_messages_are_failures_that_are_not_retried() {
        let error: ExchangeError = "Invalid OpenAI token response".into();
        assert!(!error.is_retryable());
        assert_eq!(error.message(), "Invalid OpenAI token response");
        assert_eq!(ExchangeError::from("x".to_string()).into_message(), "x");
    }

    #[test]
    fn wording_that_means_the_network_got_in_the_way_is_recognized() {
        for text in [
            "error sending request: dns error: failed to lookup address",
            "No address associated with hostname",
            "tcp connect error: Connection refused (os error 111)",
            "connection reset by peer while connecting",
            "Network is unreachable",
            "operation timed out",
            "request timeout",
        ] {
            assert!(looks_unreachable(text), "{text}");
        }
        for text in [
            "invalid_grant",
            "Invalid OpenAI token response: expected value",
            "Account label is required.",
        ] {
            assert!(!looks_unreachable(text), "{text}");
        }
    }

    #[tokio::test]
    async fn a_refused_connection_is_unreachable_and_a_malformed_request_is_not() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/token", listener.local_addr().unwrap());
        drop(listener);
        let refused = reqwest::Client::new().post(&url).send().await.unwrap_err();
        let error = ExchangeError::from_send("Acme token exchange failed", &refused);
        assert!(error.is_retryable());
        assert!(error.message().starts_with("Acme token exchange failed: "));

        let malformed = reqwest::Client::new()
            .post("not a url")
            .send()
            .await
            .unwrap_err();
        assert!(!ExchangeError::from_send("Acme token exchange failed", &malformed).is_retryable());
    }

    #[tokio::test]
    async fn a_request_that_times_out_is_unreachable() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/token", listener.local_addr().unwrap());
        // Accepts the connection but never answers.
        let _hold = tokio::spawn(async move {
            let _socket = listener.accept().await;
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
        });
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_millis(100))
            .build()
            .unwrap();
        let timed_out = client.post(&url).send().await.unwrap_err();
        assert!(ExchangeError::from_send("Acme token exchange failed", &timed_out).is_retryable());
    }

    /// Sign-in failure messages are shown to the user, so a provider reply that
    /// fails to parse must not be echoed into them: serde's error text can quote
    /// the reply. The refresh path already uses fixed sentences; this keeps the
    /// login paths the same.
    #[test]
    fn login_response_parse_errors_do_not_echo_the_reply() {
        for (file, source) in [
            ("oauth.rs", include_str!("oauth.rs")),
            (
                "google_ai_studio_oauth.rs",
                include_str!("google_ai_studio_oauth.rs"),
            ),
        ] {
            for (number, line) in source.lines().enumerate() {
                let parse_message = line.contains("format!(\"Invalid ")
                    || line.contains("format!(\"Google returned");
                assert!(
                    !(parse_message && line.contains("{error}")),
                    "{file}:{}: {}",
                    number + 1,
                    line.trim()
                );
            }
        }
    }

    #[tokio::test]
    async fn a_callback_without_this_attempts_state_changes_nothing() {
        let temp = tempfile::tempdir().unwrap();
        let app = Arc::new(AppState::new(temp.path().to_path_buf(), "test-token".into()).unwrap());
        *app.pending_login.write() = Some(LoginStatus {
            attempt_id: "attempt".into(),
            status: LoginState::Waiting,
            message: None,
            account: None,
            projects: None,
            selected_project_id: None,
        });
        let context = Arc::new(reconnect_context(app.clone(), None)); // state "s"
        let query = |state: Option<&str>| CallbackQuery {
            code: None,
            state: state.map(str::to_string),
            error: Some("access_denied".into()),
            error_description: Some("Your session expired, sign in at evil.example".into()),
        };

        // Requests without the attempt's state: no claim, no failure, no text.
        for state in [None, Some("wrong")] {
            let _ = handle_callback(context.clone(), query(state)).await;
            assert!(!context
                .callback_claimed
                .load(std::sync::atomic::Ordering::SeqCst));
            assert!(app.login_is_waiting("attempt"));
        }

        // The provider's own error redirect still ends the attempt.
        let _ = handle_callback(context.clone(), query(Some("s"))).await;
        assert!(context
            .callback_claimed
            .load(std::sync::atomic::Ordering::SeqCst));
        let status = app.pending_login.read().clone().unwrap();
        assert_eq!(status.status, LoginState::Failed);
        assert_eq!(
            status.message.as_deref(),
            Some("Your session expired, sign in at evil.example"),
            "only the provider's own redirect may set the message"
        );
    }

    #[test]
    fn a_token_response_does_not_print_its_tokens() {
        let response: OAuthTokenResponse = serde_json::from_str(
            r#"{"access_token":"SECRET_ACCESS","refresh_token":"SECRET_REFRESH","id_token":"SECRET_ID","expires_in":3600}"#,
        )
        .unwrap();
        let text = format!("{response:?}");
        assert!(!text.contains("SECRET"), "{text}");
        assert!(text.contains("3600"), "{text}");
    }
}

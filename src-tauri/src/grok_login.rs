use crate::{
    model::{now_rfc3339, Account, GrokSecret, LoginStart, LoginStatus, Provider, ProviderSecret},
    providers::{
        self,
        grok::normalize_cookie_header,
        ProviderError,
    },
    state::AppState,
    usage,
};
use chrono::{Duration as ChronoDuration, Utc};
use std::{
    collections::BTreeMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};
use tauri::{
    AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};
use url::Url;
use uuid::Uuid;

const LOGIN_WINDOW_LABEL: &str = "grok-login";
const LOGIN_URL: &str = "https://accounts.x.ai/";
const LOGIN_TIMEOUT_MINUTES: i64 = 10;
const COOKIE_POLL_INTERVAL_MS: u64 = 750;
const COOKIE_POLL_ATTEMPTS: usize = 800;
const GROK_BROWSER_ACCOUNT_ID: &str = "grok-browser-session";

const CONNECT_BANNER_SCRIPT: &str = r#"
(() => {
  if (window.top !== window || (!window.location.hostname.endsWith('grok.com') && !window.location.hostname.endsWith('x.ai'))) return;

  const installBanner = () => {
    if (!document.body || document.getElementById('ai-tracker-grok-connect-banner')) return;
    const banner = document.createElement('div');
    banner.id = 'ai-tracker-grok-connect-banner';
    banner.setAttribute('role', 'status');
    banner.textContent = 'AI Usage Tracker: Sign in to Grok. This private window closes automatically after your provider-reported weekly usage is detected.';
    Object.assign(banner.style, {
      position: 'fixed',
      top: '0',
      left: '0',
      right: '0',
      zIndex: '2147483647',
      boxSizing: 'border-box',
      padding: 'max(28px, calc(env(safe-area-inset-top, 0px) + 10px)) 18px 12px 18px',
      background: '#211936',
      color: '#f7f4ff',
      borderBottom: '1px solid #7c52d9',
      fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif',
      fontSize: '14px',
      fontWeight: '650',
      lineHeight: '1.45',
      textAlign: 'center',
      boxShadow: '0 8px 24px rgba(0, 0, 0, .3)'
    });
    document.body.prepend(banner);
    const height = Math.ceil(banner.getBoundingClientRect().height);
    const padding = Number.parseFloat(getComputedStyle(document.body).paddingTop) || 0;
    document.body.style.paddingTop = `${padding + height}px`;
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', installBanner, { once: true });
  } else {
    installBanner();
  }
})();
"#;

/// Add a Grok account from a manually supplied cookie header (no WebView).
pub async fn add_account(
    state: Arc<AppState>,
    label: String,
    cookie_header: String,
) -> Result<Account, String> {
    let probe = providers::grok::probe_cookie(state.as_ref(), &cookie_header)
        .await
        .map_err(|error| match error {
            ProviderError::Auth => {
                "The cookie does not contain a valid Grok session. Sign in to grok.com in your browser and try again.".to_string()
            }
            ProviderError::Transient(message) => format!(
                "Grok's Usage service did not return readable billing data: {message}"
            ),
        })?;

    let duplicate = state
        .store
        .find_duplicate(&Provider::Grok, Some(GROK_BROWSER_ACCOUNT_ID), None)
        .or_else(|| {
            let requested_label = label.trim();
            state.store.list().into_iter().find(|account| {
                account.provider == Provider::Grok
                    && !requested_label.is_empty()
                    && account.label.eq_ignore_ascii_case(requested_label)
            })
        });
    let now = now_rfc3339();
    let account_id = duplicate
        .as_ref()
        .map(|account| account.id.clone())
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let account = Account {
        id: account_id.clone(),
        label: if label.trim().is_empty() {
            duplicate
                .as_ref()
                .and_then(|account| account.email.clone())
                .unwrap_or_else(|| "Grok".into())
        } else {
            label.trim().to_string()
        },
        provider: Provider::Grok,
        email: probe
            .email
            .clone()
            .or_else(|| duplicate.as_ref().and_then(|account| account.email.clone())),
        provider_account_id: Some(GROK_BROWSER_ACCOUNT_ID.into()),
        chatgpt_account_id: None,
        plan: probe
            .plan
            .clone()
            .or_else(|| Some("Grok".into())),
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

    let normalized_cookie =
        normalize_cookie_header(&cookie_header).map_err(|error| error.to_string())?;
    state
        .persist_connected_account(
            account,
            &ProviderSecret::Grok(GrokSecret {
                cookie_header: Some(normalized_cookie),
                auth_file: None,
            }),
        )
        .await
        .map_err(|error| format!("Unable to save the Grok connection: {error}"))?;

    let account = match usage::refresh_account(state.clone(), &account_id).await {
        Ok(account) => account,
        Err(_) => state
            .store
            .get(&account_id)
            .ok_or_else(|| "The Grok account disappeared after saving.".to_string())?,
    };

    Ok(account)
}

pub async fn start_login(state: Arc<AppState>, label: String) -> Result<LoginStart, String> {
    let attempt_id = Uuid::new_v4().to_string();
    {
        let mut pending = state.pending_login.write();
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
            message: Some(
                "Sign in to Grok in the private window. The tracker will close it after the Usage service recognizes your session."
                    .into(),
            ),
            account: None,
            projects: None,
            selected_project_id: None,
        });
    }

    let app = match state.app_handle.read().clone() {
        Some(app) => app,
        None => {
            let mut pending = state.pending_login.write();
            if pending.as_ref().is_some_and(|login| login.attempt_id == attempt_id) {
                *pending = None;
            }
            return Err("The desktop application is not ready to open Grok login.".to_string());
        }
    };
    if let Some(window) = app.get_webview_window(LOGIN_WINDOW_LABEL) {
        close_login_window(&window);
    }

    let expires_at = (Utc::now() + ChronoDuration::minutes(LOGIN_TIMEOUT_MINUTES)).to_rfc3339();
    let login_url = match Url::parse(LOGIN_URL) {
        Ok(url) => url,
        Err(error) => {
            let mut pending = state.pending_login.write();
            if pending.as_ref().is_some_and(|login| login.attempt_id == attempt_id) {
                *pending = None;
            }
            return Err(error.to_string());
        }
    };
    let (width, height) = login_window_size(&app);
    #[allow(unused_mut)]
    let mut builder = WebviewWindowBuilder::new(
        &app,
        LOGIN_WINDOW_LABEL,
        WebviewUrl::External(login_url),
    )
    .title("Connect Grok")
    .inner_size(width, height)
    .min_inner_size(820.0, 620.0)
    .resizable(true)
    .incognito(true)
    .devtools(false)
    .initialization_script(CONNECT_BANNER_SCRIPT)
    .on_navigation(|url| {
        url.scheme() == "https" || url.as_str() == "about:blank"
    });

    #[cfg(desktop)]
    {
        builder = builder.center();
    }

    let login_window = match builder.build()
    {
        Ok(window) => window,
        Err(error) => {
            let mut pending = state.pending_login.write();
            if pending.as_ref().is_some_and(|login| login.attempt_id == attempt_id) {
                *pending = None;
            }
            return Err(format!("Unable to open the Grok login window: {error}"));
        }
    };

    start_cookie_poll(
        login_window.clone(),
        state.clone(),
        attempt_id.clone(),
        label,
    );

    let close_state = state.clone();
    let close_attempt = attempt_id.clone();
    login_window.on_window_event(move |event| {
        if matches!(event, WindowEvent::CloseRequested { .. }) {
            fail_if_waiting(
                &close_state,
                &close_attempt,
                "Grok login was cancelled.".into(),
            );
        }
    });

    let timeout_state = state.clone();
    let timeout_attempt = attempt_id.clone();
    let timeout_app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(
            (LOGIN_TIMEOUT_MINUTES * 60) as u64,
        ))
        .await;
        if is_waiting(&timeout_state, &timeout_attempt) {
            fail_if_waiting(
                &timeout_state,
                &timeout_attempt,
                "Grok login timed out. Start the connection again.".into(),
            );
            if let Some(window) = timeout_app.get_webview_window(LOGIN_WINDOW_LABEL) {
                close_login_window(&window);
            }
        }
    });

    Ok(LoginStart {
        attempt_id,
        authorization_url: String::new(),
        expires_at,
    })
}

fn start_cookie_poll(
    window: WebviewWindow,
    state: Arc<AppState>,
    attempt_id: String,
    label: String,
) {
    let capture_in_flight = Arc::new(AtomicBool::new(false));
    std::thread::spawn(move || {
        let mut last_attempted_header: Option<String> = None;
        for _ in 0..COOKIE_POLL_ATTEMPTS {
            if !is_waiting(&state, &attempt_id) {
                break;
            }

            if !capture_in_flight.load(Ordering::SeqCst) {
                if let Ok(cookie_header) = read_cookie_header(&window) {
                    let changed = last_attempted_header.as_deref() != Some(cookie_header.as_str());
                    if changed && !capture_in_flight.swap(true, Ordering::SeqCst) {
                        last_attempted_header = Some(cookie_header.clone());
                        let completion_state = state.clone();
                        let completion_attempt = attempt_id.clone();
                        let completion_label = label.clone();
                        let completion_window = window.clone();
                        let completion_flag = capture_in_flight.clone();
                        tauri::async_runtime::spawn(async move {
                            complete_cookie_login(
                                completion_state,
                                completion_attempt,
                                completion_label,
                                cookie_header,
                                completion_window,
                                completion_flag,
                            )
                            .await;
                        });
                    }
                }
            }

            std::thread::sleep(Duration::from_millis(COOKIE_POLL_INTERVAL_MS));
        }
    });
}

async fn complete_cookie_login(
    state: Arc<AppState>,
    attempt_id: String,
    label: String,
    cookie_header: String,
    window: WebviewWindow,
    capture_in_flight: Arc<AtomicBool>,
) {
    if !is_waiting(&state, &attempt_id) {
        return;
    }

    let probe = providers::grok::probe_cookie(state.as_ref(), &cookie_header).await;
    let usage = match probe {
        Ok(usage) => usage,
        Err(ProviderError::Auth) => {
            capture_in_flight.store(false, Ordering::SeqCst);
            // If the user signed in on accounts.x.ai, navigate to grok.com to establish the session
            if let Ok(current_url) = window.url() {
                let current_str = current_url.as_str();
                if current_str.contains("accounts.x.ai") || current_str.contains("x.ai") {
                    if cookie_header.contains("sso")
                        || cookie_header.contains("auth_token")
                        || cookie_header.contains("jwt")
                    {
                        if let Ok(grok_target) = Url::parse("https://grok.com/?_s=usage") {
                            let _ = window.navigate(grok_target);
                        }
                    }
                }
            }
            update_waiting_message(
                &state,
                &attempt_id,
                "Finish signing in to Grok. Waiting for an authenticated browser session…".into(),
            );
            return;
        }
        Err(ProviderError::Transient(error)) => {
            capture_in_flight.store(false, Ordering::SeqCst);
            update_waiting_message(
                &state,
                &attempt_id,
                format!(
                    "Grok is signed in, but its Usage service did not return readable billing data: {error} Reload the Grok page to retry."
                ),
            );
            return;
        }
    };

    if !is_waiting(&state, &attempt_id) {
        close_login_window(&window);
        return;
    }

    let duplicate = state
        .store
        .find_duplicate(&Provider::Grok, Some(GROK_BROWSER_ACCOUNT_ID), None)
        .or_else(|| {
            let requested_label = label.trim();
            state.store.list().into_iter().find(|account| {
                account.provider == Provider::Grok
                    && !requested_label.is_empty()
                    && account.label.eq_ignore_ascii_case(requested_label)
            })
        });
    let now = now_rfc3339();
    let account_id = duplicate
        .as_ref()
        .map(|account| account.id.clone())
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let account = Account {
        id: account_id.clone(),
        label: if label.trim().is_empty() {
            duplicate
                .as_ref()
                .and_then(|account| account.email.clone())
                .unwrap_or_else(|| "Grok".into())
        } else {
            label.trim().to_string()
        },
        provider: Provider::Grok,
        email: usage
            .email
            .clone()
            .or_else(|| duplicate.as_ref().and_then(|account| account.email.clone())),
        provider_account_id: Some(GROK_BROWSER_ACCOUNT_ID.into()),
        chatgpt_account_id: None,
        plan: usage
            .plan
            .clone()
            .or_else(|| Some("Grok".into())),
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

    let normalized_cookie = match normalize_cookie_header(&cookie_header) {
        Ok(value) => value,
        Err(error) => {
            fail_if_waiting(&state, &attempt_id, error);
            close_login_window(&window);
            return;
        }
    };
    if let Err(error) = state
        .persist_connected_account(
            account,
            &ProviderSecret::Grok(GrokSecret {
                cookie_header: Some(normalized_cookie),
                auth_file: None,
            }),
        )
        .await
    {
        fail_if_waiting(
            &state,
            &attempt_id,
            format!("Unable to save the Grok connection: {error}"),
        );
        close_login_window(&window);
        return;
    }

    let account = match usage::refresh_account(state.clone(), &account_id).await {
        Ok(account) => account,
        Err(_) => match state.store.get(&account_id) {
            Some(account) => account,
            None => {
                fail_if_waiting(
                    &state,
                    &attempt_id,
                    "The Grok account disappeared after login.".into(),
                );
                close_login_window(&window);
                return;
            }
        },
    };

    let completed = {
        let mut pending = state.pending_login.write();
        if pending
            .as_ref()
            .is_some_and(|login| login.attempt_id == attempt_id && login.status == "waiting")
        {
            *pending = Some(LoginStatus {
                attempt_id,
                status: "complete".into(),
                message: None,
                account: Some(account),
                projects: None,
                selected_project_id: None,
            });
            true
        } else {
            false
        }
    };
    if completed {
        close_login_window(&window);
    }
}

fn close_login_window(window: &WebviewWindow) {
    let _ = window.close();
    let _ = window.destroy();
}

fn read_cookie_header(window: &WebviewWindow) -> Result<String, String> {
    let mut pairs = BTreeMap::new();
    let targets = [
        "https://grok.com/",
        "https://grok.com/?_s=usage",
        "https://accounts.x.ai/",
        "https://x.ai/",
        "https://auth.x.ai/",
        "https://api.x.ai/",
        "https://x.com/",
    ];
    if let Ok(current_url) = window.url() {
        if let Ok(target) = Url::parse(current_url.as_str()) {
            if let Ok(cookies) = window.cookies_for_url(target) {
                for cookie in cookies {
                    let value = cookie.value().trim();
                    if !value.is_empty() {
                        pairs.insert(cookie.name().to_string(), value.to_string());
                    }
                }
            }
        }
    }
    for target in targets {
        if let Ok(url) = Url::parse(target) {
            if let Ok(cookies) = window.cookies_for_url(url) {
                for cookie in cookies {
                    let value = cookie.value().trim();
                    if !value.is_empty() {
                        pairs.insert(cookie.name().to_string(), value.to_string());
                    }
                }
            }
        }
    }
    let header = pairs
        .into_iter()
        .map(|(name, value)| format!("{name}={value}"))
        .collect::<Vec<_>>()
        .join("; ");
    normalize_cookie_header(&header)
}

fn is_waiting(state: &AppState, attempt_id: &str) -> bool {
    state
        .pending_login
        .read()
        .as_ref()
        .is_some_and(|login| login.attempt_id == attempt_id && login.status == "waiting")
}

fn update_waiting_message(state: &AppState, attempt_id: &str, message: String) {
    if !is_waiting(state, attempt_id) {
        return;
    }
    *state.pending_login.write() = Some(LoginStatus {
        attempt_id: attempt_id.into(),
        status: "waiting".into(),
        message: Some(message),
        account: None,
        projects: None,
        selected_project_id: None,
    });
}

fn fail_if_waiting(state: &AppState, attempt_id: &str, message: String) {
    if !is_waiting(state, attempt_id) {
        return;
    }
    *state.pending_login.write() = Some(LoginStatus {
        attempt_id: attempt_id.into(),
        status: "failed".into(),
        message: Some(message),
        account: None,
        projects: None,
        selected_project_id: None,
    });
}

fn login_window_size(app: &AppHandle) -> (f64, f64) {
    let Some(monitor) = app.primary_monitor().ok().flatten() else {
        return (1080.0, 760.0);
    };
    let scale = monitor.scale_factor();
    let size = monitor.size();
    let width = (f64::from(size.width) / scale * 0.82).clamp(900.0, 1280.0);
    let height = (f64::from(size.height) / scale * 0.82).clamp(680.0, 900.0);
    (width, height)
}

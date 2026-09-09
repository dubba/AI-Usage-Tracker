use crate::{
    model::{now_rfc3339, Account, GrokSecret, LoginStart, LoginStatus, Provider, ProviderSecret},
    providers::{
        self,
        grok::{
            has_grok_session_cookie, is_allowed_cookie_host, normalize_cookie_header,
            GROK_COOKIE_URLS,
        },
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
use tauri::{AppHandle, WebviewWindow};
#[cfg(desktop)]
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use url::Url;
use uuid::Uuid;

#[cfg(desktop)]
const LOGIN_WINDOW_LABEL: &str = "grok-login";
const LOGIN_URL: &str = "https://accounts.x.ai/sign-in?redirect_uri=https%3A%2F%2Fgrok.com%2F";
const LOGIN_TIMEOUT_MINUTES: i64 = 10;
const COOKIE_POLL_INTERVAL_MS: u64 = 750;
const COOKIE_POLL_ATTEMPTS: usize = 800;

#[cfg(desktop)]
const CONNECT_BANNER_SCRIPT: &str = r#"
(() => {
  if (window.top !== window || !window.location.hostname.endsWith('grok.com')) return;

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

fn default_grok_label(state: &AppState, email: Option<&str>) -> String {
    if let Some(email) = email {
        let trimmed = email.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    let existing_grok_count = state
        .store
        .list()
        .into_iter()
        .filter(|account| account.provider == Provider::Grok)
        .count();
    if existing_grok_count == 0 {
        "Grok".into()
    } else {
        format!("Grok {}", existing_grok_count + 1)
    }
}

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
        .find_duplicate(
            &Provider::Grok,
            probe.provider_account_id.as_deref(),
            probe.email.as_deref(),
        )
        .or_else(|| {
            let requested_label = label.trim();
            if requested_label.is_empty() {
                None
            } else {
                state.store.list().into_iter().find(|account| {
                    account.provider == Provider::Grok
                        && account.label.eq_ignore_ascii_case(requested_label)
                })
            }
        });
    let now = now_rfc3339();
    let account_id = duplicate
        .as_ref()
        .map(|account| account.id.clone())
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let provider_account_id = probe
        .provider_account_id
        .clone()
        .or_else(|| probe.email.clone())
        .or_else(|| duplicate.as_ref().and_then(|account| account.provider_account_id.clone()))
        .or_else(|| Some(Uuid::new_v4().to_string()));
    let account = Account {
        id: account_id.clone(),
        label: if label.trim().is_empty() {
            duplicate
                .as_ref()
                .map(|account| account.label.clone())
                .unwrap_or_else(|| default_grok_label(state.as_ref(), probe.email.as_deref()))
        } else {
            label.trim().to_string()
        },
        provider: Provider::Grok,
        email: probe
            .email
            .clone()
            .or_else(|| duplicate.as_ref().and_then(|account| account.email.clone())),
        provider_account_id,
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
            return Err("The application is not ready to open Grok login.".to_string());
        }
    };

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

    #[cfg(mobile)]
    {
        return start_mobile_login(app, state, attempt_id, label, login_url, expires_at).await;
    }

    #[cfg(desktop)]
    {
    if let Some(window) = app.get_webview_window(LOGIN_WINDOW_LABEL) {
        close_login_window(&window);
    }

    let temp_data_dir = std::env::temp_dir().join(format!("ai-usage-grok-{}", attempt_id));
    let _ = std::fs::create_dir_all(&temp_data_dir);

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
    .data_directory(temp_data_dir.clone())
    .devtools(false)
    .initialization_script(CONNECT_BANNER_SCRIPT)
    .user_agent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Safari/605.1.15")
    .on_navigation(is_allowed_login_navigation);

    builder = builder.center();

    let login_window = match builder.build()
    {
        Ok(window) => window,
        Err(error) => {
            let _ = std::fs::remove_dir_all(&temp_data_dir);
            let mut pending = state.pending_login.write();
            if pending.as_ref().is_some_and(|login| login.attempt_id == attempt_id) {
                *pending = None;
            }
            return Err(format!("Unable to open the Grok login window: {error}"));
        }
    };

    let cleanup_dir = temp_data_dir.clone();
    start_cookie_poll(
        login_window.clone(),
        state.clone(),
        attempt_id.clone(),
        label,
        Some(cleanup_dir),
    );

    let close_state = state.clone();
    let close_attempt = attempt_id.clone();
    let close_dir = temp_data_dir.clone();
    login_window.on_window_event(move |event| {
        if matches!(event, WindowEvent::CloseRequested { .. }) {
            let _ = std::fs::remove_dir_all(&close_dir);
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
    let timeout_dir = temp_data_dir.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(
            (LOGIN_TIMEOUT_MINUTES * 60) as u64,
        ))
        .await;
        if is_waiting(&timeout_state, &timeout_attempt) {
            let _ = std::fs::remove_dir_all(&timeout_dir);
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
}

#[cfg(mobile)]
async fn start_mobile_login(
    app: AppHandle,
    state: Arc<AppState>,
    attempt_id: String,
    label: String,
    login_url: Url,
    expires_at: String,
) -> Result<LoginStart, String> {
    {
        let mut pending = state.pending_login.write();
        if pending
            .as_ref()
            .is_some_and(|login| login.attempt_id == attempt_id)
        {
            pending.as_mut().unwrap().message = Some(
                "Sign in to Grok. The app returns here after your weekly usage is detected.".into(),
            );
        }
    }

    let window = match crate::mobile_auth::main_window(&app) {
        Ok(window) => window,
        Err(error) => {
            clear_pending(&state, &attempt_id);
            return Err(error);
        }
    };
    start_cookie_poll(
        window,
        state.clone(),
        attempt_id.clone(),
        label,
        None,
    );
    if let Err(error) = crate::mobile_auth::open_in_main_webview(
        app,
        state.clone(),
        attempt_id.clone(),
        login_url,
        |_| {},
    ) {
        clear_pending(&state, &attempt_id);
        return Err(error);
    }

    let timeout_state = state.clone();
    let timeout_attempt = attempt_id.clone();
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
        }
    });

    Ok(LoginStart {
        attempt_id,
        authorization_url: String::new(),
        expires_at,
    })
}

#[cfg(mobile)]
fn clear_pending(state: &AppState, attempt_id: &str) {
    let mut pending = state.pending_login.write();
    if pending
        .as_ref()
        .is_some_and(|login| login.attempt_id == attempt_id)
    {
        *pending = None;
    }
}

fn start_cookie_poll(
    window: WebviewWindow,
    state: Arc<AppState>,
    attempt_id: String,
    label: String,
    temp_data_dir: Option<std::path::PathBuf>,
) {
    let capture_in_flight = Arc::new(AtomicBool::new(false));
    std::thread::spawn(move || {
        let mut last_attempted_header: Option<String> = None;
        for _ in 0..COOKIE_POLL_ATTEMPTS {
            if !is_waiting(&state, &attempt_id) {
                if let Some(dir) = &temp_data_dir {
                    let _ = std::fs::remove_dir_all(dir);
                }
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
                        let completion_dir = temp_data_dir.clone();
                        tauri::async_runtime::spawn(async move {
                            complete_cookie_login(
                                completion_state,
                                completion_attempt,
                                completion_label,
                                cookie_header,
                                completion_window,
                                completion_flag,
                                completion_dir,
                            )
                            .await;
                        });
                    }
                }
            }

            std::thread::sleep(Duration::from_millis(COOKIE_POLL_INTERVAL_MS));
        }
        if let Some(dir) = &temp_data_dir {
            let _ = std::fs::remove_dir_all(dir);
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
    temp_data_dir: Option<std::path::PathBuf>,
) {
    if !is_waiting(&state, &attempt_id) {
        if let Some(dir) = &temp_data_dir {
            let _ = std::fs::remove_dir_all(dir);
        }
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
                    if has_grok_session_cookie(&cookie_header) {
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
        if let Some(dir) = &temp_data_dir {
            let _ = std::fs::remove_dir_all(dir);
        }
        close_login_window(&window);
        return;
    }

    let duplicate = state
        .store
        .find_duplicate(
            &Provider::Grok,
            usage.provider_account_id.as_deref(),
            usage.email.as_deref(),
        )
        .or_else(|| {
            let requested_label = label.trim();
            if requested_label.is_empty() {
                None
            } else {
                state.store.list().into_iter().find(|account| {
                    account.provider == Provider::Grok
                        && account.label.eq_ignore_ascii_case(requested_label)
                })
            }
        });
    let now = now_rfc3339();
    let account_id = duplicate
        .as_ref()
        .map(|account| account.id.clone())
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let provider_account_id = usage
        .provider_account_id
        .clone()
        .or_else(|| usage.email.clone())
        .or_else(|| duplicate.as_ref().and_then(|account| account.provider_account_id.clone()))
        .or_else(|| Some(Uuid::new_v4().to_string()));
    let account = Account {
        id: account_id.clone(),
        label: if label.trim().is_empty() {
            duplicate
                .as_ref()
                .map(|account| account.label.clone())
                .unwrap_or_else(|| default_grok_label(state.as_ref(), usage.email.as_deref()))
        } else {
            label.trim().to_string()
        },
        provider: Provider::Grok,
        email: usage
            .email
            .clone()
            .or_else(|| duplicate.as_ref().and_then(|account| account.email.clone())),
        provider_account_id,
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
            if let Some(dir) = &temp_data_dir {
                let _ = std::fs::remove_dir_all(dir);
            }
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
        if let Some(dir) = &temp_data_dir {
            let _ = std::fs::remove_dir_all(dir);
        }
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
                if let Some(dir) = &temp_data_dir {
                    let _ = std::fs::remove_dir_all(dir);
                }
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
        if let Some(dir) = &temp_data_dir {
            let _ = std::fs::remove_dir_all(dir);
        }
        close_login_window(&window);
    }
}

fn close_login_window(window: &WebviewWindow) {
    crate::mobile_auth::dismiss_login_window(window);
}

/// Restrict the private login window to Grok/X sign-in hosts (plus the SSO
/// providers they let you sign in with). Prevents a link or open redirect on a
/// sign-in page from steering our cookie-capture window to an arbitrary site
/// that could run scripts able to observe credentials.
#[cfg(desktop)]
fn is_allowed_login_navigation(url: &Url) -> bool {
    if url.as_str() == "about:blank" || url.scheme() == "blob" {
        return true;
    }
    if url.scheme() != "https" {
        return false;
    }
    let Some(host) = url.host_str().map(str::to_ascii_lowercase) else {
        return false;
    };
    host == "grok.com"
        || host.ends_with(".grok.com")
        || host == "x.ai"
        || host.ends_with(".x.ai")
        || host == "xai.com"
        || host.ends_with(".xai.com")
        || host == "x.com"
        || host.ends_with(".x.com")
        || host == "twitter.com"
        || host.ends_with(".twitter.com")
        || host == "t.co"
        || host.ends_with(".t.co")
        || host == "twimg.com"
        || host.ends_with(".twimg.com")
        || host == "cloudflare.com"
        || host.ends_with(".cloudflare.com")
        || host == "challenges.cloudflare.com"
        || host == "arkoselabs.com"
        || host.ends_with(".arkoselabs.com")
        || host == "hcaptcha.com"
        || host.ends_with(".hcaptcha.com")
        || host == "recaptcha.net"
        || host.ends_with(".recaptcha.net")
        || host == "google.com"
        || host.ends_with(".google.com")
        || host == "gstatic.com"
        || host.ends_with(".gstatic.com")
        || host == "apple.com"
        || host.ends_with(".apple.com")
        || host == "appleid.apple.com"
        || host == "auth0.com"
        || host.ends_with(".auth0.com")
        || host == "okta.com"
        || host.ends_with(".okta.com")
}

fn read_cookie_header(window: &WebviewWindow) -> Result<String, String> {
    let mut pairs = BTreeMap::new();
    if let Ok(current_url) = window.url() {
        collect_cookies_for_url(window, &current_url, &mut pairs);
    }
    for target in GROK_COOKIE_URLS {
        if let Ok(url) = Url::parse(target) {
            collect_cookies_for_url(window, &url, &mut pairs);
        }
    }
    let header = pairs
        .into_iter()
        .map(|(name, value)| format!("{name}={value}"))
        .collect::<Vec<_>>()
        .join("; ");
    normalize_cookie_header(&header)
}

fn collect_cookies_for_url(
    window: &WebviewWindow,
    url: &Url,
    pairs: &mut BTreeMap<String, String>,
) {
    let Some(host) = url.host_str() else {
        return;
    };
    if !is_allowed_cookie_host(host) {
        return;
    }
    let Ok(cookies) = window.cookies_for_url(url.clone()) else {
        return;
    };
    for cookie in cookies {
        let value = cookie.value().trim();
        if value.is_empty() {
            continue;
        }
        pairs.insert(cookie.name().to_string(), value.to_string());
    }
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

#[cfg(desktop)]
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn login_window_navigation_is_host_allowlisted() {
        for allowed in [
            "https://accounts.x.ai/sign-in",
            "https://grok.com/?_s=usage",
            "https://accounts.google.com/o/oauth2/auth?client_id=x",
            "https://appleid.apple.com/auth/authorize",
        ] {
            let url = Url::parse(allowed).unwrap();
            assert!(is_allowed_login_navigation(&url), "{allowed}");
        }
        for blocked in [
            "https://evil.com/phish",
            "https://grok.com.evil.com/",
            "http://accounts.x.ai/sign-in",
            "javascript:alert(1)",
        ] {
            let url = Url::parse(blocked).unwrap();
            assert!(!is_allowed_login_navigation(&url), "{blocked}");
        }
    }

    #[test]
    fn default_grok_label_handles_empty_and_numbered_accounts() {
        let temp = tempfile::tempdir().unwrap();
        let state = AppState::new(temp.path().to_path_buf(), "test-token".into()).unwrap();
        assert_eq!(default_grok_label(&state, Some("user@example.com")), "user@example.com");
        assert_eq!(default_grok_label(&state, None), "Grok");
    }
}

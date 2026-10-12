use crate::{
    model::{
        now_rfc3339, Account, GrokSecret, LoginStart, LoginState, LoginStatus, Provider,
        ProviderSecret,
    },
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
#[cfg(desktop)]
const GROK_PROFILE_PREFIX: &str = "ai-usage-grok-";
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

/// Query flag the injected top-left "Back" button appends to the current
/// page. `on_navigation` intercepts it (and blocks the reload): the login
/// attempt is canceled and the window closes, so users can always exit the
/// authorization flow.
#[cfg(desktop)]
const BACK_QUERY_FLAG: &str = "ai-usage-tracker-back";

/// Top-left "Back" button for the login window, which has no browser chrome.
/// Unlike the banner it is installed on every page (including the SSO
/// hand-off hosts), because a user can get stuck on any of them.
/// Built without `innerHTML` and reattached if removed: "Continue with Google"
/// loads `accounts.google.com`, which rejects HTML assignment and drops nodes
/// it did not create.
#[cfg(desktop)]
const BACK_BUTTON_SCRIPT: &str = r#"
(() => {
  try {
    if (window.top !== window || !document.documentElement) return;
    const id = '__ai_tracker_back';
    const install = () => {
      if (!document.documentElement || document.getElementById(id)) return;
      const button = document.createElement('button');
      button.id = id;
      button.type = 'button';
      button.setAttribute('aria-label', 'Back to AI Usage Tracker');
      button.style.cssText = [
        'position:fixed', 'top:max(env(safe-area-inset-top),8px)', 'left:8px', 'z-index:2147483647',
        'display:inline-flex', 'align-items:center', 'gap:6px',
        'padding:7px 14px 7px 9px', 'border:0', 'border-radius:999px', 'background:#6d3bd7', 'color:#fff',
        'font:600 14px -apple-system,system-ui,sans-serif', 'box-shadow:0 2px 10px rgba(0,0,0,.4)',
        'cursor:pointer',
      ].join(';');
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('width', '9');
      svg.setAttribute('height', '15');
      svg.setAttribute('fill', 'none');
      svg.setAttribute('stroke', 'currentColor');
      svg.setAttribute('stroke-width', '2.5');
      svg.setAttribute('stroke-linecap', 'round');
      svg.setAttribute('stroke-linejoin', 'round');
      svg.setAttribute('aria-hidden', 'true');
      svg.style.display = 'block';
      svg.style.flex = 'none';
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', 'm15 18-6-6 6-6');
      svg.appendChild(path);
      const label = document.createElement('span');
      label.textContent = 'Back';
      button.appendChild(svg);
      button.appendChild(label);
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

#[cfg(desktop)]
fn is_back_request(url: &Url) -> bool {
    url.query_pairs()
        .any(|(key, value)| key == BACK_QUERY_FLAG && value == "1")
}

/// Last resort when neither the reconnect target nor the signed-in identity matches a
/// stored Grok account: reuse one that already carries the label the user typed.
fn grok_account_with_label(state: &AppState, label: &str) -> Option<Account> {
    let requested = label.trim();
    if requested.is_empty() {
        return None;
    }
    state.store.list().into_iter().find(|account| {
        account.provider == Provider::Grok && account.label.eq_ignore_ascii_case(requested)
    })
}

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
    let base = Provider::Grok.display_name();
    if existing_grok_count == 0 {
        base.into()
    } else {
        format!("{base} {}", existing_grok_count + 1)
    }
}

/// Add a Grok account from a manually supplied cookie header (no WebView).
pub async fn add_account(
    state: Arc<AppState>,
    label: String,
    cookie_header: String,
    reconnect_account_id: Option<String>,
) -> Result<Account, String> {
    if cookie_header.len() > crate::limits::MAX_RAW_COOKIE_INPUT_BYTES {
        return Err("The pasted cookie text is too long to be a Grok session.".into());
    }
    let probe = providers::grok::probe_cookie(state.as_ref(), &cookie_header)
        .await
        .map_err(|error| match error {
            ProviderError::Auth => {
                "The cookie does not contain a valid Grok session. Sign in to grok.com in your browser and try again.".to_string()
            }
            ProviderError::Transient(message) | ProviderError::RateLimited { message, .. } => {
                format!("Grok's Usage service did not return readable billing data: {message}")
            }
        })?;

    let duplicate = state
        .store
        .account_to_update(
            &Provider::Grok,
            reconnect_account_id.as_deref(),
            probe.provider_account_id.as_deref(),
            probe.email.as_deref(),
        )
        .or_else(|| grok_account_with_label(state.as_ref(), &label));
    let now = now_rfc3339();
    let account_id = duplicate
        .as_ref()
        .map(|account| account.id.clone())
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let provider_account_id = probe
        .provider_account_id
        .clone()
        .or_else(|| probe.email.clone())
        .or_else(|| {
            duplicate
                .as_ref()
                .and_then(|account| account.provider_account_id.clone())
        })
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
        plan: probe.plan.clone().or_else(|| Some("Grok".into())),
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

#[cfg(desktop)]
fn create_private_grok_profile_dir(attempt_id: &str) -> Result<std::path::PathBuf, String> {
    // Validate the attempt id so the joined path cannot escape the temp dir.
    if attempt_id.is_empty()
        || attempt_id.len() > 64
        || !attempt_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        return Err("Invalid login attempt.".into());
    }
    let dir = std::env::temp_dir().join(format!("{GROK_PROFILE_PREFIX}{attempt_id}"));
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Unable to prepare the private login profile: {e}"))?;
    // Owner-only (0700 / Windows ACL). Fail closed: remove the dir rather
    // than leaving a world-readable session profile behind.
    if let Err(error) = crate::fs_util::restrict_private_permissions(&dir) {
        let _ = std::fs::remove_dir_all(&dir);
        return Err(error);
    }
    Ok(dir)
}

/// Best-effort removal of stale `ai-usage-grok-*` profiles (crash-safe
/// cleanup). Only removes directories with our exact prefix in the system
/// temp dir; never follows symlinks beyond the profile root.
#[cfg(desktop)]
pub fn sweep_stale_grok_profiles() {
    let tmp = std::env::temp_dir();
    let Ok(entries) = std::fs::read_dir(&tmp) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if !name.starts_with(GROK_PROFILE_PREFIX) {
            continue;
        };
        // Guard against path traversal tricks in exotic temp-dir listings.
        if name.contains('/') || name.contains('\\') || name.contains("..") {
            continue;
        }
        let path = tmp.join(name);
        // Only remove directories (profiles), never files/symlinks.
        if let Ok(ft) = entry.file_type() {
            if !ft.is_dir() {
                continue;
            }
        }
        let _ = std::fs::remove_dir_all(&path);
    }
}

pub async fn start_login(
    state: Arc<AppState>,
    label: String,
    reconnect_account_id: Option<String>,
) -> Result<LoginStart, String> {
    let attempt_id = Uuid::new_v4().to_string();
    {
        let mut pending = state.pending_login.write();
        if pending
            .as_ref()
            .is_some_and(|login| login.status.is_in_progress())
        {
            return Err("Another provider login is already in progress.".into());
        }
        *pending = Some(LoginStatus {
            attempt_id: attempt_id.clone(),
            status: LoginState::Waiting,
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
            if pending
                .as_ref()
                .is_some_and(|login| login.attempt_id == attempt_id)
            {
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
            if pending
                .as_ref()
                .is_some_and(|login| login.attempt_id == attempt_id)
            {
                *pending = None;
            }
            return Err(crate::diagnostics::command_error(error));
        }
    };

    #[cfg(mobile)]
    {
        return start_mobile_login(
            app,
            state,
            attempt_id,
            label,
            reconnect_account_id,
            login_url,
            expires_at,
        )
        .await;
    }

    #[cfg(desktop)]
    {
        if let Some(window) = app.get_webview_window(LOGIN_WINDOW_LABEL) {
            close_login_window(&window);
        }

        // Sweep profiles left behind by a previous crash/kill before creating a
        // new one, then create the new profile as owner-only.
        sweep_stale_grok_profiles();
        let temp_data_dir = match create_private_grok_profile_dir(&attempt_id) {
            Ok(dir) => dir,
            Err(error) => {
                let mut pending = state.pending_login.write();
                if pending
                    .as_ref()
                    .is_some_and(|login| login.attempt_id == attempt_id)
                {
                    *pending = None;
                }
                return Err(error);
            }
        };

        let (width, height) = login_window_size(&app);
        let back_app = app.clone();
        let back_state = state.clone();
        let back_attempt = attempt_id.clone();
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
    .incognito(true)
    .devtools(false)
    .initialization_script(format!("{CONNECT_BANNER_SCRIPT}\n{BACK_BUTTON_SCRIPT}"))
    .user_agent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Safari/605.1.15")
    .on_navigation(move |url| {
        if is_back_request(url) {
            if let Some(window) = back_app.get_webview_window(LOGIN_WINDOW_LABEL) {
                close_login_window(&window);
            }
            back_state
                .fail_login_if_waiting(&back_attempt, "Grok login was canceled.".into());
            return false;
        }
        let allowed = is_allowed_login_navigation(url);
        if !allowed {
            crate::diagnostics::warn(&format!(
                "Grok login blocked navigation to host {}",
                url.host_str().unwrap_or("(none)")
            ));
        }
        allowed
    });

        builder = builder.center();

        let login_window = match builder.build() {
            Ok(window) => window,
            Err(error) => {
                let _ = std::fs::remove_dir_all(&temp_data_dir);
                let mut pending = state.pending_login.write();
                if pending
                    .as_ref()
                    .is_some_and(|login| login.attempt_id == attempt_id)
                {
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
            reconnect_account_id,
            Some(cleanup_dir),
        );

        let close_state = state.clone();
        let close_attempt = attempt_id.clone();
        let close_dir = temp_data_dir.clone();
        login_window.on_window_event(move |event| {
            if matches!(event, WindowEvent::CloseRequested { .. }) {
                let _ = std::fs::remove_dir_all(&close_dir);
                close_state
                    .fail_login_if_waiting(&close_attempt, "Grok login was canceled.".into());
            }
        });

        let timeout_state = state.clone();
        let timeout_attempt = attempt_id.clone();
        let timeout_app = app.clone();
        let timeout_dir = temp_data_dir.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_secs((LOGIN_TIMEOUT_MINUTES * 60) as u64)).await;
            if timeout_state.login_is_waiting(&timeout_attempt) {
                let _ = std::fs::remove_dir_all(&timeout_dir);
                timeout_state.fail_login_if_waiting(
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
    reconnect_account_id: Option<String>,
    login_url: Url,
    expires_at: String,
) -> Result<LoginStart, String> {
    {
        let mut pending = state.pending_login.write();
        if let Some(login) = pending
            .as_mut()
            .filter(|login| login.attempt_id == attempt_id)
        {
            login.message = Some(
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
    // The poll reads cookies on its first iteration, so the previous session
    // has to be gone before that thread starts. An empty jar keeps waiting.
    crate::mobile_auth::forget_provider_sign_in(&window);
    start_cookie_poll(
        window,
        state.clone(),
        attempt_id.clone(),
        label,
        reconnect_account_id,
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
        tokio::time::sleep(Duration::from_secs((LOGIN_TIMEOUT_MINUTES * 60) as u64)).await;
        if timeout_state.login_is_waiting(&timeout_attempt) {
            timeout_state.fail_login_if_waiting(
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
    reconnect_account_id: Option<String>,
    temp_data_dir: Option<std::path::PathBuf>,
) {
    let capture_in_flight = Arc::new(AtomicBool::new(false));
    std::thread::spawn(move || {
        let mut last_attempted_header: Option<String> = None;
        for _ in 0..COOKIE_POLL_ATTEMPTS {
            if !state.login_is_waiting(&attempt_id) {
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
                        let completion_reconnect = reconnect_account_id.clone();
                        let completion_window = window.clone();
                        let completion_flag = capture_in_flight.clone();
                        let completion_dir = temp_data_dir.clone();
                        tauri::async_runtime::spawn(async move {
                            complete_cookie_login(
                                completion_state,
                                completion_attempt,
                                completion_label,
                                completion_reconnect,
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

#[allow(clippy::too_many_arguments)]
async fn complete_cookie_login(
    state: Arc<AppState>,
    attempt_id: String,
    label: String,
    reconnect_account_id: Option<String>,
    cookie_header: String,
    window: WebviewWindow,
    capture_in_flight: Arc<AtomicBool>,
    temp_data_dir: Option<std::path::PathBuf>,
) {
    if !state.login_is_waiting(&attempt_id) {
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
                if is_xai_signin_host(&current_url) && has_grok_session_cookie(&cookie_header) {
                    if let Ok(grok_target) = Url::parse("https://grok.com/?_s=usage") {
                        let _ = window.navigate(grok_target);
                    }
                }
            }
            state.set_waiting_message(
                &attempt_id,
                "Finish signing in to Grok. Waiting for an authenticated browser session…".into(),
            );
            return;
        }
        Err(
            ProviderError::Transient(error) | ProviderError::RateLimited { message: error, .. },
        ) => {
            capture_in_flight.store(false, Ordering::SeqCst);
            state.set_waiting_message(
                &attempt_id,
                format!(
                    "Grok is signed in, but its Usage service did not return readable billing data: {error} Reload the Grok page to retry."
                ),
            );
            return;
        }
    };

    if !state.login_is_waiting(&attempt_id) {
        if let Some(dir) = &temp_data_dir {
            let _ = std::fs::remove_dir_all(dir);
        }
        close_login_window(&window);
        return;
    }

    let duplicate = state
        .store
        .account_to_update(
            &Provider::Grok,
            reconnect_account_id.as_deref(),
            usage.provider_account_id.as_deref(),
            usage.email.as_deref(),
        )
        .or_else(|| grok_account_with_label(state.as_ref(), &label));
    let now = now_rfc3339();
    let account_id = duplicate
        .as_ref()
        .map(|account| account.id.clone())
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let provider_account_id = usage
        .provider_account_id
        .clone()
        .or_else(|| usage.email.clone())
        .or_else(|| {
            duplicate
                .as_ref()
                .and_then(|account| account.provider_account_id.clone())
        })
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
        plan: usage.plan.clone().or_else(|| Some("Grok".into())),
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
            state.fail_login_if_waiting(&attempt_id, error);
            close_login_window(&window);
            return;
        }
    };
    if let Err(error) = state
        .persist_connected_account(
            account,
            &ProviderSecret::Grok(GrokSecret {
                cookie_header: Some(normalized_cookie),
            }),
        )
        .await
    {
        if let Some(dir) = &temp_data_dir {
            let _ = std::fs::remove_dir_all(dir);
        }
        state.fail_login_if_waiting(
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
                state.fail_login_if_waiting(
                    &attempt_id,
                    "The Grok account disappeared after login.".into(),
                );
                close_login_window(&window);
                return;
            }
        },
    };

    let completed = state.update_login_if_waiting(&attempt_id, |login| {
        *login = LoginStatus {
            attempt_id: attempt_id.clone(),
            status: LoginState::Complete,
            message: None,
            account: Some(account),
            projects: None,
            selected_project_id: None,
        };
    });
    if completed {
        if let Some(dir) = &temp_data_dir {
            let _ = std::fs::remove_dir_all(dir);
        }
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
            close_login_window(&window);
        });
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
        || host == "grokusercontent.com"
        || host.ends_with(".grokusercontent.com")
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

/// True when the login window is still on an x.ai sign-in page. Checked by
/// host so look-alike URLs (`https://evil.com/?ref=x.ai`) cannot satisfy it.
fn is_xai_signin_host(url: &Url) -> bool {
    let Some(host) = url.host_str().map(str::to_ascii_lowercase) else {
        return false;
    };
    host == "x.ai" || host.ends_with(".x.ai")
}

fn read_cookie_header(window: &WebviewWindow) -> Result<String, String> {
    #[allow(unused_mut)]
    let mut pairs = BTreeMap::new();
    // Every cookie lookup blocks while the main thread runs a nested run loop. On iOS four of
    // them per poll crashed the app, so read the store once and filter here.
    #[cfg(target_os = "ios")]
    {
        let cookies = window.cookies().map_err(|error| error.to_string())?;
        for cookie in cookies {
            let domain = cookie.domain().unwrap_or("").trim_start_matches('.');
            let value = cookie.value().trim();
            if value.is_empty() || !is_allowed_cookie_host(domain) {
                continue;
            }
            pairs.insert(cookie.name().to_string(), value.to_string());
        }
        let header = pairs
            .into_iter()
            .map(|(name, value)| format!("{name}={value}"))
            .collect::<Vec<_>>()
            .join("; ");
        return normalize_cookie_header(&header);
    }
    #[cfg(not(target_os = "ios"))]
    {
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
            "https://auth.grokusercontent.com/verify",
            "https://accounts.google.com/o/oauth2/auth?client_id=x",
            "https://appleid.apple.com/auth/authorize",
        ] {
            let url = Url::parse(allowed).unwrap();
            assert!(is_allowed_login_navigation(&url), "{allowed}");
        }
        for blocked in [
            "https://evil.com/phish",
            "https://grok.com.evil.com/",
            "https://grokusercontent.com.evil.com/",
            "http://accounts.x.ai/sign-in",
            "javascript:alert(1)",
        ] {
            let url = Url::parse(blocked).unwrap();
            assert!(!is_allowed_login_navigation(&url), "{blocked}");
        }
    }
    #[test]
    fn back_button_requests_cancel_the_login() {
        // The injected button appends the flag to whatever page is showing.
        for back in [
            "https://accounts.x.ai/sign-in?ai-usage-tracker-back=1",
            "https://grok.com/?_s=usage&ai-usage-tracker-back=1",
            "https://accounts.google.com/o/oauth2/auth?client_id=x&ai-usage-tracker-back=1",
        ] {
            let url = Url::parse(back).unwrap();
            assert!(is_back_request(&url), "{back}");
        }
        for not_back in [
            "https://accounts.x.ai/sign-in",
            "https://grok.com/?_s=usage",
            "https://grok.com/?ai-usage-tracker-back=0",
            "https://grok.com/?other=ai-usage-tracker-back",
        ] {
            let url = Url::parse(not_back).unwrap();
            assert!(!is_back_request(&url), "{not_back}");
        }
        assert!(BACK_BUTTON_SCRIPT.contains("ai-usage-tracker-back"));
        assert!(BACK_BUTTON_SCRIPT.contains("aria-label"));
        assert!(BACK_BUTTON_SCRIPT.contains("createElementNS"));
        assert!(BACK_BUTTON_SCRIPT.contains("MutationObserver"));
        assert!(!BACK_BUTTON_SCRIPT.contains("innerHTML"));
    }

    #[test]
    fn xai_signin_host_check_uses_host_not_substring() {
        for allowed in ["https://accounts.x.ai/sign-in", "https://x.ai/"] {
            let url = Url::parse(allowed).unwrap();
            assert!(is_xai_signin_host(&url), "{allowed}");
        }
        for blocked in [
            "https://evil.com/?ref=x.ai",
            "https://grok.com.evil.com/x.ai",
            "https://x.ai.evil.com/",
            "https://evil.com/redirect?next=https://x.ai",
            "https://grok.com/?_s=usage",
        ] {
            let url = Url::parse(blocked).unwrap();
            assert!(!is_xai_signin_host(&url), "{blocked}");
        }
    }

    #[test]
    fn default_grok_label_handles_empty_and_numbered_accounts() {
        let temp = tempfile::tempdir().unwrap();
        let state = AppState::new(temp.path().to_path_buf(), "test-token".into()).unwrap();
        assert_eq!(
            default_grok_label(&state, Some("user@example.com")),
            "user@example.com"
        );
        assert_eq!(default_grok_label(&state, None), "Grok");
    }
}

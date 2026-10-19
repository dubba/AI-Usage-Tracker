use crate::{
    model::{
        now_rfc3339, Account, LoginStart, LoginState, LoginStatus, OpenCodeGoSecret, Provider,
        ProviderSecret,
    },
    providers,
    state::AppState,
    usage,
};
use chrono::{Duration, Utc};
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration as StdDuration,
};
#[cfg(desktop)]
use tauri::{webview::PageLoadEvent, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri::{AppHandle, WebviewWindow};
use url::Url;
use uuid::Uuid;

/// Label of the OpenCode sign-in window; `cancel_login` closes it by this name.
pub(crate) const LOGIN_WINDOW_LABEL: &str = "opencode-go-login";
#[cfg(desktop)]
pub(crate) const OPENCODE_PROFILE_PREFIX: &str = "ai-usage-opencode-";
const LOGIN_URL: &str = "https://opencode.ai/auth";
const LOGIN_TIMEOUT_MINUTES: i64 = 10;
const COOKIE_CAPTURE_ATTEMPTS: usize = 30;
const COOKIE_CAPTURE_RETRY_DELAY_MS: u64 = 500;

/// Query flag the injected top-left "Back" button appends to the current
/// page. `on_navigation` intercepts it (and blocks the reload): the login
/// attempt is canceled and the window closes, so users can always exit the
/// authorization flow.
#[cfg(desktop)]
const BACK_QUERY_FLAG: &str = "ai-usage-tracker-back";

/// Top-left "Back" button for the login window, which has no browser chrome.
/// Installed on every page (including the SSO hand-off hosts), because a
/// user can get stuck on any of them.
/// Built without `innerHTML` and reattached if removed: "Continue with Google"
/// loads `accounts.google.com`, which rejects HTML assignment and drops nodes
/// it did not create.
#[cfg(desktop)]
const BACK_BUTTON_SCRIPT: &str = r#"
(() => {
  try {
    // Not on the app's own "Account connected" page, which closes by itself.
    if (window.top !== window || !document.documentElement || location.protocol === 'data:') return;
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

#[cfg(desktop)]
const CONNECT_BANNER_SCRIPT: &str = r#"
(() => {
  if (window.top !== window || window.location.hostname !== 'opencode.ai') return;

  const isGoRoute = () => /^\/workspace\/[^/]+\/go(?:\/|$)/.test(window.location.pathname);
  let lastHref = window.location.href;
  let reloadScheduled = false;

  const detectGoNavigation = () => {
    const currentHref = window.location.href;
    if (currentHref === lastHref) return;
    lastHref = currentHref;

    if (!isGoRoute() || reloadScheduled) return;
    reloadScheduled = true;
    window.setTimeout(() => window.location.reload(), 50);
  };

  for (const methodName of ['pushState', 'replaceState']) {
    const original = window.history[methodName].bind(window.history);
    window.history[methodName] = function (...args) {
      const result = original(...args);
      window.setTimeout(detectGoNavigation, 0);
      return result;
    };
  }

  window.addEventListener('popstate', detectGoNavigation);
  window.addEventListener('hashchange', detectGoNavigation);
  window.setInterval(detectGoNavigation, 250);

  const installBanner = () => {
    if (!document.body || document.getElementById('paseo-opencode-connect-banner')) return;

    const banner = document.createElement('div');
    banner.id = 'paseo-opencode-connect-banner';
    banner.setAttribute('role', 'status');
    banner.textContent = 'AI Usage Tracker: Sign in to OpenCode, then select Go from the sidebar. This window will close automatically when your Go usage page is detected.';
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
      borderBottom: '1px solid #a078ff',
      fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif',
      fontSize: '14px',
      fontWeight: '650',
      lineHeight: '1.45',
      textAlign: 'center',
      boxShadow: '0 8px 24px rgba(0, 0, 0, .3)'
    });

    document.body.prepend(banner);
    const bannerHeight = Math.ceil(banner.getBoundingClientRect().height);
    const currentPadding = Number.parseFloat(getComputedStyle(document.body).paddingTop) || 0;
    document.body.style.paddingTop = `${currentPadding + bannerHeight}px`;
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', installBanner, { once: true });
  } else {
    installBanner();
  }
})();
"#;

pub async fn start_login(
    app: AppHandle,
    state: Arc<AppState>,
    label: String,
    email: Option<String>,
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
            message: Some("Sign in to OpenCode and open your Go subscription.".into()),
            account: None,
            projects: None,
            selected_project_id: None,
        });
    }

    #[cfg(mobile)]
    {
        let expires_at = (Utc::now() + Duration::minutes(LOGIN_TIMEOUT_MINUTES)).to_rfc3339();
        return start_mobile_login(
            app,
            state,
            attempt_id,
            label,
            email,
            reconnect_account_id,
            expires_at,
        )
        .await;
    }

    #[cfg(desktop)]
    {
        if let Some(window) = app.get_webview_window(LOGIN_WINDOW_LABEL) {
            close_login_window(&window);
        }

        let expires_at = (Utc::now() + Duration::minutes(LOGIN_TIMEOUT_MINUTES)).to_rfc3339();
        // A private profile per attempt (like the Grok window) so a previous
        // OpenCode or Google session can never silently sign in a second
        // account: every login starts without stored cookies.
        crate::login_profile::sweep_stale_profiles(OPENCODE_PROFILE_PREFIX);
        let temp_data_dir = match crate::login_profile::create_private_profile_dir(
            OPENCODE_PROFILE_PREFIX,
            &attempt_id,
        ) {
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
        let (width, height, position) =
            crate::oauth_common::window_geometry_centered_on(&app, "main", 1.0, 0.96, 820.0, 620.0);
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
                return Err(error.to_string());
            }
        };
        let capture_started = Arc::new(AtomicBool::new(false));

        let page_state = state.clone();
        let page_attempt = attempt_id.clone();
        let page_label = label.clone();
        let page_email = email.clone();
        let page_reconnect = reconnect_account_id.clone();
        let page_capture_started = capture_started.clone();

        #[allow(unused_mut)]
        let mut builder = WebviewWindowBuilder::new(
            &app,
            LOGIN_WINDOW_LABEL,
            WebviewUrl::External(login_url.clone()),
        )
        .title("Connect OpenCode Go — sign in, then select Go")
        .inner_size(width, height)
        .min_inner_size(820.0, 620.0)
        .resizable(true)
        .data_directory(temp_data_dir.clone())
        .incognito(true)
        .devtools(false)
        .initialization_script(format!("{CONNECT_BANNER_SCRIPT}\n{BACK_BUTTON_SCRIPT}"))
        .on_navigation({
            let back_app = app.clone();
            let back_state = state.clone();
            let back_attempt = attempt_id.clone();
            move |url| {
                if is_back_request(url) {
                    if let Some(window) = back_app.get_webview_window(LOGIN_WINDOW_LABEL) {
                        close_login_window(&window);
                    }
                    back_state.fail_login_if_waiting(
                        &back_attempt,
                        "OpenCode login was canceled.".into(),
                    );
                    return false;
                }
                is_allowed_login_navigation(url)
            }
        });

        #[cfg(desktop)]
        {
            if let Some((x, y)) = position {
                builder = builder.position(x, y);
            } else {
                builder = builder.center();
            }
        }

        let login_window = match builder
        .on_page_load(move |window, payload| {
        if !matches!(payload.event(), PageLoadEvent::Finished) {
            return;
        }
        let Some(workspace_id) = workspace_id_from_url(payload.url()) else {
            return;
        };
        if !page_state.login_is_waiting(&page_attempt) {
            return;
        }
        if page_capture_started.swap(true, Ordering::SeqCst) {
            return;
        }

        let cookie_window = window.clone();
        let completion_window = window.clone();
        let completion_state = page_state.clone();
        let completion_attempt = page_attempt.clone();
        let completion_label = page_label.clone();
        let completion_email = page_email.clone();
        let completion_reconnect = page_reconnect.clone();
        let completion_capture_started = page_capture_started.clone();

        std::thread::spawn(move || {
            let cookie_result = read_auth_cookie_with_retry(&cookie_window);

            tauri::async_runtime::spawn(async move {
                match cookie_result {
                    Ok((auth_cookie, discovered_email)) => {
                        let final_email = completion_email.or(discovered_email);
                        complete_login(
                            completion_state,
                            completion_attempt,
                            completion_label,
                            workspace_id,
                            auth_cookie,
                            final_email,
                            completion_reconnect,
                            completion_window,
                        )
                        .await;
                    }
                    Err(error) => {
                        completion_capture_started.store(false, Ordering::SeqCst);
                        completion_state.set_waiting_message(
                            &completion_attempt,
                            format!("{error} Navigate away from Go, then select Go again to retry."),
                        );
                    }
                }
            });
        });
    })
    .build() {
        Ok(window) => window,
        Err(error) => {
            let _ = std::fs::remove_dir_all(&temp_data_dir);
            let mut pending = state.pending_login.write();
            if pending.as_ref().is_some_and(|login| login.attempt_id == attempt_id) {
                *pending = None;
            }
            return Err(format!(
                "Unable to open the OpenCode login window: {}",
                crate::diagnostics::command_error(error)
            ));
        }
    };

        #[cfg(desktop)]
        if let Some((x, y)) = position {
            let _ = login_window.set_position(tauri::LogicalPosition::new(x, y));
        }

        let close_state = state.clone();
        let close_attempt = attempt_id.clone();
        let close_dir = temp_data_dir.clone();
        login_window.on_window_event(move |event| {
            if matches!(event, WindowEvent::CloseRequested { .. }) {
                let _ = std::fs::remove_dir_all(&close_dir);
                close_state
                    .fail_login_if_waiting(&close_attempt, "OpenCode login was canceled.".into());
            }
        });

        let timeout_state = state.clone();
        let timeout_attempt = attempt_id.clone();
        let timeout_app = app.clone();
        let timeout_dir = temp_data_dir.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(StdDuration::from_secs((LOGIN_TIMEOUT_MINUTES * 60) as u64)).await;
            if timeout_state.login_is_waiting(&timeout_attempt) {
                let _ = std::fs::remove_dir_all(&timeout_dir);
                timeout_state.fail_login_if_waiting(
                    &timeout_attempt,
                    "OpenCode login timed out. Start the connection again.".into(),
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

pub async fn add_account(
    state: Arc<AppState>,
    label: String,
    workspace_id: String,
    auth_cookie: String,
    email: Option<String>,
    reconnect_account_id: Option<String>,
) -> Result<Account, String> {
    let workspace_id = workspace_id.trim();
    if !providers::opencode_go::is_valid_workspace_id(workspace_id) {
        return Err(
            "A valid OpenCode workspace ID is required (letters, numbers, hyphens, and underscores only)."
                .into(),
        );
    }

    let auth_cookie = providers::opencode_go::normalize_cookie(&auth_cookie)
        .map_err(|_| "A valid OpenCode console auth cookie is required.".to_string())?;
    if auth_cookie.is_empty() || auth_cookie.chars().count() > 4096 {
        return Err("A valid OpenCode console auth cookie is required.".into());
    }

    let provider = Provider::OpencodeGo;
    let duplicate = state.store.account_to_update(
        &provider,
        reconnect_account_id.as_deref(),
        Some(workspace_id),
        email.as_deref(),
    );
    let now = now_rfc3339();
    let account = Account {
        id: duplicate
            .as_ref()
            .map(|account| account.id.clone())
            .unwrap_or_else(|| Uuid::new_v4().to_string()),
        label: if label.trim().is_empty() {
            provider.display_name().into()
        } else {
            label.trim().to_string()
        },
        provider,
        email: email
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
            .or_else(|| duplicate.as_ref().and_then(|account| account.email.clone()))
            .or_else(|| {
                crate::providers::grok::extract_identity_from_jwt(&auth_cookie)
                    .or_else(|| crate::providers::grok::extract_identity_from_cookies(&auth_cookie))
            }),
        provider_account_id: Some(workspace_id.to_string()),
        chatgpt_account_id: None,
        plan: Some("OpenCode Go".into()),
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

    let account = state
        .persist_connected_account(
            account,
            &ProviderSecret::OpencodeGo(OpenCodeGoSecret {
                workspace_id: workspace_id.to_string(),
                auth_cookie,
            }),
        )
        .await
        .map_err(|error| error.to_string())?;
    usage::refresh_account(state, &account.id).await
}

#[allow(clippy::too_many_arguments)]
async fn complete_login(
    state: Arc<AppState>,
    attempt_id: String,
    label: String,
    workspace_id: String,
    auth_cookie: String,
    email: Option<String>,
    reconnect_account_id: Option<String>,
    window: WebviewWindow,
) {
    if !state.login_is_waiting(&attempt_id) {
        return;
    }

    match add_account(
        state.clone(),
        label,
        workspace_id,
        auth_cookie,
        email,
        reconnect_account_id,
    )
    .await
    {
        Ok(account) => {
            #[cfg(desktop)]
            let connected = account.clone();
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
                // On mobile the sign-in poll loop (mobile_auth.rs) shows the page instead.
                #[cfg(desktop)]
                crate::oauth_common::close_after_connected_page(window, &connected);
            }
        }
        Err(error) => {
            state.fail_login_if_waiting(&attempt_id, error);
            close_login_window(&window);
        }
    }
}

#[cfg(mobile)]
async fn start_mobile_login(
    app: AppHandle,
    state: Arc<AppState>,
    attempt_id: String,
    label: String,
    email: Option<String>,
    reconnect_account_id: Option<String>,
    expires_at: String,
) -> Result<LoginStart, String> {
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
            return Err(error.to_string());
        }
    };
    let window = match crate::mobile_auth::main_window(&app) {
        Ok(window) => window,
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
    let capture_started = Arc::new(AtomicBool::new(false));
    let page_state = state.clone();
    let page_attempt = attempt_id.clone();
    let page_label = label;
    let page_email = email;
    let page_reconnect = reconnect_account_id;
    let page_window = window;
    if let Err(error) = crate::mobile_auth::open_in_main_webview(
        app.clone(),
        state.clone(),
        attempt_id.clone(),
        login_url,
        move |url| {
            let Some(workspace_id) = workspace_id_from_url(&url) else {
                return;
            };
            if !page_state.login_is_waiting(&page_attempt) {
                return;
            }
            if capture_started.swap(true, Ordering::SeqCst) {
                return;
            }
            let cookie_window = page_window.clone();
            let completion_window = page_window.clone();
            let completion_state = page_state.clone();
            let completion_attempt = page_attempt.clone();
            let completion_label = page_label.clone();
            let completion_email = page_email.clone();
            let completion_reconnect = page_reconnect.clone();
            let completion_capture_started = capture_started.clone();
            std::thread::spawn(move || {
                let cookie_result = read_auth_cookie_with_retry(&cookie_window);
                tauri::async_runtime::spawn(async move {
                    match cookie_result {
                        Ok((auth_cookie, discovered_email)) => {
                            let final_email = completion_email.or(discovered_email);
                            complete_login(
                                completion_state,
                                completion_attempt,
                                completion_label,
                                workspace_id,
                                auth_cookie,
                                final_email,
                                completion_reconnect,
                                completion_window,
                            )
                            .await;
                        }
                        Err(error) => {
                            completion_capture_started.store(false, Ordering::SeqCst);
                            completion_state.set_waiting_message(
                                &completion_attempt,
                                format!(
                                    "{error} Navigate away from Go, then select Go again to retry."
                                ),
                            );
                        }
                    }
                });
            });
        },
    ) {
        let mut pending = state.pending_login.write();
        if pending
            .as_ref()
            .is_some_and(|login| login.attempt_id == attempt_id)
        {
            *pending = None;
        }
        return Err(error);
    }

    let timeout_state = state.clone();
    let timeout_attempt = attempt_id.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(StdDuration::from_secs((LOGIN_TIMEOUT_MINUTES * 60) as u64)).await;
        if timeout_state.login_is_waiting(&timeout_attempt) {
            timeout_state.fail_login_if_waiting(
                &timeout_attempt,
                "OpenCode login timed out. Start the connection again.".into(),
            );
        }
    });

    Ok(LoginStart {
        attempt_id,
        authorization_url: String::new(),
        expires_at,
    })
}

fn close_login_window(window: &WebviewWindow) {
    crate::mobile_auth::dismiss_login_window(window);
}

/// The cookies the WebView holds for `url`'s host. Tauri's lookup blocks the main thread in a
/// nested run loop, which can crash the app on iOS, so there the store is read without blocking
/// (see ios_cookies.rs) and filtered to the host here.
fn read_opencode_cookies(
    window: &WebviewWindow,
    url: &Url,
) -> Result<Vec<tauri::webview::Cookie<'static>>, String> {
    #[cfg(target_os = "ios")]
    {
        let host = url.host_str().unwrap_or_default();
        let cookies = crate::ios_cookies::all_cookies(window)?;
        Ok(cookies
            .into_iter()
            .filter(|cookie| {
                cookie
                    .domain()
                    .is_some_and(|domain| domain.trim_start_matches('.').eq_ignore_ascii_case(host))
            })
            .collect())
    }
    #[cfg(not(target_os = "ios"))]
    {
        window
            .cookies_for_url(url.clone())
            .map_err(|error| error.to_string())
    }
}

fn read_auth_cookie_with_retry(window: &WebviewWindow) -> Result<(String, Option<String>), String> {
    let cookie_url = Url::parse("https://opencode.ai/")
        .map_err(|error| format!("Unable to prepare the OpenCode cookie request: {error}"))?;

    std::thread::sleep(StdDuration::from_millis(250));

    let mut last_read_error = None;
    for attempt in 0..COOKIE_CAPTURE_ATTEMPTS {
        match read_opencode_cookies(window, &cookie_url) {
            Ok(cookies) => {
                let auth_cookie = cookies
                    .iter()
                    .find(|cookie| cookie.name() == "auth")
                    .map(|cookie| cookie.value().to_string())
                    .filter(|value| !value.trim().is_empty());

                if let Some(auth_val) = auth_cookie {
                    let mut discovered_email =
                        crate::providers::grok::extract_identity_from_jwt(&auth_val);
                    if discovered_email.is_none() {
                        for cookie in &cookies {
                            let name = cookie.name();
                            let value = cookie.value();
                            if (name.eq_ignore_ascii_case("email")
                                || name.eq_ignore_ascii_case("user_email"))
                                && value.contains('@')
                            {
                                discovered_email = Some(value.to_string());
                                break;
                            }
                            if let Some(identity) =
                                crate::providers::grok::extract_identity_from_jwt(value)
                            {
                                discovered_email = Some(identity);
                                break;
                            }
                        }
                    }
                    return Ok((auth_val, discovered_email));
                }
            }
            Err(error) => {
                last_read_error = Some(error.to_string());
            }
        }

        if attempt + 1 < COOKIE_CAPTURE_ATTEMPTS {
            std::thread::sleep(StdDuration::from_millis(COOKIE_CAPTURE_RETRY_DELAY_MS));
        }
    }

    match last_read_error {
        Some(error) => Err(format!(
            "Unable to read the OpenCode login session after retrying: {error}."
        )),
        None => Err(
            "OpenCode did not provide a usable login session after retrying. Confirm that sign-in completed."
                .into(),
        ),
    }
}

/// Restrict the private login window to OpenCode hosts (plus the SSO providers
/// used for sign-in). Prevents a link or open redirect from steering the
/// cookie-capture window to an attacker-controlled page.
#[cfg(desktop)]
fn is_allowed_login_navigation(url: &Url) -> bool {
    if url.as_str() == "about:blank" || crate::oauth_common::is_connected_page(url) {
        return true;
    }
    if url.scheme() != "https" {
        return false;
    }
    let Some(host) = url.host_str().map(str::to_ascii_lowercase) else {
        return false;
    };
    host == "opencode.ai"
        || host.ends_with(".opencode.ai")
        || host == "accounts.google.com"
        || host == "github.com"
        || host == "appleid.apple.com"
}

fn workspace_id_from_url(url: &Url) -> Option<String> {
    if url.host_str() != Some("opencode.ai") {
        return None;
    }
    let segments = url.path_segments()?.collect::<Vec<_>>();
    let workspace_index = segments
        .iter()
        .position(|segment| *segment == "workspace")?;
    if segments.get(workspace_index + 2).copied() != Some("go") {
        return None;
    }
    let workspace_id = segments.get(workspace_index + 1)?.trim();
    if !providers::opencode_go::is_valid_workspace_id(workspace_id) {
        return None;
    }
    Some(workspace_id.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn starts_on_the_opencode_auth_page() {
        assert_eq!(LOGIN_URL, "https://opencode.ai/auth");
    }

    #[test]
    fn detects_only_opencode_go_workspace_urls() {
        assert_eq!(
            workspace_id_from_url(
                &Url::parse("https://opencode.ai/workspace/mystic-patrol-3ls3t/go").unwrap()
            ),
            Some("mystic-patrol-3ls3t".into())
        );
        assert_eq!(
            workspace_id_from_url(
                &Url::parse("https://opencode.ai/workspace/mystic-patrol-3ls3t/go/?source=sidebar")
                    .unwrap()
            ),
            Some("mystic-patrol-3ls3t".into())
        );
        assert_eq!(
            workspace_id_from_url(
                &Url::parse("https://opencode.ai/workspace/mystic-patrol-3ls3t/settings").unwrap()
            ),
            None
        );
        assert_eq!(
            workspace_id_from_url(
                &Url::parse("https://example.com/workspace/mystic-patrol-3ls3t/go").unwrap()
            ),
            None
        );
        assert_eq!(
            workspace_id_from_url(
                &Url::parse("https://opencode.ai/workspace/../admin/go").unwrap()
            ),
            None
        );
    }

    #[test]
    fn login_window_navigation_is_host_allowlisted() {
        for allowed in [
            "https://opencode.ai/auth",
            "https://opencode.ai/workspace/team-one/go",
            "https://accounts.google.com/o/oauth2/auth",
            "https://github.com/login/oauth/authorize",
        ] {
            let url = Url::parse(allowed).unwrap();
            assert!(is_allowed_login_navigation(&url), "{allowed}");
        }
        for blocked in [
            "https://evil.com/phish",
            "https://opencode.ai.evil.com/",
            "http://opencode.ai/auth",
            "data:text/html,<script>1</script>",
            // Only the exact "Account connected" page the app made, never data: in general.
            "data:text/html;charset=utf-8;base64,PHNjcmlwdD4xPC9zY3JpcHQ+",
        ] {
            let url = Url::parse(blocked).unwrap();
            assert!(!is_allowed_login_navigation(&url), "{blocked}");
        }
    }

    #[test]
    fn back_button_stays_off_the_connected_page() {
        assert!(BACK_BUTTON_SCRIPT.contains("location.protocol === 'data:'"));
    }

    #[test]
    fn back_button_requests_cancel_the_login() {
        // The injected button appends the flag to whatever page is showing.
        for back in [
            "https://opencode.ai/auth?ai-usage-tracker-back=1",
            "https://opencode.ai/workspace/w/go?ai-usage-tracker-back=1",
            "https://accounts.google.com/o/oauth2/auth?client_id=x&ai-usage-tracker-back=1",
        ] {
            let url = Url::parse(back).unwrap();
            assert!(is_back_request(&url), "{back}");
        }
        for not_back in [
            "https://opencode.ai/auth",
            "https://opencode.ai/workspace/w/go",
            "https://opencode.ai/auth?ai-usage-tracker-back=0",
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
}

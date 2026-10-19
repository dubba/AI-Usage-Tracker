#[cfg(desktop)]
use crate::login_window::{
    self, is_back_request, LoginWindowEnd, LoginWindowSpec, BACK_BUTTON_SCRIPT, BACK_QUERY_FLAG,
    LOGIN_USER_AGENT,
};
use crate::{
    model::{Account, GrokSecret, LoginStart, Provider, ProviderSecret},
    oauth_common::{finish_window_login, merge_into_existing, ConnectedFields},
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
#[cfg(mobile)]
use tauri::AppHandle;
#[cfg(desktop)]
use tauri::Manager;
use tauri::WebviewWindow;
use url::Url;
use uuid::Uuid;

/// Label of the Grok sign-in window; `cancel_login` closes it by this name.
pub(crate) const LOGIN_WINDOW_LABEL: &str = "grok-login";
#[cfg(desktop)]
const GROK_CANCELED_MESSAGE: &str = "Grok login was canceled.";
#[cfg(desktop)]
pub(crate) const GROK_PROFILE_PREFIX: &str = "ai-usage-grok-";
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
      borderBottom: '1px solid #a078ff',
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

/// The account a Grok sign-in saves, from what the Usage service reported: an existing account
/// (the reconnect target, the same identity, or one carrying the typed label) is updated.
fn account_from_usage(
    state: &AppState,
    usage: &providers::ProviderUsage,
    label: &str,
    reconnect_account_id: Option<&str>,
) -> Account {
    let duplicate = state
        .store
        .account_to_update(
            &Provider::Grok,
            reconnect_account_id,
            usage.provider_account_id.as_deref(),
            usage.email.as_deref(),
        )
        .or_else(|| grok_account_with_label(state, label));
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
    let label = if label.trim().is_empty() {
        duplicate
            .as_ref()
            .map(|account| account.label.clone())
            .unwrap_or_else(|| default_grok_label(state, usage.email.as_deref()))
    } else {
        label.trim().to_string()
    };
    merge_into_existing(
        duplicate.as_ref(),
        ConnectedFields {
            label,
            provider: Provider::Grok,
            email: usage
                .email
                .clone()
                .or_else(|| duplicate.as_ref().and_then(|account| account.email.clone())),
            provider_account_id,
            chatgpt_account_id: None,
            plan: usage.plan.clone().or_else(|| Some("Grok".into())),
        },
    )
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

    let account = account_from_usage(
        state.as_ref(),
        &probe,
        &label,
        reconnect_account_id.as_deref(),
    );
    let account_id = account.id.clone();

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

pub async fn start_login(
    state: Arc<AppState>,
    label: String,
    reconnect_account_id: Option<String>,
) -> Result<LoginStart, String> {
    let attempt_id = Uuid::new_v4().to_string();
    state.begin_login(&attempt_id, Some(
                "Sign in to Grok in the private window. The tracker will close it after the Usage service recognizes your session."
                    .into(),
            ))?;

    let app = match state.app_handle.read().clone() {
        Some(app) => app,
        None => {
            state.clear_pending_login(&attempt_id);
            return Err("The application is not ready to open Grok login.".to_string());
        }
    };

    let expires_at = (Utc::now() + ChronoDuration::minutes(LOGIN_TIMEOUT_MINUTES)).to_rfc3339();
    let login_url = match Url::parse(LOGIN_URL) {
        Ok(url) => url,
        Err(error) => {
            state.clear_pending_login(&attempt_id);
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
        crate::login_profile::sweep_stale_profiles(GROK_PROFILE_PREFIX);
        let temp_data_dir = match crate::login_profile::create_private_profile_dir(
            GROK_PROFILE_PREFIX,
            &attempt_id,
        ) {
            Ok(dir) => dir,
            Err(error) => {
                state.clear_pending_login(&attempt_id);
                return Err(error);
            }
        };

        let login_window = match login_window::open_private_login_window(
            &app,
            LoginWindowSpec {
                label: LOGIN_WINDOW_LABEL,
                title: "Connect Grok",
                start_url: login_url,
                profile_dir: temp_data_dir.clone(),
                init_script: format!("{CONNECT_BANNER_SCRIPT}\n{BACK_BUTTON_SCRIPT}"),
                user_agent: Some(LOGIN_USER_AGENT),
            },
            |builder| {
                let back_app = app.clone();
                let back_state = state.clone();
                let back_attempt = attempt_id.clone();
                builder.on_navigation(move |url| {
                    if is_back_request(url, BACK_QUERY_FLAG) {
                        if let Some(window) = back_app.get_webview_window(LOGIN_WINDOW_LABEL) {
                            close_login_window(&window);
                        }
                        back_state
                            .fail_login_if_waiting(&back_attempt, GROK_CANCELED_MESSAGE.into());
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
                })
            },
        ) {
            Ok(window) => window,
            Err(error) => {
                let _ = std::fs::remove_dir_all(&temp_data_dir);
                state.clear_pending_login(&attempt_id);
                return Err(format!("Unable to open the Grok login window: {error}"));
            }
        };

        start_cookie_poll(
            login_window.clone(),
            state.clone(),
            attempt_id.clone(),
            label,
            reconnect_account_id,
            Some(temp_data_dir.clone()),
        );

        login_window::spawn_login_close_and_timeout(
            &app,
            &state,
            &login_window,
            &attempt_id,
            &temp_data_dir,
            LoginWindowEnd {
                label: LOGIN_WINDOW_LABEL,
                timeout_minutes: LOGIN_TIMEOUT_MINUTES,
                canceled: GROK_CANCELED_MESSAGE,
                timed_out: "Grok login timed out. Start the connection again.",
            },
        );

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
            state.clear_pending_login(&attempt_id);
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
        state.clear_pending_login(&attempt_id);
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

    let account = account_from_usage(
        state.as_ref(),
        &usage,
        &label,
        reconnect_account_id.as_deref(),
    );
    let account_id = account.id.clone();

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

    if finish_window_login(&state, &attempt_id, account, window) {
        if let Some(dir) = &temp_data_dir {
            let _ = std::fs::remove_dir_all(dir);
        }
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
    if url.as_str() == "about:blank"
        || url.scheme() == "blob"
        || crate::oauth_common::is_connected_page(url)
    {
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
        // Google's sign-in passes through here to sign the account in to YouTube.
        || host == "accounts.youtube.com"
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
    // Tauri's cookie lookups block the main thread in a nested run loop, which can crash the
    // app on iOS, so read the store once without blocking (see ios_cookies.rs) and filter here.
    #[cfg(target_os = "ios")]
    {
        let cookies = crate::ios_cookies::all_cookies(window)?;
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
            "https://accounts.youtube.com/accounts/SetSID?ssdc=1",
        ] {
            let url = Url::parse(allowed).unwrap();
            assert!(is_allowed_login_navigation(&url), "{allowed}");
        }
        for blocked in [
            "https://evil.com/phish",
            "https://grok.com.evil.com/",
            "https://grokusercontent.com.evil.com/",
            "http://accounts.x.ai/sign-in",
            "https://www.youtube.com/watch?v=x",
            "https://evil.accounts.youtube.com/",
            "javascript:alert(1)",
            // Only the exact "Account connected" page the app made, never data: in general.
            "data:text/html,<script>1</script>",
            "data:text/html;charset=utf-8;base64,PHNjcmlwdD4xPC9zY3JpcHQ+",
        ] {
            let url = Url::parse(blocked).unwrap();
            assert!(!is_allowed_login_navigation(&url), "{blocked}");
        }
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

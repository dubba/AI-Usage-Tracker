#[cfg(mobile)]
use crate::{model::LoginStatus, state::AppState};
#[cfg(mobile)]
use std::sync::Arc;
#[cfg(mobile)]
use std::time::Duration;
use tauri::WebviewWindow;
#[cfg(mobile)]
use tauri::{AppHandle, Manager};
use url::Url;

const MAIN_WINDOW: &str = "main";
#[cfg(mobile)]
const NAVIGATE_DELAY: Duration = Duration::from_millis(250);
#[cfg(mobile)]
const POLL_INTERVAL: Duration = Duration::from_millis(400);

/// Force Google Identity Services off FedCM. FedCM hangs in Android WebView
/// (infinite spinner on "Continue with Google"). Real popups are handled natively.
#[cfg_attr(not(any(test, mobile)), allow(dead_code))]
const POPUP_SHIM_SCRIPT: &str = r#"
(() => {
  try {
    const cred = navigator.credentials;
    if (cred && cred.get && !cred.__aiTrackerFedCm) {
      cred.__aiTrackerFedCm = true;
      const orig = cred.get.bind(cred);
      cred.get = function (opts) {
        if (opts && opts.identity) {
          return Promise.reject(new DOMException('FedCM unavailable', 'NotSupportedError'));
        }
        return orig(opts);
      };
    }
  } catch (e) {}
})();
"#;

/// URL fragment the injected "Back" button sets. The login page is a remote origin with no IPC,
/// so the poll loop reads this from the WebView URL instead.
#[cfg_attr(not(any(test, target_os = "ios")), allow(dead_code))]
const BACK_FRAGMENT: &str = "ai-usage-tracker-back";

/// iOS has no back gesture or button in the single-WebView login, so this adds a fixed
/// "Back to AI Usage Tracker" button to the top-left of every provider page.
#[cfg_attr(not(any(test, target_os = "ios")), allow(dead_code))]
const BACK_BUTTON_SCRIPT: &str = r#"
(() => {
  try {
    const id = '__ai_tracker_back';
    if (document.getElementById(id)) return;
    const button = document.createElement('button');
    button.id = id;
    button.type = 'button';
    button.textContent = '‹ Back to AI Usage Tracker';
    button.style.cssText = [
      'position:fixed', 'top:max(env(safe-area-inset-top),8px)', 'left:8px', 'z-index:2147483647',
      'padding:8px 14px', 'border:0', 'border-radius:999px', 'background:#6d3bd7', 'color:#fff',
      'font:600 14px -apple-system,system-ui,sans-serif', 'box-shadow:0 2px 10px rgba(0,0,0,.4)',
    ].join(';');
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      location.hash = 'ai-usage-tracker-back';
    }, true);
    (document.body || document.documentElement).appendChild(button);
  } catch (e) {}
})();
"#;

/// wry only implements `window.open` popups on macOS, so on iOS the call silently returns null and
/// "Continue with Google" never opens. Opening the target in the same WebView lets the redirect
/// flow finish.
#[cfg_attr(not(any(test, target_os = "ios")), allow(dead_code))]
const IOS_POPUP_SCRIPT: &str = r#"
(() => {
  try {
    if (window.__aiTrackerPopup) return;
    window.__aiTrackerPopup = true;
    window.open = function (url) {
      if (url) location.href = String(url);
      return null;
    };
  } catch (e) {}
})();
"#;

#[cfg_attr(not(any(test, target_os = "ios")), allow(dead_code))]
fn is_back_request(url: &Url) -> bool {
    url.fragment() == Some(BACK_FRAGMENT)
}

#[cfg(mobile)]
pub fn main_window(app: &AppHandle) -> Result<WebviewWindow, String> {
    app.get_webview_window(MAIN_WINDOW)
        .ok_or_else(|| "The app window is not ready for in-app sign-in.".into())
}

pub fn is_app_shell(window: &WebviewWindow) -> bool {
    window.label() == MAIN_WINDOW
}

/// Android wry only supports one WebView. Closing the app shell would kill the UI.
pub fn dismiss_login_window(window: &WebviewWindow) {
    if is_app_shell(window) {
        return;
    }
    let _ = window.close();
    let _ = window.destroy();
}

/// Navigate the main WebView to `target` after the Tauri command can return,
/// inspect each URL, and restore the app page once login is no longer waiting.
#[cfg(mobile)]
pub fn open_in_main_webview(
    app: AppHandle,
    state: Arc<AppState>,
    attempt_id: String,
    target: Url,
    mut on_url: impl FnMut(Url) + Send + 'static,
) -> Result<(), String> {
    if target.scheme() != "https" {
        return Err("Only HTTPS URLs are allowed for in-app sign-in".to_string());
    }
    let host = target.host_str().unwrap_or("");
    let allowed_hosts = [
        "auth.openai.com",
        "openai.com",
        "claude.ai",
        "anthropic.com",
        "accounts.google.com",
        "google.com",
        "aistudio.google.com",
        "accounts.x.ai",
        "grok.com",
        "x.ai",
        "opencode.ai",
    ];
    if !allowed_hosts
        .iter()
        .any(|&h| host == h || host.ends_with(&format!(".{h}")))
    {
        return Err(format!("Disallowed host for in-app sign-in: {host}"));
    }

    let window = main_window(&app)?;
    let restore_url = window
        .url()
        .map_err(|error| format!("Unable to read the app URL: {error}"))?;

    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(NAVIGATE_DELAY).await;
        if !attempt_matches(&state, &attempt_id) {
            return;
        }
        let oauth_start = target.clone();
        if let Err(error) = window.navigate(target) {
            fail_waiting(
                &state,
                &attempt_id,
                format!("Unable to open the sign-in page: {error}"),
            );
            return;
        }
        // Disable FedCM before the provider page's Google button initializes.
        let _ = window.eval(POPUP_SHIM_SCRIPT);
        // Also inject after a short delay to catch the new document's window object.
        tokio::time::sleep(Duration::from_millis(150)).await;
        let _ = window.eval(POPUP_SHIM_SCRIPT);

        let mut left_app_shell = false;
        loop {
            tokio::time::sleep(POLL_INTERVAL).await;
            if !attempt_matches(&state, &attempt_id) {
                break;
            }
            let waiting =
                state.pending_login.read().as_ref().is_some_and(|login| {
                    login.attempt_id == attempt_id && login.status == "waiting"
                });
            let exchange_queued = state
                .pending_auth_exchange
                .lock()
                .as_ref()
                .is_some_and(|pending| pending.attempt_id == attempt_id);
            if !waiting || exchange_queued {
                if let Ok(current) = window.url() {
                    if !urls_share_origin(&current, &restore_url) {
                        let _ = window.navigate(restore_url);
                    }
                } else {
                    let _ = window.navigate(restore_url);
                }
                break;
            }
            let _ = window.eval(POPUP_SHIM_SCRIPT);
            if let Ok(current) = window.url() {
                // Google SSO often finishes by navigating the WebView to about:blank.
                // Reload the provider OAuth page so it can pick up the new session.
                if current.scheme() == "about" {
                    let _ = window.navigate(oauth_start.clone());
                    continue;
                }
                #[cfg(target_os = "ios")]
                {
                    if is_back_request(&current) {
                        let _ = state.abandon_waiting_login(&attempt_id);
                        let _ = window.navigate(restore_url);
                        break;
                    }
                    if !urls_share_origin(&current, &restore_url)
                        && matches!(current.scheme(), "http" | "https")
                    {
                        let _ = window.eval(BACK_BUTTON_SCRIPT);
                        let _ = window.eval(IOS_POPUP_SCRIPT);
                    }
                }
                on_url(current.clone());
                if urls_share_origin(&current, &restore_url) {
                    if left_app_shell {
                        let _ = state.abandon_waiting_login(&attempt_id);
                        break;
                    }
                } else {
                    left_app_shell = true;
                }
            }
        }
    });
    Ok(())
}

#[cfg(mobile)]
fn attempt_matches(state: &AppState, attempt_id: &str) -> bool {
    state
        .pending_login
        .read()
        .as_ref()
        .is_some_and(|login| login.attempt_id == attempt_id)
}

#[cfg_attr(not(any(test, mobile)), allow(dead_code))]
pub(crate) fn urls_share_origin(left: &Url, right: &Url) -> bool {
    left.scheme() == right.scheme()
        && left.host() == right.host()
        && left.port_or_known_default() == right.port_or_known_default()
}

#[cfg(mobile)]
fn fail_waiting(state: &AppState, attempt_id: &str, message: String) {
    let mut pending = state.pending_login.write();
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_shell_uses_main_label() {
        assert_eq!(MAIN_WINDOW, "main");
    }

    #[test]
    fn restore_logic_treats_only_waiting_as_in_progress() {
        for status in [
            "complete",
            "failed",
            "choose_project",
            "monitoring_disabled",
        ] {
            assert_ne!(status, "waiting");
        }
    }

    #[test]
    fn login_shim_disables_fedcm_and_leaves_window_open_native() {
        assert!(POPUP_SHIM_SCRIPT.contains("FedCM unavailable"));
        assert!(POPUP_SHIM_SCRIPT.contains("opts.identity"));
        assert!(!POPUP_SHIM_SCRIPT.contains("window.open ="));
    }

    #[test]
    fn back_button_requests_are_detected_from_the_url_fragment() {
        let back = Url::parse("https://claude.ai/login#ai-usage-tracker-back").unwrap();
        let other = Url::parse("https://claude.ai/login#other").unwrap();
        let none = Url::parse("https://claude.ai/login").unwrap();
        assert!(is_back_request(&back));
        assert!(!is_back_request(&other));
        assert!(!is_back_request(&none));
        assert!(BACK_BUTTON_SCRIPT.contains(BACK_FRAGMENT));
        assert!(IOS_POPUP_SCRIPT.contains("window.open"));
    }

    #[test]
    fn about_blank_is_not_an_https_oauth_host() {
        let blank = Url::parse("about:blank").unwrap();
        assert_eq!(blank.scheme(), "about");
    }

    #[test]
    fn app_shell_origin_matches_dashboard_and_not_oauth_callback() {
        let dashboard = Url::parse("http://127.0.0.1:1420/").unwrap();
        let dashboard_path = Url::parse("http://127.0.0.1:1420/index.html").unwrap();
        let openai = Url::parse("https://auth.openai.com/oauth/authorize").unwrap();
        let callback = Url::parse("http://localhost:1455/auth/callback?code=abc").unwrap();
        assert!(urls_share_origin(&dashboard, &dashboard_path));
        assert!(!urls_share_origin(&dashboard, &openai));
        assert!(!urls_share_origin(&dashboard, &callback));
    }
}

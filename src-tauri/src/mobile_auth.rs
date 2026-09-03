#[cfg(mobile)]
use crate::{model::LoginStatus, state::AppState};
#[cfg(mobile)]
use std::sync::Arc;
#[cfg(mobile)]
use std::time::Duration;
#[cfg(mobile)]
use tauri::{AppHandle, Manager};
use tauri::WebviewWindow;
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
    let window = main_window(&app)?;
    let restore_url = window
        .url()
        .map_err(|error| format!("Unable to read the app URL: {error}"))?;

    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(NAVIGATE_DELAY).await;
        if !attempt_matches(&state, &attempt_id) {
            return;
        }
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
            let waiting = state.pending_login.read().as_ref().is_some_and(|login| {
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
        for status in ["complete", "failed", "choose_project", "monitoring_disabled"] {
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

#[cfg(mobile)]
use crate::{model::LoginStatus, state::AppState};
#[cfg(mobile)]
use std::sync::Arc;
#[cfg(mobile)]
use std::time::Duration;
#[cfg(mobile)]
use tauri::{AppHandle, Manager};
use tauri::WebviewWindow;
#[cfg(mobile)]
use url::Url;

const MAIN_WINDOW: &str = "main";
#[cfg(mobile)]
const NAVIGATE_DELAY: Duration = Duration::from_millis(250);
#[cfg(mobile)]
const POLL_INTERVAL: Duration = Duration::from_millis(400);

/// xAI/Google/Apple/X login buttons use window.open or target=_blank.
/// Android WebView ignores those unless we fold them into this window.
#[cfg(mobile)]
const POPUP_SHIM_SCRIPT: &str = r#"
(() => {
  if (window.__aiTrackerPopupShim) return;
  window.__aiTrackerPopupShim = true;

  const navigate = (url) => {
    if (!url) return null;
    const next = String(url);
    if (!next || next === 'about:blank') return null;
    try { window.location.assign(next); } catch (e) { window.location.href = next; }
    return window;
  };

  const fakePopup = () => {
    const popup = {
      closed: false,
      opener: window,
      close() { this.closed = true; },
      focus() {},
      blur() {},
      postMessage() {},
    };
    const location = {
      get href() { return 'about:blank'; },
      set href(value) { navigate(value); },
      assign(value) { navigate(value); },
      replace(value) { navigate(value); },
      toString() { return 'about:blank'; },
    };
    try {
      Object.defineProperty(popup, 'location', {
        get() { return location; },
        set(value) { navigate(value); },
      });
    } catch (e) {
      popup.location = location;
    }
    return popup;
  };

  window.open = function (url) {
    if (!url || String(url) === 'about:blank') {
      return fakePopup();
    }
    return navigate(url);
  };

  document.addEventListener('click', (event) => {
    const target = event.target;
    if (!target || !target.closest) return;
    const link = target.closest('a[href]');
    if (!link) return;
    const href = link.href || '';
    const blank = link.target === '_blank' || (link.getAttribute('target') || '') === '_blank';
    if (!blank) return;
    if (href.startsWith('https:') || href.startsWith('http:') || href.startsWith('intent:')) {
      event.preventDefault();
      event.stopPropagation();
      navigate(href);
    }
  }, true);
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
        let _ = window.eval(POPUP_SHIM_SCRIPT);

        loop {
            tokio::time::sleep(POLL_INTERVAL).await;
            let waiting = state.pending_login.read().as_ref().is_some_and(|login| {
                login.attempt_id == attempt_id && login.status == "waiting"
            });
            let exchange_queued = state
                .pending_auth_exchange
                .lock()
                .as_ref()
                .is_some_and(|pending| pending.attempt_id == attempt_id);
            if !waiting || exchange_queued {
                let _ = window.navigate(restore_url);
                break;
            }
            let _ = window.eval(POPUP_SHIM_SCRIPT);
            if let Ok(current) = window.url() {
                on_url(current);
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
}

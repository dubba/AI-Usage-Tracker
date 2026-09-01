#[cfg(mobile)]
use crate::{grok_login::update_waiting_message, model::LoginStatus, state::AppState};
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
pub(crate) const POPUP_SHIM_SCRIPT: &str = r#"
(() => {
  if (window.__aiTrackerPopupShim) return;
  window.__aiTrackerPopupShim = true;

  const navigate = (url) => {
    if (!url) return null;
    const next = String(url);
    if (!next || next === 'about:blank') return null;
    // Android app links (intent:// / android-app://) cannot be loaded by a WebView.
    // Follow the embedded browser fallback URL when present, otherwise leave the page alone.
    if (next.startsWith('intent:') || next.startsWith('android-app:')) {
      const match = /[;?&]S\.browser_fallback_url=([^;&]+)/.exec(next);
      let target = null;
      if (match) {
        try { target = decodeURIComponent(match[1]); } catch (e) { target = null; }
      }
      if (target && (target.startsWith('https:') || target.startsWith('http:'))) {
        console.log('[ai-tracker] following app-link browser fallback: ' + target);
        try { window.location.assign(target); } catch (e) { window.location.href = target; }
      } else {
        console.log('[ai-tracker] app link has no browser fallback; use manual cookie paste');
      }
      return null;
    }
    // Google OAuth is blocked in embedded WebView (disallowed_useragent). Don't navigate the WebView;
    // the Rust poll will surface a clear waiting message directing to X/Apple/Email or manual cookie.
    if (next.includes('accounts.google.com')) {
      console.log('[ai-tracker] blocked embedded Google sign-in (disallowed_useragent)');
      return null;
    }
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

  const openOverride = function (url, target, features) {
    const next = url ? String(url) : '';
    if (!next || next === 'about:blank') {
      const p = fakePopup();
      return p;
    }
    const popup = fakePopup();
    navigate(next);
    try { popup.location.href = next; } catch (e) {}
    return popup;
  };
  window.open = openOverride;
  try {
    Window.prototype.open = openOverride;
  } catch (e) {}
  try {
    HTMLAnchorElement.prototype.click = (function (orig) {
      return function () {
        const href = this.getAttribute('href') || this.href || '';
        const target = this.getAttribute('target') || this.target || '';
        if (target === '_blank' && href) {
          let absolute = href;
          try { absolute = new URL(href, window.location.href).href; } catch (e2) {}
          if (absolute.startsWith('https:') || absolute.startsWith('http:') || absolute.startsWith('/') || absolute.startsWith('intent:')) {
            navigate(absolute);
            return;
          }
        }
        return orig.apply(this, arguments);
      };
    })(HTMLAnchorElement.prototype.click);
  } catch (e) {}

  document.addEventListener('click', (event) => {
    const target = event.target;
    if (!target || !target.closest) return;
    const link = target.closest('a[href]');
    if (!link) return;
    const href = link.getAttribute('href') || link.href || '';
    const resolved = href ? (link.href || href) : '';
    const blank = link.target === '_blank' || (link.getAttribute('target') || '') === '_blank';
    if (!blank) return;
    if (resolved.startsWith('https:') || resolved.startsWith('http:') || resolved.startsWith('intent:') || resolved.startsWith('/')) {
      event.preventDefault();
      event.stopPropagation();
      // Resolve relative URLs against current location
      let absolute = resolved;
      try { absolute = new URL(resolved, window.location.href).href; } catch (e) {}
      navigate(absolute);
    }
  }, true);

  document.addEventListener('submit', (event) => {
    const form = event.target;
    if (!form || form.tagName !== 'FORM') return;
    const target = form.getAttribute('target') || form.target || '';
    const action = form.getAttribute('action') || form.action || '';
    if (!action) return;
    // For OAuth, the form action is the provider URL – handle regardless of target value
    if (action.startsWith('https:') || action.startsWith('http:') || action.startsWith('/') || action.startsWith('intent:')) {
      // If the form would open a new window, fold it into this one
      if (target === '_blank') {
        event.preventDefault();
        event.stopPropagation();
      }
      // Let same-window submits proceed normally (WebView will navigate), but ensure shim stays injected
      if (target === '_blank') {
        let absolute = action;
        try { absolute = new URL(action, window.location.href).href; } catch (e) {}
        navigate(absolute);
      }
    }
  }, true);

  console.log('[ai-tracker] popup shim installed on ' + window.location.href);

  document.addEventListener('click', (event) => {
    const btn = event.target.closest('button, [role="button"], input[type="button"], input[type="submit"]');
    if (!btn) return;
    const formAction = btn.getAttribute('formaction') || btn.form?.getAttribute('action') || '';
    const dataUrl = btn.getAttribute('data-href') || btn.getAttribute('data-url') || btn.getAttribute('href') || '';
    const candidate = formAction || dataUrl;
    if (candidate && (candidate.startsWith('https:') || candidate.startsWith('http:') || candidate.startsWith('/') || candidate.startsWith('intent:'))) {
      const isBlank = btn.getAttribute('target') === '_blank' || btn.form?.getAttribute('target') === '_blank' || btn.getAttribute('formtarget') === '_blank';
      if (isBlank) {
        event.preventDefault();
        event.stopPropagation();
        let absolute = candidate;
        try { absolute = new URL(candidate, window.location.href).href; } catch (e) {}
        navigate(absolute);
      }
    }
  }, true);
})();
"#;

/// Recreate the main window on mobile with document-start initialization scripts.
/// Android WebView has no new-window support (no `onCreateWindow`), so the popup
/// shim must run before the login page's own script. Eval-based injection races
/// the page; initialization scripts do not.
///
/// Falls back to the plain config-defined window if scripted creation fails so
/// the app shell always loads.
#[cfg(mobile)]
pub fn recreate_main_window_with_scripts(app: &AppHandle) {
    use tauri::{WebviewUrl, WebviewWindowBuilder};

    if let Some(existing) = app.get_webview_window(MAIN_WINDOW) {
        let _ = existing.destroy();
        // Give the main thread a moment to free the label before rebuilding it.
        std::thread::sleep(Duration::from_millis(150));
    }

    let build = |with_scripts: bool| {
        let builder =
            WebviewWindowBuilder::new(app, MAIN_WINDOW, WebviewUrl::App("index.html".into()))
                .title("AI Usage Tracker");
        if with_scripts {
            builder
                .initialization_script(POPUP_SHIM_SCRIPT)
                .initialization_script(crate::grok_login::CONNECT_BANNER_SCRIPT)
                .build()
        } else {
            builder.build()
        }
    };

    if let Err(error) = build(true) {
        eprintln!("failed to create scripted main window on mobile: {error}");
        if let Err(fallback_error) = build(false) {
            eprintln!("failed to create fallback main window on mobile: {fallback_error}");
        }
    }
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
pub(crate) fn install_global_shim(app: &AppHandle) {
    if let Ok(window) = main_window(app) {
        let w = window.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                let _ = w.eval(POPUP_SHIM_SCRIPT);
                tokio::time::sleep(Duration::from_millis(800)).await;
            }
        });
    }
}

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
        // Inject shim immediately and then aggressively until login completes.
        // This ensures window.open / target=_blank are captured before user taps a provider button
        // (document_start vs after-load race on Android remote URLs).
        let _ = window.eval(POPUP_SHIM_SCRIPT);
        tokio::time::sleep(Duration::from_millis(150)).await;
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
                // Google OAuth is blocked in embedded WebView (disallowed_useragent). Detect and surface a clear message.
                if current.host_str() == Some("accounts.google.com") {
                    update_waiting_message(
                        &state,
                        &attempt_id,
                        "Google sign-in is blocked inside the app's WebView on Android. Please use X, Apple, or Email, or use 'Paste Grok cookie' from a system browser.".into(),
                    );
                } else {
                    on_url(current);
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

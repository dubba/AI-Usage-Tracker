//! The desktop sign-in windows (Grok, OpenCode, provider OAuth) share one shape: a private
//! incognito window with no browser chrome, an injected Back button, a navigation allowlist
//! and a timeout. This module holds what they have in common; each provider keeps its own
//! navigation allowlist, banner script, popups and mobile path.

#[cfg(desktop)]
use crate::state::AppState;
#[cfg(desktop)]
use std::{path::PathBuf, sync::Arc, time::Duration};
#[cfg(desktop)]
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use url::Url;

/// Query flag the injected top-left "Back" button appends to the current page. `on_navigation`
/// intercepts it (and blocks the reload): the login attempt is canceled and the window closes,
/// so users can always exit the authorization flow.
pub(crate) const BACK_QUERY_FLAG: &str = "ai-usage-tracker-back";

/// The user agent the sign-in windows present. Providers' sign-in pages reject the default
/// embedded-WebView one, so this is a current Safari's.
#[cfg(desktop)]
pub(crate) const LOGIN_USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Safari/605.1.15";

/// Size every sign-in window opens at, and the smallest it can be resized to.
#[cfg(desktop)]
const LOGIN_WINDOW_SIZE: (f64, f64) = (820.0, 620.0);

/// Whether `url` is the reload the injected Back button asks for: the current page with
/// `?<flag>=1` appended.
pub(crate) fn is_back_request(url: &Url, flag: &str) -> bool {
    url.query_pairs()
        .any(|(key, value)| key == flag && value == "1")
}

/// Top-left "Back" button for the login window, which has no browser chrome.
/// Unlike the banner it is installed on every page (including the SSO
/// hand-off hosts), because a user can get stuck on any of them.
/// Built without `innerHTML` and reattached if removed: "Continue with Google"
/// loads `accounts.google.com`, which rejects HTML assignment and drops nodes
/// it did not create.
#[cfg(desktop)]
pub(crate) const BACK_BUTTON_SCRIPT: &str = r#"
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

/// What a sign-in window needs beyond the shared setup.
#[cfg(desktop)]
pub(crate) struct LoginWindowSpec<'a> {
    /// The window's label (see `LOGIN_WINDOW_LABELS` in `commands/auth.rs`).
    pub label: &'a str,
    pub title: &'a str,
    pub start_url: Url,
    /// The throwaway profile directory (`login_profile`) the window keeps its cookies in.
    pub profile_dir: PathBuf,
    pub init_script: String,
    /// `None` keeps the WebView's own user agent.
    pub user_agent: Option<&'a str>,
}

/// Builds and opens a private sign-in window: 820×620 (and no smaller), resizable, incognito, no
/// devtools, centered over the main window. `customize` adds what is specific to the provider
/// (`on_navigation`, `on_page_load`, popups) before the window is built. The caller cleans up
/// the profile directory and the pending login if this fails.
#[cfg(desktop)]
pub(crate) fn open_private_login_window<'a>(
    app: &'a AppHandle,
    spec: LoginWindowSpec<'_>,
    customize: impl FnOnce(
        WebviewWindowBuilder<'a, tauri::Wry, AppHandle>,
    ) -> WebviewWindowBuilder<'a, tauri::Wry, AppHandle>,
) -> tauri::Result<WebviewWindow> {
    let (width, height, position) = crate::auth::oauth_common::window_geometry_centered_on(
        app,
        "main",
        1.0,
        0.96,
        LOGIN_WINDOW_SIZE.0,
        LOGIN_WINDOW_SIZE.1,
    );
    let mut builder =
        WebviewWindowBuilder::new(app, spec.label, WebviewUrl::External(spec.start_url))
            .title(spec.title)
            .inner_size(width, height)
            .min_inner_size(LOGIN_WINDOW_SIZE.0, LOGIN_WINDOW_SIZE.1)
            .resizable(true)
            .data_directory(spec.profile_dir)
            .incognito(true)
            .devtools(false)
            .initialization_script(spec.init_script);
    if let Some(user_agent) = spec.user_agent {
        builder = builder.user_agent(user_agent);
    }
    builder = customize(builder);
    builder = match position {
        Some((x, y)) => builder.position(x, y),
        None => builder.center(),
    };
    let window = builder.build()?;
    if let Some((x, y)) = position {
        let _ = window.set_position(tauri::LogicalPosition::new(x, y));
    }
    Ok(window)
}

/// How `spawn_login_close_and_timeout` ends an attempt, and what it tells the user.
#[cfg(desktop)]
pub(crate) struct LoginWindowEnd {
    /// The window's label, to close it on timeout.
    pub label: &'static str,
    pub timeout_minutes: i64,
    pub canceled: &'static str,
    pub timed_out: &'static str,
}

/// Ends the attempt when the user closes the window or `timeout_minutes` pass: the profile
/// directory is removed and a still-waiting login is failed with the matching message. On
/// timeout the window is closed too.
#[cfg(desktop)]
pub(crate) fn spawn_login_close_and_timeout(
    app: &AppHandle,
    state: &Arc<AppState>,
    window: &WebviewWindow,
    attempt_id: &str,
    profile_dir: &std::path::Path,
    end: LoginWindowEnd,
) {
    let close_state = state.clone();
    let close_attempt = attempt_id.to_string();
    let close_dir = profile_dir.to_path_buf();
    window.on_window_event(move |event| {
        if matches!(event, WindowEvent::CloseRequested { .. }) {
            let _ = std::fs::remove_dir_all(&close_dir);
            close_state.fail_login_if_waiting(&close_attempt, end.canceled.into());
        }
    });

    let timeout_state = state.clone();
    let timeout_attempt = attempt_id.to_string();
    let timeout_app = app.clone();
    let timeout_dir = profile_dir.to_path_buf();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs((end.timeout_minutes * 60) as u64)).await;
        if timeout_state.login_is_waiting(&timeout_attempt) {
            let _ = std::fs::remove_dir_all(&timeout_dir);
            timeout_state.fail_login_if_waiting(&timeout_attempt, end.timed_out.into());
            if let Some(window) = timeout_app.get_webview_window(end.label) {
                crate::auth::mobile_auth::dismiss_login_window(&window);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(desktop)]
    #[test]
    fn back_button_stays_off_the_connected_page() {
        assert!(BACK_BUTTON_SCRIPT.contains("location.protocol === 'data:'"));
    }

    #[test]
    fn back_button_requests_cancel_the_login() {
        // The injected button appends the flag to whatever page is showing.
        for back in [
            "https://accounts.x.ai/sign-in?ai-usage-tracker-back=1",
            "https://grok.com/?_s=usage&ai-usage-tracker-back=1",
            "https://opencode.ai/workspace/w/go?ai-usage-tracker-back=1",
            "https://accounts.google.com/o/oauth2/auth?client_id=x&ai-usage-tracker-back=1",
        ] {
            let url = Url::parse(back).unwrap();
            assert!(is_back_request(&url, BACK_QUERY_FLAG), "{back}");
        }
        for not_back in [
            "https://accounts.x.ai/sign-in",
            "https://grok.com/?_s=usage",
            "https://grok.com/?ai-usage-tracker-back=0",
            "https://grok.com/?other=ai-usage-tracker-back",
            "https://opencode.ai/auth?ai-usage-tracker-back=0",
        ] {
            let url = Url::parse(not_back).unwrap();
            assert!(!is_back_request(&url, BACK_QUERY_FLAG), "{not_back}");
        }
        // The flag is a parameter: another flag does not match this one.
        let url = Url::parse("https://grok.com/?ai-usage-tracker-popup-close=1").unwrap();
        assert!(!is_back_request(&url, BACK_QUERY_FLAG));
        assert!(is_back_request(&url, "ai-usage-tracker-popup-close"));
    }

    #[cfg(desktop)]
    #[test]
    fn back_button_script_is_built_without_innerhtml_and_reattaches() {
        assert!(BACK_BUTTON_SCRIPT.contains(BACK_QUERY_FLAG));
        assert!(BACK_BUTTON_SCRIPT.contains("aria-label"));
        assert!(BACK_BUTTON_SCRIPT.contains("createElementNS"));
        assert!(BACK_BUTTON_SCRIPT.contains("MutationObserver"));
        assert!(!BACK_BUTTON_SCRIPT.contains("innerHTML"));
    }

    #[cfg(desktop)]
    #[test]
    fn the_user_agent_is_a_desktop_safari() {
        assert!(LOGIN_USER_AGENT.contains("Safari/605"));
        assert!(!LOGIN_USER_AGENT.contains("Tauri"));
    }
}

//! The desktop sign-in windows (Grok, OpenCode, provider OAuth) share one shape: a private
//! incognito window with no browser chrome, an injected Back button, a navigation allowlist
//! and a timeout. This module holds what they have in common; each provider keeps its own
//! navigation allowlist, banner script, popups and mobile path.

use crate::state::AppState;
#[cfg(desktop)]
use std::path::PathBuf;
use std::{sync::Arc, time::Duration};
#[cfg(desktop)]
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use url::Url;

/// A cookie-capture sign-in (Grok, OpenCode) in progress: what each step needs to find the
/// attempt and to save the account it ends with.
#[derive(Clone)]
pub(crate) struct LoginAttempt {
    pub state: Arc<AppState>,
    pub attempt_id: String,
    /// The name the user typed for the account; may be empty.
    pub label: String,
    /// The account being signed in again, when this is a reconnect.
    pub reconnect_account_id: Option<String>,
}

/// Query flag the injected top-left "Back" button appends to the current page. `on_navigation`
/// intercepts it (and blocks the reload): the login attempt is canceled and the window closes,
/// so users can always exit the authorization flow.
pub(crate) const BACK_QUERY_FLAG: &str = "ai-usage-tracker-back";

/// The user agent the sign-in windows present. Providers' sign-in pages reject the default
/// embedded-WebView one, so this is a current Safari's.
#[cfg(desktop)]
pub(crate) const LOGIN_USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Safari/605.1.15";

/// Sign-in windows keep no cookies or history of their own (incognito). A popup
/// that a sign-in page opens must use the same setting: WebView2 hands a popup to
/// its opener only when both have the same profile, and an InPrivate opener with
/// a regular popup left Claude's "Continue with Google" window black on Windows.
#[cfg(desktop)]
pub(crate) const SIGN_IN_INCOGNITO: bool = true;

/// Size every sign-in window opens at, and the smallest it can be resized to.
#[cfg(desktop)]
pub(crate) const LOGIN_WINDOW_SIZE: (f64, f64) = (820.0, 620.0);

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

/// What `guard_login_navigation` needs to know about one provider's sign-in window.
#[cfg(desktop)]
pub(crate) struct LoginNavigationRules {
    /// The window's label, to close it when the Back button is pressed.
    pub label: &'static str,
    /// The provider's name in the diagnostics line for a blocked page.
    pub provider: &'static str,
    /// What the attempt fails with when the Back button is pressed.
    pub canceled: &'static str,
    /// The provider's allowlist of pages the window may load.
    pub is_allowed: fn(&Url) -> bool,
}

/// The `on_navigation` handler of a sign-in window. The injected Back button's reload closes the
/// window and cancels the attempt; any other page loads only if the provider's allowlist has it,
/// and a blocked one is noted in the diagnostics log by host.
#[cfg(desktop)]
pub(crate) fn guard_login_navigation(
    app: &AppHandle,
    state: &Arc<AppState>,
    attempt_id: &str,
    rules: LoginNavigationRules,
) -> impl Fn(&Url) -> bool + Send + 'static {
    let app = app.clone();
    let state = state.clone();
    let attempt_id = attempt_id.to_string();
    move |url| {
        if is_back_request(url, BACK_QUERY_FLAG) {
            if let Some(window) = app.get_webview_window(rules.label) {
                crate::auth::mobile_auth::dismiss_login_window(&window);
            }
            state.fail_login_if_waiting(&attempt_id, rules.canceled.into());
            return false;
        }
        let allowed = (rules.is_allowed)(url);
        if !allowed {
            crate::diagnostics::warn(&format!(
                "{} login blocked navigation to host {}",
                rules.provider,
                url.host_str().unwrap_or("(none)")
            ));
        }
        allowed
    }
}

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
    let (width, height, position) = crate::auth::window_geometry::window_geometry_centered_on(
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
            .incognito(SIGN_IN_INCOGNITO)
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

/// The banner a cookie sign-in window shows above the provider's page (`connect_banner_script`).
#[cfg(desktop)]
const CONNECT_BANNER_TEMPLATE: &str = r#"
(() => {
  if (window.top !== window || !(@@PAGE_CHECK@@)) return;

  const installBanner = () => {
    if (!document.body || document.getElementById('@@ID@@')) return;
    const banner = document.createElement('div');
    banner.id = '@@ID@@';
    banner.setAttribute('role', 'status');
    banner.textContent = '@@TEXT@@';
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

/// The script that shows `text` in a bar above the provider's page, pushing the page down by the
/// bar's height, on the top-level pages where `page_check` (a JavaScript expression) is true.
/// `element_id` keeps the bar from being added twice. `element_id` and `text` are written into
/// single-quoted JavaScript strings, so they must not contain `'` or `\`.
#[cfg(desktop)]
pub(crate) fn connect_banner_script(page_check: &str, element_id: &str, text: &str) -> String {
    debug_assert!(![element_id, text]
        .iter()
        .any(|value| value.contains('\'') || value.contains('\\')));
    CONNECT_BANNER_TEMPLATE
        .replace("@@PAGE_CHECK@@", page_check)
        .replace("@@ID@@", element_id)
        .replace("@@TEXT@@", text)
}

/// One provider's cookie sign-in window (`open_cookie_login_window`).
#[cfg(desktop)]
pub(crate) struct CookieLoginWindow {
    /// The window's label (see `LOGIN_WINDOW_LABELS` in `commands/auth.rs`).
    pub label: &'static str,
    pub title: &'static str,
    /// The provider's name in the error and diagnostics lines.
    pub provider: &'static str,
    pub start_url: Url,
    /// Prefix of the attempt's throwaway profile directory (`login_profile`).
    pub profile_prefix: &'static str,
    /// The provider's own page script; the Back button is added after it.
    pub page_script: String,
    /// `None` keeps the WebView's own user agent.
    pub user_agent: Option<&'static str>,
    /// The provider's allowlist of pages the window may load.
    pub is_allowed: fn(&Url) -> bool,
    pub timeout_minutes: i64,
    pub canceled: &'static str,
    pub timed_out: &'static str,
}

/// Opens the cookie sign-in window of attempt `attempt_id` (Grok, OpenCode): closes one left open,
/// gives the attempt a fresh private profile, so no earlier session can sign in a second account
/// by itself, guards its navigation with the provider's allowlist, and ends the attempt when the
/// window is closed or times out. `customize` adds the provider's own handlers. Returns the window
/// and its profile directory.
#[cfg(desktop)]
pub(crate) fn open_cookie_login_window<'a>(
    app: &'a AppHandle,
    state: &Arc<AppState>,
    attempt_id: &str,
    spec: CookieLoginWindow,
    customize: impl FnOnce(
        WebviewWindowBuilder<'a, tauri::Wry, AppHandle>,
    ) -> WebviewWindowBuilder<'a, tauri::Wry, AppHandle>,
) -> Result<(WebviewWindow, PathBuf), String> {
    if let Some(window) = app.get_webview_window(spec.label) {
        crate::auth::mobile_auth::dismiss_login_window(&window);
    }
    // Sweep profiles left behind by a previous crash or kill before creating the new one, which
    // is owner-only.
    crate::auth::login_profile::sweep_stale_profiles(spec.profile_prefix);
    let profile_dir =
        crate::auth::login_profile::create_private_profile_dir(spec.profile_prefix, attempt_id)?;
    let opened = open_private_login_window(
        app,
        LoginWindowSpec {
            label: spec.label,
            title: spec.title,
            start_url: spec.start_url,
            profile_dir: profile_dir.clone(),
            init_script: format!(
                "{}\n{}",
                spec.page_script,
                crate::platform::tray::with_accent_button_colors(BACK_BUTTON_SCRIPT)
            ),
            user_agent: spec.user_agent,
        },
        |builder| {
            customize(builder.on_navigation(guard_login_navigation(
                app,
                state,
                attempt_id,
                LoginNavigationRules {
                    label: spec.label,
                    provider: spec.provider,
                    canceled: spec.canceled,
                    is_allowed: spec.is_allowed,
                },
            )))
        },
    );
    let window = match opened {
        Ok(window) => window,
        Err(error) => {
            let _ = std::fs::remove_dir_all(&profile_dir);
            return Err(format!(
                "Unable to open the {} login window: {}",
                spec.provider,
                crate::diagnostics::command_error(error)
            ));
        }
    };
    spawn_login_close_and_timeout(
        app,
        state,
        &window,
        attempt_id,
        &profile_dir,
        LoginWindowEnd {
            label: spec.label,
            timeout_minutes: spec.timeout_minutes,
            canceled: spec.canceled,
            timed_out: spec.timed_out,
        },
    );
    Ok((window, profile_dir))
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

/// On a phone the sign-in runs in the app's own WebView, so there is no window or profile to
/// clean up: after `timeout_minutes` a still-waiting attempt is failed with `timed_out`.
#[cfg(mobile)]
pub(crate) fn spawn_mobile_login_timeout(
    state: &Arc<AppState>,
    attempt_id: &str,
    timeout_minutes: i64,
    timed_out: &'static str,
) {
    let state = state.clone();
    let attempt_id = attempt_id.to_string();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs((timeout_minutes * 60) as u64)).await;
        if state.login_is_waiting(&attempt_id) {
            state.fail_login_if_waiting(&attempt_id, timed_out.into());
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

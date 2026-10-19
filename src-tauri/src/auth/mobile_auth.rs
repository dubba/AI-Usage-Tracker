#[cfg(mobile)]
use crate::state::AppState;
use std::sync::atomic::{AtomicU8, Ordering};
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
#[cfg(mobile)]
const SUCCESS_DISPLAY_DELAY: Duration = crate::auth::oauth_common::CONNECTED_PAGE_DISPLAY;
/// How long a finished sign-in waits for its result page to be shown before
/// starting `SUCCESS_DISPLAY_DELAY` anyway.
#[cfg(mobile)]
const RESULT_PAGE_WAIT_LIMIT: Duration = Duration::from_secs(3);

/// Where the main window is with the sign-in's result page ("Account
/// connected"), reported by the signin-navigation plugin's hooks. The page's
/// countdown starts when it is shown, so the app times its return from then.
static RESULT_PAGE: AtomicU8 = AtomicU8::new(RESULT_PAGE_NONE);
const RESULT_PAGE_NONE: u8 = 0;
const RESULT_PAGE_REQUESTED: u8 = 1;
const RESULT_PAGE_SHOWN: u8 = 2;

/// The main window started loading a page (the navigation guard allowed it).
#[cfg_attr(not(any(test, mobile)), allow(dead_code))]
pub(crate) fn note_main_navigation(url: &Url) {
    if crate::auth::oauth_common::is_result_page(url) {
        RESULT_PAGE.fetch_max(RESULT_PAGE_REQUESTED, Ordering::SeqCst);
        #[cfg(target_os = "android")]
        set_android_sign_in_result_showing(true);
    }
}

/// The main window finished loading a page.
#[cfg_attr(not(any(test, mobile)), allow(dead_code))]
pub(crate) fn note_main_page_loaded(url: &Url, dev_url: Option<&Url>) {
    if crate::auth::oauth_common::is_result_page(url) {
        RESULT_PAGE.store(RESULT_PAGE_SHOWN, Ordering::SeqCst);
        #[cfg(target_os = "android")]
        set_android_sign_in_result_showing(true);
    } else if crate::auth::signin_navigation::is_app_page(url, dev_url) {
        #[cfg(target_os = "android")]
        {
            set_android_sign_in_result_showing(false);
            clear_android_web_view_history();
        }
    }
}

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
#[cfg_attr(not(any(test, mobile)), allow(dead_code))]
const BACK_FRAGMENT: &str = "ai-usage-tracker-back";

/// The single-WebView login has no browser chrome, so this adds a fixed
/// "Back to AI Usage Tracker" button and an opaque matching header bar to the
/// top of every provider page, and pads the document so provider page content
/// begins below the button and status bar without overlap.
/// Tapping it sets the fragment below, which the poll loop treats as a
/// cancel: the attempt is abandoned and the app page is restored.
///
/// Antigravity's page is `accounts.google.com`, which requires Trusted Types
/// and rejects `innerHTML`. The elements are built with DOM APIs and attached to
/// `<html>`, then put back if that page removes them.
#[cfg_attr(not(any(test, mobile)), allow(dead_code))]
const BACK_BUTTON_SCRIPT: &str = r#"
(() => {
  try {
    if (window.top !== window.self) return;
    const root = document.documentElement;
    if (!root) return;
    const offset = 'calc(max(env(safe-area-inset-top, 0px), 28px) + 44px)';
    const headerId = '__ai_tracker_header';
    const buttonId = '__ai_tracker_back';
    const getBg = () => {
      try {
        const parse = (c) => (c && c !== 'transparent' && c !== 'rgba(0, 0, 0, 0)') ? c : null;
        const bodyBg = document.body && parse(window.getComputedStyle(document.body).backgroundColor);
        if (bodyBg) return bodyBg;
        const rootBg = parse(window.getComputedStyle(root).backgroundColor);
        if (rootBg) return rootBg;
      } catch (e) {}
      return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? '#131314' : '#ffffff';
    };
    const install = () => {
      const docEl = document.documentElement;
      if (!docEl) return;
      if (docEl.style.getPropertyValue('padding-top') !== offset) {
        docEl.style.setProperty('box-sizing', 'border-box', 'important');
        docEl.style.setProperty('padding-top', offset, 'important');
      }
      if (document.body && document.body.style.boxSizing !== 'border-box') {
        document.body.style.setProperty('box-sizing', 'border-box', 'important');
      }
      let header = document.getElementById(headerId);
      if (!header) {
        header = document.createElement('div');
        header.id = headerId;
        header.setAttribute('aria-hidden', 'true');
        docEl.appendChild(header);
      }
      header.style.cssText = [
        'position:fixed', 'top:0', 'left:0', 'right:0', 'width:100%',
        'height:' + offset, 'z-index:2147483646', 'background:' + getBg(),
        'pointer-events:none',
      ].join(';');

      if (document.getElementById(buttonId)) return;
      const button = document.createElement('button');
      button.id = buttonId;
      button.type = 'button';
      button.setAttribute('aria-label', 'Back to AI Usage Tracker');
      button.style.cssText = [
        'position:fixed', 'top:max(env(safe-area-inset-top, 0px), 28px)', 'left:8px', 'z-index:2147483647',
        'display:inline-flex', 'align-items:center', 'gap:7px',
        'padding:8px 16px 8px 11px', 'border:0', 'border-radius:999px', 'background:#6d3bd7', 'color:#fff',
        'font:700 15px -apple-system,system-ui,sans-serif', 'line-height:1', 'box-shadow:0 2px 10px rgba(0,0,0,.4)',
      ].join(';');
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('width', '10');
      svg.setAttribute('height', '16');
      svg.setAttribute('fill', 'none');
      svg.setAttribute('stroke', 'currentColor');
      svg.setAttribute('stroke-width', '2.6');
      svg.setAttribute('stroke-linecap', 'round');
      svg.setAttribute('stroke-linejoin', 'round');
      svg.setAttribute('aria-hidden', 'true');
      svg.style.display = 'block';
      svg.style.flex = 'none';
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', 'm15 18-6-6 6-6');
      svg.appendChild(path);
      const label = document.createElement('span');
      label.textContent = 'Back to AI Usage Tracker';
      button.appendChild(svg);
      button.appendChild(label);
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        location.hash = 'ai-usage-tracker-back';
      }, true);
      docEl.appendChild(button);
    };
    install();
    if (window.__aiTrackerBackRoot !== root) {
      window.__aiTrackerBackRoot = root;
      new MutationObserver(install).observe(root, { childList: true });
    }
  } catch (e) {}
})();
"#;

/// wry only implements `window.open` popups on macOS, so on iOS the call silently returns null and
/// "Continue with Google" never opens. Opening the target in the same WebView lets the redirect
/// flows (ChatGPT, Antigravity, Grok) finish. A Google Identity Services popup (Claude) is the
/// exception: it hands the result back through `window.opener`, so it gets a real popup from
/// ios_popups.rs, and in the same window it would end on a blank page.
#[cfg_attr(not(any(test, target_os = "ios")), allow(dead_code))]
const IOS_POPUP_SCRIPT: &str = r#"
(() => {
  try {
    if (window.__aiTrackerPopup) return;
    window.__aiTrackerPopup = true;
    const nativeOpen = window.open;
    const needsOpener = (target) => {
      try {
        const url = new URL(target, location.href);
        return url.protocol === 'https:' && url.hostname === 'accounts.google.com'
          && (url.searchParams.get('display') === 'popup' || url.searchParams.has('gsiwebsdk'));
      } catch (e) {
        return false;
      }
    };
    window.open = function (url) {
      const target = url ? String(url) : '';
      if (needsOpener(target)) return nativeOpen.apply(window, arguments);
      if (target) location.href = target;
      return null;
    };
  } catch (e) {}
})();
"#;

#[cfg_attr(not(any(test, mobile)), allow(dead_code))]
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

/// Drops provider cookies in the in-app WebView so the next sign-in asks for
/// an account instead of reusing the last one. Stored account secrets in the
/// app are not touched. Failure is logged without cookie values and does not
/// block the login.
#[cfg(mobile)]
pub(crate) fn forget_provider_sign_in(window: &WebviewWindow) {
    #[cfg(target_os = "android")]
    {
        let _ = window;
        if let Err(error) = clear_android_sign_in_cookies() {
            crate::diagnostics::warn(&format!("Sign-in session reset failed: {error}"));
        }
    }
    #[cfg(target_os = "ios")]
    {
        if let Err(error) = crate::auth::ios_cookies::delete_cookies(
            window,
            crate::auth::signin_navigation::cookie_domain_is_sign_in,
        ) {
            crate::diagnostics::warn(&format!("Sign-in session reset failed: {error}"));
        }
    }
}

#[cfg(target_os = "android")]
fn clear_android_sign_in_cookies() -> Result<(), String> {
    const PREFIX: &str = "Unable to reset the sign-in session";
    crate::platform::android_context::with_activity(PREFIX, |env, activity| {
        let result = env.call_method(activity, "clearWebViewCookies", "()Z", &[]);
        if env.exception_check().unwrap_or(false) {
            let _ = env.exception_clear();
            return Err(PREFIX.to_string());
        }
        match result.and_then(|value| value.z()) {
            Ok(true) => Ok(()),
            _ => Err(PREFIX.to_string()),
        }
    })
}

#[cfg(target_os = "android")]
pub(crate) fn clear_android_web_view_history() {
    let _ =
        crate::platform::android_context::with_activity("clearWebViewHistory", |env, activity| {
            let _ = env.call_method(activity, "clearWebViewHistory", "()V", &[]);
            if env.exception_check().unwrap_or(false) {
                let _ = env.exception_clear();
            }
            Ok(())
        });
}

/// Tells the activity whether the sign-in's "Account connected" page is on screen, so the system
/// back gesture there returns to the dashboard instead of stepping back through the login pages.
#[cfg(target_os = "android")]
pub(crate) fn set_android_sign_in_result_showing(showing: bool) {
    let result = crate::platform::android_context::with_activity(
        "setSignInResultShowing",
        |env, activity| {
            let call = env.call_method(
                activity,
                "setSignInResultShowing",
                "(Z)V",
                &[showing.into()],
            );
            if env.exception_check().unwrap_or(false) {
                let _ = env.exception_clear();
                return Err("The activity rejected the sign-in page state.".to_string());
            }
            call.map(|_| ()).map_err(|error| error.to_string())
        },
    );
    if let Err(error) = result {
        crate::diagnostics::warn(&format!("Sign-in page state was not delivered: {error}"));
    }
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
    // Clear the previous provider session before the page loads, and before a
    // cookie poll can read it. The app URL above is already saved for restore.
    forget_provider_sign_in(&window);
    RESULT_PAGE.store(RESULT_PAGE_NONE, Ordering::SeqCst);
    // Claude's "Continue with Google" needs a real popup (see IOS_POPUP_SCRIPT).
    #[cfg(target_os = "ios")]
    crate::auth::ios_popups::install(&window);

    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(NAVIGATE_DELAY).await;
        if !attempt_matches(&state, &attempt_id) {
            return;
        }
        let oauth_start = target.clone();
        if let Err(error) = window.navigate(target) {
            state.fail_login_if_waiting(
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
            let waiting = state.login_is_waiting(&attempt_id);
            let exchange_queued = state
                .pending_auth_exchange
                .lock()
                .as_ref()
                .is_some_and(|pending| pending.attempt_id == attempt_id);
            if !waiting || exchange_queued {
                // If login completed successfully, keep the connected confirmation page visible
                // for 3 seconds so the user can see their linked account details.
                let is_completed = state.pending_login.read().as_ref().is_some_and(|login| {
                    login.attempt_id == attempt_id
                        && login.status == crate::model::LoginState::Complete
                });
                if is_completed {
                    // From here the page on screen is the result page, or about to be.
                    #[cfg(target_os = "android")]
                    set_android_sign_in_result_showing(true);
                    let shown_by_app = show_result_page(&window, &state, &attempt_id).await;
                    // Again, now the page is on screen: the history is cleared after the
                    // navigation that added it, so back reaches the activity's handler.
                    #[cfg(target_os = "android")]
                    set_android_sign_in_result_showing(true);
                    if shown_by_app {
                        crate::auth::oauth_common::run_connected_countdown(&window).await;
                    } else {
                        tokio::time::sleep(SUCCESS_DISPLAY_DELAY).await;
                    }
                }
                if let Ok(current) = window.url() {
                    if !urls_share_origin(&current, &restore_url) {
                        let _ = window.navigate(restore_url);
                    }
                } else {
                    let _ = window.navigate(restore_url);
                }
                #[cfg(target_os = "android")]
                clear_android_web_view_history();
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
                #[cfg(mobile)]
                {
                    if is_back_request(&current) {
                        state.fail_login_if_waiting(&attempt_id, "Sign-in was canceled.".into());
                        state.abort_login_resources(&attempt_id);
                        let _ = window.navigate(restore_url);
                        #[cfg(target_os = "android")]
                        clear_android_web_view_history();
                        break;
                    }
                    if !urls_share_origin(&current, &restore_url)
                        && matches!(current.scheme(), "http" | "https")
                    {
                        let _ = window.eval(BACK_BUTTON_SCRIPT);
                        #[cfg(target_os = "ios")]
                        let _ = window.eval(IOS_POPUP_SCRIPT);
                        #[cfg(target_os = "ios")]
                        close_stale_popups(&window, &current);
                    }
                }
                on_url(current.clone());
                if urls_share_origin(&current, &restore_url) {
                    if left_app_shell {
                        let _ = state.abandon_waiting_login(&attempt_id);
                        #[cfg(target_os = "android")]
                        clear_android_web_view_history();
                        break;
                    }
                } else {
                    left_app_shell = true;
                }
            }
        }
        // A sign-in popup must not outlive the sign-in that opened it.
        #[cfg(target_os = "ios")]
        crate::auth::ios_popups::close_all(&window);
    });
    Ok(())
}

/// A sign-in popup (Claude's Google Identity Services one) hands its result to
/// the main window through `window.opener` and then calls `window.close()`, but
/// on iOS that close is not always delivered and the popup covers the page the
/// sign-in moved on to. Once the main window navigates past the page the popup
/// opened from, the popup's job is done, so close it. The popup records that
/// page itself when it is created, so a quick hand-over between two polls
/// cannot make the poll loop adopt the new page as the one to compare with.
#[cfg(target_os = "ios")]
fn close_stale_popups(window: &WebviewWindow, current: &Url) {
    if !crate::auth::ios_popups::any_open() {
        return;
    }
    let Some(opened_from) = crate::auth::ios_popups::opened_from() else {
        return;
    };
    if !same_page(&opened_from, current) {
        crate::diagnostics::info("The sign-in moved on behind the popup; closing it.");
        crate::auth::ios_popups::close_all(window);
    }
}

/// Whether two URLs are the same page, ignoring the fragment.
#[cfg_attr(not(any(test, target_os = "ios")), allow(dead_code))]
fn same_page(left: &Url, right: &Url) -> bool {
    urls_share_origin(left, right) && left.path() == right.path() && left.query() == right.query()
}

/// Puts the finished sign-in's "Account connected" page on screen and waits
/// until it is shown, so its countdown and `SUCCESS_DISPLAY_DELAY` run together.
/// OAuth sign-ins get the page from their loopback callback server, which can
/// still be answering when the sign-in is marked complete; the others (Grok,
/// OpenCode) have no such page, so it is shown here. Returns whether the app
/// showed the page, in which case the app also runs its countdown: that page
/// inherits the provider page's Content Security Policy, which can block the
/// page's own script.
#[cfg(mobile)]
async fn show_result_page(window: &WebviewWindow, state: &AppState, attempt_id: &str) -> bool {
    let shown_by_app = RESULT_PAGE.load(Ordering::SeqCst) == RESULT_PAGE_NONE;
    if shown_by_app {
        let account = state
            .pending_login
            .read()
            .as_ref()
            .filter(|login| login.attempt_id == attempt_id)
            .and_then(|login| login.account.clone());
        let Some(page) = account
            .as_ref()
            .and_then(crate::auth::oauth_common::connected_page_url)
        else {
            return false;
        };
        if window.navigate(page).is_err() {
            return false;
        }
    }
    let deadline = tokio::time::Instant::now() + RESULT_PAGE_WAIT_LIMIT;
    while RESULT_PAGE.load(Ordering::SeqCst) != RESULT_PAGE_SHOWN
        && tokio::time::Instant::now() < deadline
    {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    shown_by_app
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_shell_uses_main_label() {
        assert_eq!(MAIN_WINDOW, "main");
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
        assert!(BACK_BUTTON_SCRIPT.contains("max(env(safe-area-inset-top, 0px), 28px)"));
        assert!(BACK_BUTTON_SCRIPT.contains("aria-label"));
        // Centered icon+text row with a real left chevron, not the ‹ glyph hack.
        assert!(BACK_BUTTON_SCRIPT.contains("display:inline-flex"));
        assert!(BACK_BUTTON_SCRIPT.contains("align-items:center"));
        assert!(BACK_BUTTON_SCRIPT.contains("m15 18-6-6 6-6"));
        assert!(BACK_BUTTON_SCRIPT.contains("createElementNS"));
        assert!(!BACK_BUTTON_SCRIPT.contains("innerHTML"));
        assert!(BACK_BUTTON_SCRIPT.contains("__ai_tracker_header"));
        assert!(BACK_BUTTON_SCRIPT.contains("padding-top"));
        assert!(BACK_BUTTON_SCRIPT.contains("box-sizing"));
        assert!(IOS_POPUP_SCRIPT.contains("window.open"));
        // Google Identity Services popups keep the native window.open so window.opener works.
        assert!(IOS_POPUP_SCRIPT.contains("nativeOpen.apply"));
        assert!(IOS_POPUP_SCRIPT.contains("accounts.google.com"));
        assert!(IOS_POPUP_SCRIPT.contains("gsiwebsdk"));
    }

    #[test]
    fn android_sso_popup_installs_the_same_back_button() {
        // The generated Kotlin is gitignored and only exists after a `tauri android` command, so
        // plain checkouts (CI's desktop test job) skip these assertions.
        if let Ok(chrome) = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/gen/android/app/src/main/java/com/dubba/ai/usage/tracker/generated/RustWebChromeClient.kt"
        )) {
            assert!(chrome.contains("createElementNS"));
            assert!(chrome.contains("ai-usage-tracker-back"));
            assert!(chrome.contains("uri.fragment == \"ai-usage-tracker-back\""));
            assert!(chrome.contains("scheme == \"javascript\""));
            assert!(chrome.contains("scheme == \"file\""));
            assert!(chrome.contains("scheme == \"content\""));
            assert!(!chrome.contains("button.innerHTML"));
            assert!(chrome.contains("__ai_tracker_header"));
            assert!(chrome.contains("padding-top"));
            assert!(chrome.contains("box-sizing"));
        }
        let lookalike = "https://accounts.google.com/#ai-usage-tracker-back-extra";
        assert_ne!(
            Url::parse(lookalike).unwrap().fragment(),
            Some("ai-usage-tracker-back")
        );
        assert!(!is_back_request(&Url::parse(lookalike).unwrap()));
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

    #[test]
    fn result_page_is_noted_when_requested_and_when_shown() {
        RESULT_PAGE.store(RESULT_PAGE_NONE, Ordering::SeqCst);
        let login = Url::parse("https://claude.ai/login").unwrap();
        note_main_navigation(&login);
        note_main_page_loaded(&login, None);
        assert_eq!(RESULT_PAGE.load(Ordering::SeqCst), RESULT_PAGE_NONE);

        let callback = Url::parse("http://localhost:1455/auth/callback?code=x&state=y").unwrap();
        note_main_navigation(&callback);
        assert_eq!(RESULT_PAGE.load(Ordering::SeqCst), RESULT_PAGE_REQUESTED);
        note_main_page_loaded(&callback, None);
        assert_eq!(RESULT_PAGE.load(Ordering::SeqCst), RESULT_PAGE_SHOWN);
        // A late navigation report does not undo "shown".
        note_main_navigation(&callback);
        assert_eq!(RESULT_PAGE.load(Ordering::SeqCst), RESULT_PAGE_SHOWN);
    }

    #[test]
    fn same_page_ignores_only_the_fragment() {
        let login = Url::parse("https://claude.ai/login?returnTo=%2Foauth").unwrap();
        let with_fragment = Url::parse("https://claude.ai/login?returnTo=%2Foauth#x").unwrap();
        let authorize = Url::parse("https://claude.ai/oauth/authorize?client_id=a").unwrap();
        let other_query = Url::parse("https://claude.ai/login?returnTo=%2Fother").unwrap();
        let other_host = Url::parse("https://accounts.google.com/login?returnTo=%2Foauth").unwrap();
        assert!(same_page(&login, &login));
        assert!(same_page(&login, &with_fragment));
        assert!(!same_page(&login, &authorize));
        assert!(!same_page(&login, &other_query));
        assert!(!same_page(&login, &other_host));
    }
}

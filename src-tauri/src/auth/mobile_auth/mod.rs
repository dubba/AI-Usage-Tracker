#[cfg(mobile)]
use crate::state::AppState;
use std::sync::atomic::{AtomicU8, Ordering};
#[cfg(mobile)]
use std::sync::Arc;
#[cfg(mobile)]
use std::time::Duration;
#[cfg(mobile)]
use tauri::Manager;
use tauri::{AppHandle, WebviewWindow};
use url::Url;

#[cfg(target_os = "android")]
mod android;
#[cfg(any(test, target_os = "ios"))]
mod ios;

// What the sign-in loop asks of the platform it runs on. Each platform module answers every
// call, with a no-op where it has nothing to do, so the loop itself has no platform switches.
#[cfg(target_os = "android")]
use android as platform;
#[cfg(target_os = "ios")]
use ios as platform;

/// Desktop builds compile the page-load hooks below but never run a sign-in in the main WebView.
#[cfg(not(mobile))]
mod platform {
    pub(super) fn result_page_showing(_showing: bool) {}
    pub(super) fn clear_history() {}
}

const MAIN_WINDOW: &str = "main";
#[cfg(mobile)]
const NAVIGATE_DELAY: Duration = Duration::from_millis(250);
#[cfg(mobile)]
const POLL_INTERVAL: Duration = Duration::from_millis(400);
#[cfg(mobile)]
const SUCCESS_DISPLAY_DELAY: Duration = crate::auth::result_pages::CONNECTED_PAGE_DISPLAY;
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
    if crate::auth::result_pages::is_result_page(url) {
        RESULT_PAGE.fetch_max(RESULT_PAGE_REQUESTED, Ordering::SeqCst);
        platform::result_page_showing(true);
    }
}

/// The main window finished loading a page.
#[cfg_attr(not(any(test, mobile)), allow(dead_code))]
pub(crate) fn note_main_page_loaded(url: &Url, dev_url: Option<&Url>) {
    if crate::auth::result_pages::is_result_page(url) {
        RESULT_PAGE.store(RESULT_PAGE_SHOWN, Ordering::SeqCst);
        platform::result_page_showing(true);
    } else if crate::auth::signin_navigation::is_app_page(url, dev_url) {
        platform::result_page_showing(false);
        platform::clear_history();
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
///
/// The Android sign-in popup injects the same file (`build/android_patches.rs`).
#[cfg_attr(not(any(test, mobile)), allow(dead_code))]
const BACK_BUTTON_SCRIPT: &str = include_str!("back_button.js");

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
/// block the caller. Desktop sign-in uses a separate window, so there is
/// nothing to clear there. A missing window is logged the same way.
pub(crate) fn clear_provider_sign_in_session(app: Option<&AppHandle>) {
    #[cfg(mobile)]
    if let Some(app) = app {
        match main_window(app) {
            Ok(window) => forget_provider_sign_in(&window),
            Err(error) => {
                crate::diagnostics::warn(&format!("Sign-in session reset failed: {error}"));
            }
        }
    }
    #[cfg(not(mobile))]
    let _ = app;
}

/// Drops provider cookies in the in-app WebView so the next sign-in asks for
/// an account instead of reusing the last one. Stored account secrets in the
/// app are not touched. Failure is logged without cookie values and does not
/// block the login.
#[cfg(mobile)]
pub(crate) fn forget_provider_sign_in(window: &WebviewWindow) {
    if let Err(error) = platform::clear_sign_in_cookies(window) {
        crate::diagnostics::warn(&format!("Sign-in session reset failed: {error}"));
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
    // The connected page's close button goes back to the app page.
    crate::auth::result_pages::set_connected_page_close_url(&restore_url);
    RESULT_PAGE.store(RESULT_PAGE_NONE, Ordering::SeqCst);
    // Claude's "Continue with Google" needs a real popup on iOS (see `ios::IOS_POPUP_SCRIPT`).
    platform::install_popups(&window);

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
                    platform::result_page_showing(true);
                    let shown_by_app = show_result_page(&window, &state, &attempt_id).await;
                    // Again, now the page is on screen: the history is cleared after the
                    // navigation that added it, so back reaches the activity's handler.
                    platform::result_page_showing(true);
                    hold_result_page(&window, &state, &attempt_id, &restore_url, shown_by_app)
                        .await;
                }
                // A newer sign-in owns the WebView now (back on the result page returns to the
                // dashboard at once, so the next sign-in can start before this one has finished
                // its countdown). Touching the page or its history here would break that one.
                if !attempt_matches(&state, &attempt_id) {
                    break;
                }
                if let Ok(current) = window.url() {
                    if !urls_share_origin(&current, &restore_url) {
                        let _ = window.navigate(restore_url);
                    }
                } else {
                    let _ = window.navigate(restore_url);
                }
                platform::clear_history();
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
                if is_back_request(&current) {
                    state.fail_login_if_waiting(&attempt_id, "Sign-in was canceled.".into());
                    state.abort_login_resources(&attempt_id);
                    let _ = window.navigate(restore_url);
                    platform::clear_history();
                    break;
                }
                if !urls_share_origin(&current, &restore_url)
                    && matches!(current.scheme(), "http" | "https")
                {
                    let _ = window.eval(crate::platform::tray::with_accent_button_colors(
                        BACK_BUTTON_SCRIPT,
                    ));
                    platform::on_provider_page(&window, &current);
                }
                on_url(current.clone());
                if urls_share_origin(&current, &restore_url) {
                    if left_app_shell {
                        let _ = state.abandon_waiting_login(&attempt_id);
                        platform::clear_history();
                        break;
                    }
                } else {
                    left_app_shell = true;
                }
            }
        }
        // A sign-in popup must not outlive the sign-in that opened it.
        platform::close_popups(&window);
    });
    Ok(())
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
            .and_then(crate::auth::result_pages::connected_page_url)
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

/// Keeps the result page up for `SUCCESS_DISPLAY_DELAY`, counting its number down when the app
/// showed the page (`count_down`). Ends early when the user has left the page (back, or the page's
/// close button, returns to the app's own origin, `restore_url`) or a newer sign-in has replaced
/// this attempt.
#[cfg(mobile)]
async fn hold_result_page(
    window: &WebviewWindow,
    state: &AppState,
    attempt_id: &str,
    restore_url: &Url,
    count_down: bool,
) {
    let seconds = SUCCESS_DISPLAY_DELAY.as_secs();
    for remaining in (0..seconds).rev() {
        tokio::time::sleep(Duration::from_secs(1)).await;
        if !attempt_matches(state, attempt_id) {
            return;
        }
        if window
            .url()
            .is_ok_and(|current| urls_share_origin(&current, restore_url))
        {
            return;
        }
        if count_down {
            let _ = window.eval(format!(
                "(() => {{ const el = document.getElementById('sec'); if (el) el.textContent = '{remaining}'; }})();"
            ));
        }
    }
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
    use super::ios::{same_page, IOS_POPUP_SCRIPT};
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
        // The Android popup gets the same file inside a Kotlin raw string, which reads `$` as a
        // template (`build/android_patches.rs`).
        assert!(!BACK_BUTTON_SCRIPT.contains('$'));
        let patches = include_str!("../../../build/android_patches.rs");
        assert!(patches.contains("include_str!(\"../src/auth/mobile_auth/back_button.js\")"));
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
    fn the_app_webview_survives_a_page_calling_window_close() {
        // The "Account connected" page's window.close() reached this handler, which destroyed
        // the app's only WebView: the app froze on "1" until it was force-closed.
        let patches = include_str!("../../../build/android_patches.rs");
        let app_handler = |kotlin: &str| -> String {
            let at = kotlin
                .rfind("override fun onCloseWindow(window: WebView)")
                .expect("the app WebView's onCloseWindow");
            let body = &kotlin[at..];
            body[..body.find("\n  }").expect("end of onCloseWindow")].to_string()
        };
        let handler = app_handler(patches);
        assert!(!handler.contains("destroy"), "{handler}");
        // A sign-in popup still closes itself.
        assert!(patches
            .contains("override fun onCloseWindow(window: WebView) {\n        dialog.dismiss()"));
        // The build applies the patch to the generated Kotlin (gitignored; present after a
        // `tauri android` command).
        if let Ok(chrome) = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/gen/android/app/src/main/java/com/dubba/ai/usage/tracker/generated/RustWebChromeClient.kt"
        )) {
            assert!(!app_handler(&chrome).contains("destroy"));
        }
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

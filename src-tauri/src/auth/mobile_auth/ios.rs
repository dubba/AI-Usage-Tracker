//! The iOS side of a sign-in in the app's WebView: provider cookies, and the popups that
//! "Continue with Google" needs. iOS has no activity to tell about the result page and no
//! back history to clear, so those calls do nothing here. The script and `same_page` are also
//! built for tests on a desktop.

use super::urls_share_origin;
use url::Url;

/// wry only implements `window.open` popups on macOS, so on iOS the call silently returns null and
/// "Continue with Google" never opens. Opening the target in the same WebView lets the redirect
/// flows (ChatGPT, Antigravity, Grok) finish. A Google Identity Services popup (Claude) is the
/// exception: it hands the result back through `window.opener`, so it gets a real popup from
/// ios_popups.rs, and in the same window it would end on a blank page.
#[cfg_attr(not(target_os = "ios"), allow(dead_code))]
pub(super) const IOS_POPUP_SCRIPT: &str = r#"
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

/// Whether two URLs are the same page, ignoring the fragment.
pub(super) fn same_page(left: &Url, right: &Url) -> bool {
    urls_share_origin(left, right) && left.path() == right.path() && left.query() == right.query()
}

#[cfg(target_os = "ios")]
pub(super) use hooks::*;

#[cfg(target_os = "ios")]
mod hooks {
    use super::{same_page, IOS_POPUP_SCRIPT};
    use tauri::WebviewWindow;
    use url::Url;

    pub(in super::super) fn result_page_showing(_showing: bool) {}

    pub(in super::super) fn clear_history() {}

    /// Drops the provider cookies in the WebView.
    pub(in super::super) fn clear_sign_in_cookies(window: &WebviewWindow) -> Result<(), String> {
        crate::auth::ios_cookies::delete_cookies(
            window,
            crate::auth::signin_navigation::cookie_domain_is_sign_in,
        )
        .map(|_| ())
    }

    /// Lets the sign-in pages open real popups.
    pub(in super::super) fn install_popups(window: &WebviewWindow) {
        crate::auth::ios_popups::install(window);
    }

    /// A provider page is showing: route its `window.open` calls, and close a popup the
    /// sign-in has moved past.
    pub(in super::super) fn on_provider_page(window: &WebviewWindow, current: &Url) {
        let _ = window.eval(IOS_POPUP_SCRIPT);
        close_stale_popups(window, current);
    }

    pub(in super::super) fn close_popups(window: &WebviewWindow) {
        crate::auth::ios_popups::close_all(window);
    }

    /// A sign-in popup (Claude's Google Identity Services one) hands its result to
    /// the main window through `window.opener` and then calls `window.close()`, but
    /// on iOS that close is not always delivered and the popup covers the page the
    /// sign-in moved on to. Once the main window navigates past the page the popup
    /// opened from, the popup's job is done, so close it. The popup records that
    /// page itself when it is created, so a quick hand-over between two polls
    /// cannot make the poll loop adopt the new page as the one to compare with.
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
}

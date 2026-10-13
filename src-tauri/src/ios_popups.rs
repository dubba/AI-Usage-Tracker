//! Real `window.open` popups for Google sign-in on iOS.
//!
//! wry implements popups only on macOS, so on iOS `window.open` returns null.
//! Most provider pages cope once the target opens in the same window (see
//! `IOS_POPUP_SCRIPT` in mobile_auth.rs), but Claude's "Continue with Google"
//! uses a Google Identity Services popup that hands the result back to its
//! opener through `window.opener` and then closes. Opened in the same window,
//! that last page has no opener and stays blank, and the sign-in never ends.
//!
//! This module gives wry's iOS UI delegate the missing
//! `webView:createWebViewWithConfiguration:forNavigationAction:windowFeatures:`
//! method. The popup is a second WKWebView built from the configuration WebKit
//! hands over (so `window.opener` works and cookies are shared), laid over the
//! main WebView, limited to sign-in hosts, and removed when the page calls
//! `window.close()`, when the user taps Close, or when the sign-in ends.

use objc2::rc::{Allocated, Retained};
use objc2::runtime::{AnyClass, AnyObject, Imp, NSObject, Sel};
use objc2::{define_class, msg_send, sel, MainThreadMarker, MainThreadOnly};
use objc2_foundation::{NSObjectProtocol, NSRect, NSString};
use std::cell::RefCell;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::Url;
use tauri::WebviewWindow;

/// Whether any sign-in popup is open. WebKit creates and closes popups only on
/// the main thread, but the sign-in poll loop (mobile_auth.rs) checks this from
/// its async task, so the flag is atomic instead of part of `POPUPS`.
static ANY_POPUP_OPEN: AtomicBool = AtomicBool::new(false);

/// The page the main WebView was showing when the oldest open popup was created.
/// Recorded here, on the main thread at creation, so the poll loop cannot miss a
/// page change that happens between two of its polls.
static OPENED_FROM: Mutex<Option<Url>> = Mutex::new(None);

pub(crate) fn any_open() -> bool {
    ANY_POPUP_OPEN.load(Ordering::SeqCst)
}

/// The main-window page the open popup was opened from, when it could be read.
pub(crate) fn opened_from() -> Option<Url> {
    OPENED_FROM.lock().ok()?.clone()
}

fn set_closed() {
    ANY_POPUP_OPEN.store(false, Ordering::SeqCst);
    if let Ok(mut from) = OPENED_FROM.lock() {
        *from = None;
    }
}

/// `UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight`.
const FLEXIBLE_SIZE: usize = (1 << 1) | (1 << 4);

/// `WKNavigationActionPolicyCancel` and `WKNavigationActionPolicyAllow`.
const POLICY_CANCEL: isize = 0;
const POLICY_ALLOW: isize = 1;

/// Top-left Close button for the popup, which has no browser chrome. Closing a
/// script-opened window ends in `webViewDidClose:` below.
const CLOSE_BUTTON_SCRIPT: &str = r#"
(() => {
  try {
    if (window.top !== window || !document.documentElement) return;
    const id = '__ai_tracker_popup_close';
    const install = () => {
      if (!document.documentElement || document.getElementById(id)) return;
      const button = document.createElement('button');
      button.id = id;
      button.type = 'button';
      button.textContent = '✕ Close';
      button.setAttribute('aria-label', 'Close Google sign-in');
      button.style.cssText = [
        'position:fixed', 'top:calc(env(safe-area-inset-top, 0px) + 12px)', 'right:12px',
        'z-index:2147483647', 'padding:8px 14px', 'border:0', 'border-radius:999px',
        'background:#6d3bd7', 'color:#fff', 'font:600 14px -apple-system,system-ui,sans-serif',
        'box-shadow:0 2px 10px rgba(0,0,0,.4)', 'cursor:pointer',
      ].join(';');
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        window.close();
      }, true);
      document.documentElement.appendChild(button);
    };
    install();
    new MutationObserver(install).observe(document.documentElement, { childList: true });
  } catch (e) {}
})();
"#;

struct Popup {
    webview: Retained<AnyObject>,
    // WebKit holds its delegates weakly, so the popup keeps its own alive.
    _delegate: Retained<PopupDelegate>,
}

thread_local! {
    /// Open popups. Only touched on the main thread, where WebKit calls in.
    static POPUPS: RefCell<Vec<Popup>> = const { RefCell::new(Vec::new()) };
}

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "AIUsageTrackerSignInPopupDelegate"]
    struct PopupDelegate;

    unsafe impl NSObjectProtocol for PopupDelegate {}

    impl PopupDelegate {
        /// The page called `window.close()`, as Google's popup does when it is done.
        #[unsafe(method(webViewDidClose:))]
        fn web_view_did_close(&self, webview: &AnyObject) {
            crate::diagnostics::info("The sign-in popup was closed by its page.");
            remove_popup(webview);
        }

        /// A popup that fails to load otherwise leaves only a blank overlay and no trace.
        #[unsafe(method(webView:didFailProvisionalNavigation:withError:))]
        fn did_fail_provisional_navigation(
            &self,
            _webview: &AnyObject,
            _navigation: Option<&AnyObject>,
            error: &AnyObject,
        ) {
            log_load_failure(error);
        }

        #[unsafe(method(webView:didFailNavigation:withError:))]
        fn did_fail_navigation(
            &self,
            _webview: &AnyObject,
            _navigation: Option<&AnyObject>,
            error: &AnyObject,
        ) {
            log_load_failure(error);
        }

        /// The same rule as the main window during a sign-in: sign-in hosts only.
        #[unsafe(method(webView:decidePolicyForNavigationAction:decisionHandler:))]
        fn decide_policy(
            &self,
            _webview: &AnyObject,
            action: &AnyObject,
            handler: &block2::Block<dyn Fn(isize)>,
        ) {
            let allowed = navigation_action_url(action).is_some_and(|url| {
                let allowed = url.as_str() == "about:blank" || is_sign_in_url(&url);
                if !allowed {
                    crate::diagnostics::warn(&format!(
                        "Blocked the sign-in popup from navigating to {}",
                        url.host_str().unwrap_or("(no host)")
                    ));
                }
                allowed
            });
            handler.call((if allowed { POLICY_ALLOW } else { POLICY_CANCEL },));
        }

        #[unsafe(method(webView:didFinishNavigation:))]
        fn did_finish_navigation(&self, webview: &AnyObject, _navigation: Option<&AnyObject>) {
            let script = NSString::from_str(CLOSE_BUTTON_SCRIPT);
            let none: Option<&AnyObject> = None;
            // SAFETY: a WKWebView, on the main thread; a nil completion handler is allowed.
            let _: () = unsafe {
                msg_send![webview, evaluateJavaScript: &*script, completionHandler: none]
            };
        }
    }
);

impl PopupDelegate {
    fn new(mtm: MainThreadMarker) -> Retained<Self> {
        let this: Allocated<Self> = mtm.alloc();
        // SAFETY: NSObject's designated initializer.
        unsafe { msg_send![super(this.set_ivars(())), init] }
    }
}

/// Lets the main WebView open real popups. Safe to call before every sign-in;
/// the method is added once.
pub(crate) fn install(window: &WebviewWindow) {
    let _ = window.with_webview(|webview| {
        // SAFETY: on iOS `inner()` is the main WKWebView, used on the main thread
        // inside `with_webview`.
        let main = unsafe { &*webview.inner().cast::<AnyObject>() };
        let delegate: Option<Retained<AnyObject>> = unsafe { msg_send![main, UIDelegate] };
        let Some(delegate) = delegate else {
            crate::diagnostics::warn(
                "Sign-in popups are unavailable: the page has no UI delegate.",
            );
            return;
        };
        let selector =
            sel!(webView:createWebViewWithConfiguration:forNavigationAction:windowFeatures:);
        let class = delegate.class();
        if !class.responds_to(selector) {
            // SAFETY: `create_popup` matches the selector's signature, described by
            // the type encoding (returns an object; self, _cmd, then four objects).
            let added = unsafe {
                let imp: Imp = std::mem::transmute(
                    create_popup
                        as unsafe extern "C-unwind" fn(
                            *mut AnyObject,
                            Sel,
                            *mut AnyObject,
                            *mut AnyObject,
                            *mut AnyObject,
                            *mut AnyObject,
                        ) -> *mut AnyObject,
                );
                objc2::ffi::class_addMethod(
                    (class as *const AnyClass).cast_mut(),
                    selector,
                    imp,
                    c"@@:@@@@".as_ptr(),
                )
            };
            if !added.as_bool() {
                crate::diagnostics::warn(
                    "Sign-in popups are unavailable: adding the popup handler failed.",
                );
                return;
            }
        }
        // WebKit records which delegate methods exist when the delegate is set,
        // so set it again for the new method to be seen.
        // SAFETY: re-assigning the WKWebView's own UI delegate on the main thread.
        let _: () = unsafe { msg_send![main, setUIDelegate: &*delegate] };
    });
}

/// Removes every popup. Called when a sign-in ends, however it ends.
pub(crate) fn close_all(window: &WebviewWindow) {
    let _ = window.with_webview(|_| {
        let popups = POPUPS.with(|popups| popups.take());
        set_closed();
        for popup in popups {
            // SAFETY: a UIView, on the main thread.
            let _: () = unsafe { msg_send![&*popup.webview, removeFromSuperview] };
        }
    });
}

/// `-[WKUIDelegate webView:createWebViewWithConfiguration:forNavigationAction:windowFeatures:]`.
/// Returns nil (no popup) for anything but a sign-in page.
unsafe extern "C-unwind" fn create_popup(
    _this: *mut AnyObject,
    _cmd: Sel,
    opener: *mut AnyObject,
    configuration: *mut AnyObject,
    action: *mut AnyObject,
    _features: *mut AnyObject,
) -> *mut AnyObject {
    // SAFETY: WebKit passes valid objects, or nil, for the duration of the call.
    let (Some(opener), Some(configuration), Some(action)) = (
        unsafe { opener.as_ref() },
        unsafe { configuration.as_ref() },
        unsafe { action.as_ref() },
    ) else {
        return std::ptr::null_mut();
    };
    let Some(mtm) = MainThreadMarker::new() else {
        return std::ptr::null_mut();
    };
    match navigation_action_url(action) {
        Some(url) if is_sign_in_url(&url) => {}
        url => {
            crate::diagnostics::warn(&format!(
                "Blocked a sign-in popup to {}",
                url.as_ref().and_then(Url::host_str).unwrap_or("(no host)")
            ));
            return std::ptr::null_mut();
        }
    }
    let Some(class) = AnyClass::get(c"WKWebView") else {
        return std::ptr::null_mut();
    };

    // SAFETY: plain UIKit/WebKit calls on the main thread. WebKit requires the
    // popup to be built from the configuration it passed in.
    unsafe {
        let bounds: NSRect = msg_send![opener, bounds];
        let allocated: Allocated<AnyObject> = msg_send![class, alloc];
        let popup: Option<Retained<AnyObject>> =
            msg_send![allocated, initWithFrame: bounds, configuration: configuration];
        let Some(popup) = popup else {
            return std::ptr::null_mut();
        };
        let delegate = PopupDelegate::new(mtm);
        let _: () = msg_send![&*popup, setUIDelegate: &*delegate];
        let _: () = msg_send![&*popup, setNavigationDelegate: &*delegate];
        let _: () = msg_send![&*popup, setAutoresizingMask: FLEXIBLE_SIZE];
        // Google decides what to show from the user agent; keep the main window's.
        let user_agent: Option<Retained<NSString>> = msg_send![opener, customUserAgent];
        let _: () = msg_send![&*popup, setCustomUserAgent: user_agent.as_deref()];
        let _: () = msg_send![opener, addSubview: &*popup];

        let pointer = Retained::as_ptr(&popup).cast_mut();
        // Before the flag, so the poll loop never sees an open popup without its page.
        if let Ok(mut from) = OPENED_FROM.lock() {
            if from.is_none() {
                *from = webview_url(opener);
            }
        }
        POPUPS.with(|popups| {
            popups.borrow_mut().push(Popup {
                webview: popup,
                _delegate: delegate,
            })
        });
        ANY_POPUP_OPEN.store(true, Ordering::SeqCst);
        crate::diagnostics::info("A sign-in popup opened.");
        // Returned at +0: `POPUPS` and the superview keep the popup alive.
        pointer
    }
}

fn remove_popup(webview: &AnyObject) {
    let removed_and_open = POPUPS.with(|popups| {
        let mut popups = popups.borrow_mut();
        let index = popups
            .iter()
            .position(|popup| std::ptr::eq(&*popup.webview, webview))?;
        let removed = popups.remove(index);
        Some((removed, !popups.is_empty()))
    });
    let Some((popup, still_open)) = removed_and_open else {
        return;
    };
    // SAFETY: a UIView, on the main thread.
    let _: () = unsafe { msg_send![&*popup.webview, removeFromSuperview] };
    if !still_open {
        set_closed();
    }
}

/// Logs why a popup page did not load. Only the error's domain and code, which
/// carry no URL or token.
fn log_load_failure(error: &AnyObject) {
    // SAFETY: an NSError; these getters have no side effects.
    let (domain, code): (Option<Retained<NSString>>, isize) =
        unsafe { (msg_send![error, domain], msg_send![error, code]) };
    crate::diagnostics::warn(&format!(
        "The sign-in popup failed to load ({} {code}).",
        domain.map_or_else(|| "unknown".to_string(), |domain| domain.to_string())
    ));
}

/// The page a WKWebView is showing, if it has one.
fn webview_url(webview: &AnyObject) -> Option<Url> {
    // SAFETY: a WKWebView, on the main thread; `URL` and `absoluteString` have no side effects.
    let url: Option<Retained<NSString>> = unsafe {
        let url: Option<Retained<AnyObject>> = msg_send![webview, URL];
        msg_send![&*url?, absoluteString]
    };
    Url::parse(&url?.to_string()).ok()
}

fn navigation_action_url(action: &AnyObject) -> Option<Url> {
    // SAFETY: `action` is a WKNavigationAction; these getters have no side effects.
    let url: Option<Retained<NSString>> = unsafe {
        let request: Option<Retained<AnyObject>> = msg_send![action, request];
        let url: Option<Retained<AnyObject>> = msg_send![&*request?, URL];
        msg_send![&*url?, absoluteString]
    };
    Url::parse(&url?.to_string()).ok()
}

fn is_sign_in_url(url: &Url) -> bool {
    url.scheme() == "https"
        && url.port().is_none()
        && url.username().is_empty()
        && url
            .host_str()
            .is_some_and(crate::signin_navigation::host_is_sign_in)
}

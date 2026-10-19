//! Reading and deleting the main WebView's cookies on iOS without blocking the
//! main thread.
//!
//! Tauri's `cookies()`, `cookies_for_url()` and `delete_cookie()` run on the
//! main thread and wait there for WebKit by spinning a nested run loop. tao's
//! run loop observers are not re-entrant, so whenever WebKit does not answer at
//! once the observer panics inside an `extern "C"` callback and the app aborts
//! (it crashed starting a Claude sign-in). These helpers queue the WebKit call
//! on the main thread with `with_webview`, return straight away, and wait for
//! WebKit's completion handler on the calling thread instead. Call them only
//! from a background thread or async task, never from the main thread.

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2::{msg_send, MainThreadMarker};
use objc2_foundation::{NSArray, NSHTTPCookie};
use objc2_web_kit::{WKHTTPCookieStore, WKWebViewConfiguration};
use std::cell::Cell;
use std::ptr::NonNull;
use std::rc::Rc;
use std::sync::mpsc;
use std::time::Duration;
use tauri::webview::{cookie::Cookie, PlatformWebview};
use tauri::WebviewWindow;

/// WebKit answers in milliseconds; this only bounds a WebView that has gone away.
const COOKIE_STORE_TIMEOUT: Duration = Duration::from_secs(5);

/// Every cookie in the WebView's store, with its name, value, and domain.
pub(crate) fn all_cookies(window: &WebviewWindow) -> Result<Vec<Cookie<'static>>, String> {
    ensure_off_main_thread()?;
    let (sender, receiver) = mpsc::channel();
    window
        .with_webview(move |webview| {
            let store = cookie_store(&webview);
            let completion = RcBlock::new(move |cookies: NonNull<NSArray<NSHTTPCookie>>| {
                // SAFETY: WebKit passes a valid array for the duration of the call.
                let cookies = unsafe { cookies.as_ref() };
                let cookies = cookies
                    .to_vec()
                    .iter()
                    .map(|cookie| to_cookie(cookie))
                    .collect();
                let _ = sender.send(cookies);
            });
            // SAFETY: called on the main thread, as `with_webview` guarantees.
            unsafe { store.getAllCookies(&completion) };
        })
        .map_err(|error| format!("Unable to reach the page session: {error}"))?;
    receiver
        .recv_timeout(COOKIE_STORE_TIMEOUT)
        .map_err(|_| "Timed out reading the page session.".to_string())
}

/// Deletes every cookie whose domain `should_delete` accepts, and returns how
/// many were deleted once WebKit has confirmed each one.
pub(crate) fn delete_cookies(
    window: &WebviewWindow,
    should_delete: fn(&str) -> bool,
) -> Result<usize, String> {
    ensure_off_main_thread()?;
    let (sender, receiver) = mpsc::channel();
    window
        .with_webview(move |webview| {
            let store = cookie_store(&webview);
            let delete_from = store.clone();
            let completion = RcBlock::new(move |cookies: NonNull<NSArray<NSHTTPCookie>>| {
                // SAFETY: WebKit passes a valid array for the duration of the call.
                let cookies = unsafe { cookies.as_ref() };
                let doomed: Vec<Retained<NSHTTPCookie>> = cookies
                    .to_vec()
                    .into_iter()
                    .filter(|cookie| should_delete(&cookie.domain().to_string()))
                    .collect();
                let total = doomed.len();
                if total == 0 {
                    let _ = sender.send(0);
                    return;
                }
                // Completion handlers all run on the main thread, so a plain
                // counter is enough to notice the last one.
                let remaining = Rc::new(Cell::new(total));
                for cookie in &doomed {
                    let remaining = remaining.clone();
                    let sender = sender.clone();
                    let deleted = RcBlock::new(move || {
                        remaining.set(remaining.get() - 1);
                        if remaining.get() == 0 {
                            let _ = sender.send(total);
                        }
                    });
                    // SAFETY: still on the main thread, inside WebKit's callback.
                    unsafe { delete_from.deleteCookie_completionHandler(cookie, Some(&deleted)) };
                }
            });
            // SAFETY: called on the main thread, as `with_webview` guarantees.
            unsafe { store.getAllCookies(&completion) };
        })
        .map_err(|error| format!("Unable to reach the page session: {error}"))?;
    receiver
        .recv_timeout(COOKIE_STORE_TIMEOUT)
        .map_err(|_| "Timed out clearing the page session.".to_string())
}

/// The calling thread waits for a completion handler that runs on the main
/// thread, so waiting on the main thread itself would never finish.
fn ensure_off_main_thread() -> Result<(), String> {
    if MainThreadMarker::new().is_some() {
        return Err("The page session cannot be read from the main thread.".to_string());
    }
    Ok(())
}

fn cookie_store(webview: &PlatformWebview) -> Retained<WKHTTPCookieStore> {
    // SAFETY: on iOS `inner()` is the WKWebView that Tauri created for this
    // window; it stays alive while `with_webview` runs this closure.
    let webview = unsafe { &*webview.inner().cast::<AnyObject>() };
    // objc2-web-kit binds `WKWebView` for macOS only, so ask for its
    // configuration by message. `-[WKWebView configuration]` returns a copy.
    // SAFETY: WebKit objects used on the main thread.
    let configuration: Retained<WKWebViewConfiguration> =
        unsafe { msg_send![webview, configuration] };
    unsafe { configuration.websiteDataStore().httpCookieStore() }
}

fn to_cookie(cookie: &NSHTTPCookie) -> Cookie<'static> {
    Cookie::build((cookie.name().to_string(), cookie.value().to_string()))
        .domain(cookie.domain().to_string())
        .build()
}

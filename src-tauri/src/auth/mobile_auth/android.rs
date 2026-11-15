//! The Android side of a sign-in in the app's WebView: calls into `MainActivity` for the
//! cookies, the back history and the result page's back gesture. Android has one WebView and
//! real popups are handled natively, so the popup calls do nothing here.

use tauri::WebviewWindow;
use url::Url;

/// Tells the activity whether the "Account connected" page is on screen.
pub(super) fn result_page_showing(showing: bool) {
    set_android_sign_in_result_showing(showing);
}

/// Drops the WebView's back history, so back does not step through the sign-in pages.
pub(super) fn clear_history() {
    clear_android_web_view_history();
}

/// Drops the provider cookies in the WebView.
pub(super) fn clear_sign_in_cookies(_window: &WebviewWindow) -> Result<(), String> {
    clear_android_sign_in_cookies()
}

pub(super) fn install_popups(_window: &WebviewWindow) {}

pub(super) fn on_provider_page(_window: &WebviewWindow, _current: &Url) {}

pub(super) fn close_popups(_window: &WebviewWindow) {}

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

fn clear_android_web_view_history() {
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
fn set_android_sign_in_result_showing(showing: bool) {
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

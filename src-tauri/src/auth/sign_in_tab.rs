//! Android sign-in in a Custom Tab, the browser's own tab over the app, for the providers whose
//! OAuth page can lead through Google sign-in. Google refuses sign-in in embedded WebViews ("This
//! browser or app may not be secure", or a "400 malformed" page after 2-step verification) and
//! decides that on its servers per attempt, so removing the WebView marker from the user agent
//! (`MainActivity.kt`) worked only some of the time.
//!
//! The provider still redirects to the loopback callback server (`oauth/callback_server.rs`),
//! which the browser on the same device reaches. Once the callback has ended the sign-in, the app
//! brings itself back over the tab; the dialog that started it shows the result. Closing the tab
//! before the provider redirects cancels the attempt, like the Back button on the in-app page;
//! minimizing it (Chrome's floating tab) does not. `SignInTab.kt` tells the two apart, and the
//! browser keeps the app awake behind the tab (`SignInTabKeepAliveService.kt`), since Android froze
//! it after about a minute and the redirect then hung. Without a browser that supports Custom
//! Tabs, the sign-in stays in the app's WebView.

#[cfg(any(test, target_os = "android"))]
use crate::model::Provider;
#[cfg(any(test, target_os = "android"))]
use crate::state::AppState;
use parking_lot::Mutex;
#[cfg(target_os = "android")]
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
#[cfg(target_os = "android")]
use std::time::Duration;
#[cfg(target_os = "android")]
use url::Url;

/// The attempt whose sign-in page is in the tab, so its callback answers with the page for the
/// browser (`account_connected_in_tab_html`) rather than the in-app one.
static TAB_ATTEMPT: Mutex<Option<String>> = Mutex::new(None);

#[cfg(target_os = "android")]
const POLL_INTERVAL: Duration = Duration::from_millis(400);
/// How long the callback's page stays up in the tab, counting down, before the app returns over it.
#[cfg(target_os = "android")]
const RESULT_PAGE_GLANCE: Duration = crate::auth::oauth_common::CONNECTED_PAGE_DISPLAY;

/// The message the Back button on the in-app sign-in page sets too (`mobile_auth.rs`).
#[cfg(any(test, target_os = "android"))]
const CANCELED_MESSAGE: &str = "Sign-in was canceled.";

/// Whether `provider` signs in in a Custom Tab on Android. These are the loopback OAuth sign-ins
/// (`oauth::start_login`). Grok and OpenCode stay in the app's WebView, because they read the
/// provider's session cookie from it; Google AI Studio's Cloud connection already opens the
/// system browser.
#[cfg(any(test, target_os = "android"))]
pub(crate) fn uses_sign_in_tab(provider: &Provider) -> bool {
    match provider {
        Provider::Openai | Provider::Anthropic | Provider::Antigravity => true,
        Provider::Grok | Provider::OpencodeGo | Provider::GoogleAiStudio => false,
    }
}

/// Whether the tab for `provider` starts with none of the browser's sign-ins. Claude and ChatGPT
/// only offer "Continue with Google" on their own page and send Google no account prompt, so
/// Google would reuse the browser's account; Antigravity asks Google directly with
/// `prompt=select_account`, whose chooser lists the browser's accounts.
#[cfg(any(test, target_os = "android"))]
pub(crate) fn uses_fresh_browser_session(provider: &Provider) -> bool {
    matches!(provider, Provider::Openai | Provider::Anthropic)
}

/// Whether attempt `attempt_id` is signing in in the tab.
pub(crate) fn is_open_for(attempt_id: &str) -> bool {
    TAB_ATTEMPT.lock().as_deref() == Some(attempt_id)
}

/// What the tab watch does next.
#[cfg(any(test, target_os = "android"))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Step {
    /// The sign-in is still in the tab.
    Wait,
    /// The sign-in has ended (completed, failed, timed out, or replaced by another attempt), or
    /// the provider's redirect is waiting to be exchanged: bring the app back over the tab.
    Return,
    /// The user closed the tab before the provider redirected: cancel the attempt.
    Cancel,
}

/// One tick of the tab watch. `callback_claimed` is whether the provider's redirect has reached
/// the callback server; a tab closed after that leaves the attempt to finish.
#[cfg(any(test, target_os = "android"))]
fn next_step(
    state: &AppState,
    attempt_id: &str,
    callback_claimed: bool,
    closed_by_user: bool,
) -> Step {
    let current = state
        .pending_login
        .read()
        .as_ref()
        .is_some_and(|login| login.attempt_id == attempt_id);
    let exchange_queued = state
        .pending_auth_exchange
        .lock()
        .as_ref()
        .is_some_and(|pending| pending.attempt_id == attempt_id);
    if !current || !state.login_is_waiting(attempt_id) || exchange_queued {
        return Step::Return;
    }
    if closed_by_user && !callback_claimed {
        return Step::Cancel;
    }
    Step::Wait
}

/// Ends attempt `attempt_id` as canceled and stops its callback server.
#[cfg(any(test, target_os = "android"))]
fn cancel(state: &AppState, attempt_id: &str) {
    state.fail_login_if_waiting(attempt_id, CANCELED_MESSAGE.into());
    state.abort_login_resources(attempt_id);
}

/// Opens `target` in a Custom Tab and watches the attempt until it ends. False when the tab did
/// not open (no browser supports Custom Tabs, or the activity is not available); the caller then
/// signs in in the app's WebView instead.
#[cfg(target_os = "android")]
pub(crate) fn open(
    state: Arc<AppState>,
    provider: &Provider,
    attempt_id: &str,
    callback_claimed: Arc<AtomicBool>,
    target: &Url,
) -> bool {
    *TAB_ATTEMPT.lock() = Some(attempt_id.to_string());
    // The activity numbers its tabs, so this watch can never close or cancel a newer one.
    let tab = match launch(target, uses_fresh_browser_session(provider)) {
        Ok(tab) if tab != 0 => tab,
        Ok(_) => {
            forget(attempt_id);
            return false;
        }
        Err(error) => {
            crate::diagnostics::warn(&format!("{error}; signing in in the app instead."));
            forget(attempt_id);
            return false;
        }
    };
    let attempt_id = attempt_id.to_string();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(POLL_INTERVAL).await;
            let closed = take_closed_by_user(tab);
            match next_step(
                &state,
                &attempt_id,
                callback_claimed.load(Ordering::SeqCst),
                closed,
            ) {
                Step::Wait => {}
                Step::Cancel => {
                    cancel(&state, &attempt_id);
                    break;
                }
                Step::Return => {
                    if !closed {
                        tokio::time::sleep(RESULT_PAGE_GLANCE).await;
                        return_to_app(tab);
                    }
                    break;
                }
            }
        }
        forget(&attempt_id);
    });
    true
}

#[cfg(target_os = "android")]
fn forget(attempt_id: &str) {
    let mut tab = TAB_ATTEMPT.lock();
    if tab.as_deref() == Some(attempt_id) {
        *tab = None;
    }
}

#[cfg(target_os = "android")]
fn launch(target: &Url, fresh_session: bool) -> Result<i32, String> {
    const PREFIX: &str = "Unable to open the sign-in tab";
    crate::platform::android_context::with_activity(PREFIX, |env, activity| {
        let url = env
            .new_string(target.as_str())
            .map_err(|_| PREFIX.to_string())?;
        let result = env.call_method(
            activity,
            "openSignInTab",
            "(Ljava/lang/String;Z)I",
            &[
                jni::objects::JValue::Object(&url.into()),
                fresh_session.into(),
            ],
        );
        if env.exception_check().unwrap_or(false) {
            let _ = env.exception_clear();
            return Err(PREFIX.to_string());
        }
        result
            .and_then(|value| value.i())
            .map_err(|_| PREFIX.to_string())
    })
}

/// Whether the user closed `tab` before the app returned over it, reported once.
#[cfg(target_os = "android")]
fn take_closed_by_user(tab: i32) -> bool {
    crate::platform::android_context::with_activity("takeSignInTabClosed", |env, activity| {
        let result = env.call_method(
            activity,
            "takeSignInTabClosed",
            "(I)Z",
            &[jni::objects::JValue::Int(tab)],
        );
        if env.exception_check().unwrap_or(false) {
            let _ = env.exception_clear();
            return Ok(false);
        }
        Ok(result.and_then(|value| value.z()).unwrap_or(false))
    })
    .unwrap_or(false)
}

/// Brings the app back over `tab`. Does nothing when that tab is already gone.
#[cfg(target_os = "android")]
fn return_to_app(tab: i32) {
    let _ = crate::platform::android_context::with_activity("closeSignInTab", |env, activity| {
        let _ = env.call_method(
            activity,
            "closeSignInTab",
            "(I)V",
            &[jni::objects::JValue::Int(tab)],
        );
        if env.exception_check().unwrap_or(false) {
            let _ = env.exception_clear();
        }
        Ok(())
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{LoginState, LoginStatus};
    use std::sync::Arc;

    fn waiting_app() -> (Arc<AppState>, tempfile::TempDir) {
        let temp = tempfile::tempdir().unwrap();
        let app = Arc::new(AppState::new(temp.path().to_path_buf(), "test-token".into()).unwrap());
        app.begin_login("attempt", None).unwrap();
        (app, temp)
    }

    #[test]
    fn only_the_loopback_oauth_providers_sign_in_in_the_tab() {
        assert!(uses_sign_in_tab(&Provider::Anthropic));
        assert!(uses_sign_in_tab(&Provider::Openai));
        assert!(uses_sign_in_tab(&Provider::Antigravity));
        // Their sign-in reads the session cookie from the app's own WebView.
        assert!(!uses_sign_in_tab(&Provider::Grok));
        assert!(!uses_sign_in_tab(&Provider::OpencodeGo));
        // Opens the system browser from the dialog.
        assert!(!uses_sign_in_tab(&Provider::GoogleAiStudio));
    }

    #[test]
    fn claude_and_chatgpt_start_signed_out_but_antigravity_lists_the_browsers_accounts() {
        assert!(uses_fresh_browser_session(&Provider::Anthropic));
        assert!(uses_fresh_browser_session(&Provider::Openai));
        assert!(!uses_fresh_browser_session(&Provider::Antigravity));
    }

    #[test]
    fn the_tab_stays_while_the_sign_in_waits() {
        let (app, _temp) = waiting_app();
        assert_eq!(next_step(&app, "attempt", false, false), Step::Wait);
        // The redirect reached the callback server: the exchange is under way.
        assert_eq!(next_step(&app, "attempt", true, false), Step::Wait);
    }

    #[test]
    fn closing_the_tab_before_the_redirect_cancels_the_sign_in() {
        let (app, _temp) = waiting_app();
        assert_eq!(next_step(&app, "attempt", false, true), Step::Cancel);
        cancel(&app, "attempt");
        let status = app.pending_login.read().clone().unwrap();
        assert_eq!(status.status, LoginState::Failed);
        assert_eq!(status.message.as_deref(), Some(CANCELED_MESSAGE));
        // Nothing is left for a later poll to exchange.
        assert_eq!(next_step(&app, "attempt", false, false), Step::Return);
    }

    #[test]
    fn closing_the_tab_after_the_redirect_lets_the_sign_in_finish() {
        let (app, _temp) = waiting_app();
        assert_eq!(next_step(&app, "attempt", true, true), Step::Wait);
        assert!(app.login_is_waiting("attempt"));
    }

    #[test]
    fn the_app_returns_once_the_sign_in_has_ended() {
        let (app, _temp) = waiting_app();
        app.fail_login_if_waiting("attempt", "Claude login timed out.".into());
        assert_eq!(next_step(&app, "attempt", false, false), Step::Return);
        // Closed and ended together: not a cancel, the result stands.
        assert_eq!(next_step(&app, "attempt", false, true), Step::Return);
        assert_eq!(
            app.pending_login.read().clone().unwrap().message.as_deref(),
            Some("Claude login timed out.")
        );

        let (app, _temp) = waiting_app();
        *app.pending_login.write() = Some(LoginStatus {
            status: LoginState::Complete,
            ..LoginStatus::waiting("attempt", None)
        });
        assert_eq!(next_step(&app, "attempt", true, false), Step::Return);
    }

    #[test]
    fn the_app_returns_when_the_code_waits_for_a_retried_exchange() {
        let (app, _temp) = waiting_app();
        *app.pending_auth_exchange.lock() = Some(crate::state::PendingAuthExchange {
            attempt_id: "attempt".into(),
            provider: Provider::Anthropic,
            label: "Claude".into(),
            reconnect_account_id: None,
            code: "code".into(),
            verifier: "verifier".into(),
            expected_state: "state".into(),
            redirect_uri: "http://localhost:53692/callback".into(),
        });
        // The dialog's next status poll retries the exchange.
        assert_eq!(next_step(&app, "attempt", true, false), Step::Return);
    }

    #[test]
    fn the_app_returns_when_another_attempt_replaced_this_one() {
        let (app, _temp) = waiting_app();
        app.clear_pending_login("attempt");
        assert_eq!(next_step(&app, "attempt", false, false), Step::Return);
        app.begin_login("newer", None).unwrap();
        assert_eq!(next_step(&app, "attempt", false, true), Step::Return);
        assert!(
            app.login_is_waiting("newer"),
            "the newer attempt is left alone"
        );
    }

    #[test]
    fn only_the_attempt_in_the_tab_gets_the_browser_page() {
        *TAB_ATTEMPT.lock() = Some("in-tab".into());
        assert!(is_open_for("in-tab"));
        assert!(!is_open_for("other"));
        *TAB_ATTEMPT.lock() = None;
        assert!(!is_open_for("in-tab"));
    }
}

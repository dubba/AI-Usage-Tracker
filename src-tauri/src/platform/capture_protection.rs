//! Keeps the app's window out of screenshots and screen recordings while the
//! air-gap transfer codes are showing.
//!
//! The animated codes carry their own key, so a recording of them decrypts
//! every sign-in in the transfer. The backend turns protection on before it
//! builds the codes (`pairing_prepare_airgap_export`), so page code cannot skip
//! it, and turns it off when the pairing flow is cancelled or restarted. If the
//! page never reports that, the window stays protected, which is the safe side.
//!
//! - Windows and macOS: the window's content protection (`set_content_protected`).
//! - Android: `FLAG_SECURE` on the activity's window, which also blanks the
//!   app's preview in the recent-apps list.
//! - iOS: nothing. iOS has no setting that keeps a window out of screenshots.
//!
//! This does not stop a second device's camera pointed at the screen.

use std::sync::atomic::{AtomicBool, Ordering};
use tauri::AppHandle;

/// Whether protection is on, so the frequent cancel calls do no native work
/// when there is nothing to turn off.
static PROTECTED: AtomicBool = AtomicBool::new(false);

/// Records the wanted state and says whether the window needs changing.
fn needs_change(state: &AtomicBool, protect: bool) -> bool {
    state.swap(protect, Ordering::SeqCst) != protect
}

/// Turns capture protection on before the transfer codes are built.
pub(crate) fn protect(app: &AppHandle) {
    // Applied even when already on: a window that was recreated since (an
    // Android activity restart) starts unprotected.
    PROTECTED.store(true, Ordering::SeqCst);
    apply(app, true);
}

/// Turns capture protection off once the transfer codes are gone.
pub(crate) fn release(app: &AppHandle) {
    if needs_change(&PROTECTED, false) {
        apply(app, false);
    }
}

fn apply(app: &AppHandle, protect: bool) {
    if let Err(error) = apply_native(app, protect) {
        crate::diagnostics::warn(&format!(
            "Screen capture protection could not be turned {}: {error}",
            if protect { "on" } else { "off" }
        ));
    }
}

#[cfg(desktop)]
fn apply_native(app: &AppHandle, protect: bool) -> Result<(), String> {
    use tauri::Manager;
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "the main window is not open".to_string())?;
    window
        .set_content_protected(protect)
        .map_err(|error| error.to_string())
}

#[cfg(target_os = "android")]
fn apply_native(_app: &AppHandle, protect: bool) -> Result<(), String> {
    const FAILURE: &str = "the app window is not available";
    crate::platform::android_context::with_activity(FAILURE, |env, activity| {
        let result = env.call_method(
            activity,
            "setScreenCaptureBlocked",
            "(Z)V",
            &[jni::objects::JValue::Bool(u8::from(protect))],
        );
        if env.exception_check().unwrap_or(false) {
            let _ = env.exception_clear();
            return Err(FAILURE.to_string());
        }
        result.map(|_| ()).map_err(|_| FAILURE.to_string())
    })
}

#[cfg(target_os = "ios")]
fn apply_native(_app: &AppHandle, _protect: bool) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn release_only_touches_the_window_when_protection_is_on() {
        let state = AtomicBool::new(false);
        assert!(!needs_change(&state, false), "nothing to turn off");
        assert!(needs_change(&state, true));
        assert!(!needs_change(&state, true));
        assert!(needs_change(&state, false));
        assert!(!needs_change(&state, false));
    }

    fn command_body<'a>(source: &'a str, command: &str) -> &'a str {
        let start = source
            .find(command)
            .unwrap_or_else(|| panic!("missing {command}"));
        let body = &source[start..];
        &body[..body.find("\n}\n").expect("end of function")]
    }

    /// The codes must never be built while the window can still be captured,
    /// and a failed export must not leave the window protected for no reason.
    #[test]
    fn the_export_protects_the_window_before_building_the_codes() {
        let source = include_str!("../commands/pairing.rs").replace("\r\n", "\n");
        let body = command_body(&source, "fn pairing_prepare_airgap_export(");
        let asked = body.find("confirm::ask(").expect("native confirmation");
        let protected = body
            .find("capture_protection::protect(")
            .expect("the export must turn capture protection on");
        let built = body
            .find("airgap::prepare_airgap_export(")
            .expect("the export builds the codes");
        assert!(asked < protected && protected < built);
        assert!(
            body[built..].contains("capture_protection::release("),
            "a failed export must turn protection off again"
        );
    }

    /// Every way out of the transfer goes through one of these commands.
    #[test]
    fn leaving_the_transfer_releases_the_protection() {
        let source = include_str!("../commands/pairing.rs").replace("\r\n", "\n");
        for command in [
            "fn pairing_cancel(",
            "fn pairing_start_host(",
            "fn pairing_start_client_by_code(",
        ] {
            assert!(
                command_body(&source, command).contains("capture_protection::release("),
                "{command} must turn capture protection off"
            );
        }
    }

    #[test]
    fn android_blocks_capture_with_flag_secure() {
        let activity = include_str!(
            "../../gen/android/app/src/main/java/com/dubba/ai/usage/tracker/MainActivity.kt"
        );
        let start = activity
            .find("fun setScreenCaptureBlocked(blocked: Boolean)")
            .expect("the method Rust calls over JNI");
        let method = &activity[start..];
        let method = &method[..method.find("\n  }\n").expect("end of method")];
        assert!(method.contains("addFlags(WindowManager.LayoutParams.FLAG_SECURE)"));
        assert!(method.contains("clearFlags(WindowManager.LayoutParams.FLAG_SECURE)"));
    }
}

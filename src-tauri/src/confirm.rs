//! Native confirmation for the two commands that hand secrets to the page: the
//! Paseo Bridge bearer token, and the air-gapped transfer, whose QR frames
//! carry their own key and so decrypt to every stored sign-in.
//!
//! The page asks for these when the user clicks, but code injected into the
//! page could ask too, and the backend cannot tell a real click from a script.
//! A dialog drawn by the operating system and opened here, in Rust, is outside
//! the page: page code cannot see, dismiss, or answer it, so the user decides.
//! The webview is not granted any dialog permission.

use std::future::Future;
use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

pub(crate) struct SensitiveAction {
    pub title: &'static str,
    pub message: &'static str,
    pub confirm: &'static str,
    pub cancelled: &'static str,
}

pub(crate) const REVEAL_BRIDGE_TOKEN: SensitiveAction = SensitiveAction {
    title: "Show the Paseo Bridge token?",
    message: "AI Usage Tracker is about to show or copy the access token for its local usage API. \
              Anyone who has this token can read your accounts' usage from this computer.\n\n\
              Only continue if you just asked to reveal or copy the token.",
    confirm: "Show Token",
    cancelled: "Showing the token was cancelled.",
};

pub(crate) const AIRGAP_EXPORT: SensitiveAction = SensitiveAction {
    title: "Show transfer codes?",
    message: "AI Usage Tracker is about to show QR codes that contain the sign-ins for all your \
              accounts. Anyone who photographs or records them can use those accounts.\n\n\
              Only continue if you just started an air-gapped transfer to your own device.",
    confirm: "Show Codes",
    cancelled: "The transfer was cancelled.",
};

/// Shows `action` in a native dialog; resolves to whether the user confirmed.
/// A dialog that is closed without choosing counts as cancel.
pub(crate) async fn ask(app: &AppHandle, action: &SensitiveAction) -> bool {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.dialog()
        .message(action.message)
        .title(action.title)
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            action.confirm.into(),
            "Cancel".into(),
        ))
        .show(move |confirmed| {
            let _ = sender.send(confirmed);
        });
    receiver.await.unwrap_or(false)
}

/// Runs `then` only once `confirmed` resolves to `true`. Otherwise `then` never
/// runs and the action's cancellation message is returned.
pub(crate) async fn after_confirmation<T>(
    action: &SensitiveAction,
    confirmed: impl Future<Output = bool>,
    then: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    if confirmed.await {
        then()
    } else {
        Err(action.cancelled.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[tokio::test]
    async fn a_declined_confirmation_never_runs_the_action() {
        let runs = AtomicUsize::new(0);
        let result = after_confirmation(&AIRGAP_EXPORT, async { false }, || {
            runs.fetch_add(1, Ordering::SeqCst);
            Ok("secret")
        })
        .await;
        assert_eq!(result, Err(AIRGAP_EXPORT.cancelled.to_string()));
        assert_eq!(runs.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn a_confirmed_action_runs_once() {
        let runs = AtomicUsize::new(0);
        let result = after_confirmation(&REVEAL_BRIDGE_TOKEN, async { true }, || {
            runs.fetch_add(1, Ordering::SeqCst);
            Ok("token")
        })
        .await;
        assert_eq!(result, Ok("token"));
        assert_eq!(runs.load(Ordering::SeqCst), 1);
    }

    /// Both secret-returning commands must go through the native confirmation
    /// before doing their work; a refactor that drops it should fail here.
    #[test]
    fn both_secret_commands_ask_before_returning_secrets() {
        for (file, source, command, action, work) in [
            (
                "commands/bridge.rs",
                include_str!("commands/bridge.rs"),
                "fn reveal_bridge_token(",
                "confirm::REVEAL_BRIDGE_TOKEN",
                "bridge_token.read()",
            ),
            (
                "commands/pairing.rs",
                include_str!("commands/pairing.rs"),
                "fn pairing_prepare_airgap_export(",
                "confirm::AIRGAP_EXPORT",
                "airgap::prepare_airgap_export(",
            ),
        ] {
            let start = source
                .find(command)
                .unwrap_or_else(|| panic!("{file}: {command}"));
            let body = &source[start..];
            let body = &body[..body.find("\n}\n").expect("end of function")];
            let asked = body.find("confirm::ask(").unwrap_or_else(|| {
                panic!("{file}: {command} must call confirm::ask before returning a secret")
            });
            assert!(body.contains(action), "{file}: {command} must use {action}");
            let worked = body[asked..].find(work).map(|offset| asked + offset);
            assert!(
                worked.is_some() && body[..asked].find(work).is_none(),
                "{file}: {command} must only reach {work} after the confirmation"
            );
        }
    }
}

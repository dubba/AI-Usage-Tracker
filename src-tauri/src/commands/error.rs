//! The error every command returns: a code the frontend can branch on, and a sentence for the
//! person. Tauri rejects the `invoke` promise with it serialized as `{ code, message }`.

use serde::{Deserialize, Serialize};
use std::fmt;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct CommandError {
    pub code: ErrorCode,
    /// A plain sentence for the person. Never raw provider, IO or serde text: caller-supplied
    /// detail goes through `diagnostics::command_error` first.
    pub message: String,
}

/// What kind of failure a command reports. The frontend picks its wording by this, and never
/// adds codes of its own.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(test, derive(ts_rs::TS))]
pub enum ErrorCode {
    /// An argument failed validation (a label too long, a bad id); the message says what to fix.
    Invalid,
    /// The account, group or sign-in attempt no longer exists.
    NotFound,
    /// Another sign-in is still running.
    LoginInProgress,
    /// The sign-in attempt the page asked about has ended or was never started here.
    LoginAttemptGone,
    /// The provider wants the person to sign in again.
    AuthRequired,
    /// The provider asked the app to slow down.
    RateLimited,
    /// A request got no answer (timeout, no connection).
    Network,
    /// The provider answered with an error.
    Provider,
    /// The keychain, Keystore or a data file failed.
    Storage,
    /// The link to the other device broke.
    Pairing,
    Cancelled,
    /// Not available on this platform.
    Unsupported,
    /// A bug or an unexpected state.
    Internal,
    /// Not given a code yet: the frontend reads the message as it did before codes existed.
    Unclassified,
}

impl CommandError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

/// An error from code that still reports a sentence. Its text is passed on unchanged, as it was
/// before commands had codes.
impl From<String> for CommandError {
    fn from(message: String) -> Self {
        Self::new(ErrorCode::Unclassified, message)
    }
}

impl From<&str> for CommandError {
    fn from(message: &str) -> Self {
        Self::new(ErrorCode::Unclassified, message)
    }
}

impl fmt::Display for CommandError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for CommandError {}

/// What a command returns.
pub type CommandResult<T> = Result<T, CommandError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_as_a_code_and_a_message() {
        let error = CommandError::new(
            ErrorCode::LoginInProgress,
            "A sign-in is already in progress.",
        );
        assert_eq!(
            serde_json::to_value(error).unwrap(),
            serde_json::json!({ "code": "login_in_progress", "message": "A sign-in is already in progress." })
        );
    }

    #[test]
    fn a_plain_sentence_keeps_its_text_and_has_no_code_yet() {
        let error = CommandError::from("Account label is required.".to_string());
        assert_eq!(error.code, ErrorCode::Unclassified);
        assert_eq!(error.message, "Account label is required.");
        assert_eq!(error.to_string(), "Account label is required.");
    }
}

//! Reporting for problems that stop the backend from starting.
//!
//! A failure while loading saved data used to abort Tauri's setup hook, so the
//! app died before showing anything. Instead the failure is recorded here, the
//! window still opens, and the frontend shows what went wrong with a Retry
//! button. The `retry_startup` command runs initialization again.

use crate::store::StoreError;
use parking_lot::Mutex;
use serde::Serialize;
use std::path::Path;

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StartupIssue {
    pub message: String,
    /// Where the app keeps its saved data, so the user can look at it.
    pub data_dir: Option<String>,
}

impl StartupIssue {
    pub fn new(what: &str, detail: impl std::fmt::Display, data_dir: Option<&Path>) -> Self {
        let detail = detail.to_string();
        let detail = detail.trim();
        let message = if detail.is_empty() {
            format!("{what}.")
        } else {
            format!("{what}: {detail}")
        };
        Self {
            message,
            data_dir: data_dir.map(|path| path.display().to_string()),
        }
    }
}

/// Managed at startup whether or not initialization succeeds, so the frontend
/// can always ask what happened.
#[derive(Default)]
pub struct StartupStatus(Mutex<Option<StartupIssue>>);

impl StartupStatus {
    pub fn get(&self) -> Option<StartupIssue> {
        self.0.lock().clone()
    }

    pub fn set(&self, issue: StartupIssue) {
        *self.0.lock() = Some(issue);
    }

    pub fn clear(&self) {
        *self.0.lock() = None;
    }
}

/// Chooses the local API token. When secure storage cannot provide one (for
/// example a locked keychain or a denied access prompt), the app still starts:
/// it uses a throwaway token for this run and reports why the local API is
/// switched off, instead of refusing to start at all.
pub fn bridge_token_or_fallback(
    stored: Result<String, StoreError>,
    fallback: impl FnOnce() -> String,
) -> (String, Option<String>) {
    match stored {
        Ok(token) => (token, None),
        Err(error) => (
            fallback(),
            Some(format!(
                "The local API is off because its access token could not be read from secure storage ({error})."
            )),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn issue_message_joins_context_and_detail() {
        let issue = StartupIssue::new(
            "AI Usage Tracker couldn't load its saved data",
            "  disk full ",
            Some(Path::new("/data/app")),
        );
        assert_eq!(
            issue.message,
            "AI Usage Tracker couldn't load its saved data: disk full"
        );
        assert_eq!(issue.data_dir.as_deref(), Some("/data/app"));
        assert_eq!(StartupIssue::new("Failed", "", None).message, "Failed.");
    }

    #[test]
    fn status_records_and_clears_the_issue() {
        let status = StartupStatus::default();
        assert!(status.get().is_none());
        status.set(StartupIssue::new("Broken", "why", None));
        assert_eq!(status.get().unwrap().message, "Broken: why");
        status.clear();
        assert!(status.get().is_none());
    }

    #[test]
    fn storage_failure_falls_back_to_a_session_token_with_a_reason() {
        let (token, reason) = bridge_token_or_fallback(Ok("stored-token".into()), || {
            panic!("fallback must not be used")
        });
        assert_eq!(token, "stored-token");
        assert!(reason.is_none());

        let (token, reason) = bridge_token_or_fallback(
            Err(StoreError::Credential("keychain locked".into())),
            || "session-token".into(),
        );
        assert_eq!(token, "session-token");
        let reason = reason.unwrap();
        assert!(reason.contains("keychain locked"));
        assert!(reason.contains("local API is off"));
    }
}

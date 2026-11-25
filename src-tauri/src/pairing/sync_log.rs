//! A record of each Sync Devices step in the diagnostics log, so Copy Diagnostics shows how a
//! sync went: which way it ran (link code, QR codes, a transfer file), whether the phone was on
//! Wi-Fi, which interface the connection used, and how it ended.
//!
//! Every line starts with `Sync:` and is built here from fixed text, counts and kinds only. The
//! link code, file names and paths, `content://` addresses, account names and the transfer
//! itself are never passed in. Error sentences are the ones the page shows, and the log redacts
//! every line again on the way out.

use super::{payload::SyncSummary, PairingStatus};
use crate::commands::error::CommandError;

/// Which side of a link-code session this device is on.
#[derive(Clone, Copy)]
pub(crate) enum Side {
    /// Shows the link code and waits.
    Showing,
    /// Typed the other device's link code.
    Entering,
}

impl Side {
    fn label(self) -> &'static str {
        match self {
            Side::Showing => "showing the code",
            Side::Entering => "entered the code",
        }
    }
}

pub(crate) fn note(message: &str) {
    crate::diagnostics::info(&format!("Sync: {message}"));
}

/// The last Wi-Fi answer logged, and when.
static LAST_WIFI_CHECK: parking_lot::Mutex<Option<(bool, std::time::Instant)>> =
    parking_lot::Mutex::new(None);
/// A repeated Wi-Fi answer is logged again after this long, so each sync shows one.
const WIFI_REPEAT_AFTER: std::time::Duration = std::time::Duration::from_secs(60);

/// Logs the Wi-Fi check's answer. The prompt asks several times a second while it is up, so
/// only a changed answer, or the same one a minute later, gets a line.
pub(crate) fn wifi_check(on_wifi: bool) {
    let now = std::time::Instant::now();
    {
        let mut last = LAST_WIFI_CHECK.lock();
        if should_log_wifi(*last, on_wifi, now) {
            *last = Some((on_wifi, now));
        } else {
            return;
        }
    }
    note(if on_wifi {
        "Wi-Fi check: on a Wi-Fi network"
    } else {
        "Wi-Fi check: not on a Wi-Fi network, asking to connect"
    });
}

fn should_log_wifi(
    last: Option<(bool, std::time::Instant)>,
    on_wifi: bool,
    now: std::time::Instant,
) -> bool {
    match last {
        Some((previous, at)) => previous != on_wifi || now.duration_since(at) >= WIFI_REPEAT_AFTER,
        None => true,
    }
}

/// Logs a step that failed with what the page was told.
pub(crate) fn failed(step: &str, error: &CommandError) {
    note(&format!(
        "{step} failed ({:?}): {}",
        error.code, error.message
    ));
}

/// Logs a step that failed with a plain error sentence.
pub(crate) fn failed_text(step: &str, error: &str) {
    note(&format!("{step} failed: {error}"));
}

/// Logs a link-code session's new status. The waiting states carry the link code or nothing
/// worth a line, so they are left out.
pub(crate) fn status(side: Side, status: &PairingStatus) {
    if let Some(line) = describe_status(side, status) {
        note(&line);
    }
}

pub(crate) fn describe_status(side: Side, status: &PairingStatus) -> Option<String> {
    let side = side.label();
    let text = match status {
        PairingStatus::Idle => format!("link code ({side}): cancelled"),
        PairingStatus::HostWaiting { .. } | PairingStatus::ClientConnecting { .. } => return None,
        PairingStatus::PeerConnected { .. } => {
            format!("link code ({side}): the other device connected")
        }
        PairingStatus::RoleSelection { .. } => {
            format!("link code ({side}): choosing who sends")
        }
        PairingStatus::ConfirmTransfer {
            role,
            account_count,
            ..
        } => {
            let direction = if role == "sender" {
                "this device sends"
            } else {
                "this device receives"
            };
            match account_count {
                Some(count) => format!(
                    "link code ({side}): codes matched, {direction}, {}",
                    accounts(*count)
                ),
                None => format!("link code ({side}): codes matched, {direction}"),
            }
        }
        PairingStatus::Transferring { .. } => format!("link code ({side}): transferring"),
        PairingStatus::Completed { summary } => {
            format!(
                "link code ({side}): finished, {}",
                describe_summary(summary)
            )
        }
        PairingStatus::Failed { error } => format!(
            "link code ({side}): failed ({:?}): {}",
            error.code, error.message
        ),
    };
    Some(text)
}

/// "3 added, 1 updated, 0 skipped", plus how many parts could not be saved.
pub(crate) fn describe_summary(summary: &SyncSummary) -> String {
    let mut text = format!(
        "{} added, {} updated, {} skipped",
        summary.added, summary.updated, summary.skipped
    );
    if !summary.warnings.is_empty() {
        text.push_str(&format!(", {} could not be saved", summary.warnings.len()));
    }
    text
}

pub(crate) fn accounts(count: usize) -> String {
    if count == 1 {
        "1 account".into()
    } else {
        format!("{count} accounts")
    }
}

/// "4 KB" for a transfer file's size.
/// A transfer file's exact length and a short fingerprint of its bytes, which are ciphertext only.
/// The sender's "made" line and the receiver's "opening" line carry it, so the two devices' logs
/// show whether the file that arrived is the one that was made, byte for byte.
pub(crate) fn file_fingerprint(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(bytes);
    format!(
        "{} bytes, id {:02x}{:02x}{:02x}{:02x}",
        bytes.len(),
        digest[0],
        digest[1],
        digest[2],
        digest[3]
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::error::ErrorCode;

    #[test]
    fn the_link_code_is_never_described() {
        let waiting = PairingStatus::HostWaiting {
            session_id: "session".into(),
            join_code: "482913".into(),
            expires_at: 0,
        };
        assert_eq!(describe_status(Side::Showing, &waiting), None);
        let connecting = PairingStatus::ClientConnecting {
            session_id: "session".into(),
        };
        assert_eq!(describe_status(Side::Entering, &connecting), None);
    }

    #[test]
    fn steps_read_as_sentences() {
        let confirm = PairingStatus::ConfirmTransfer {
            session_id: "session".into(),
            role: "sender".into(),
            account_count: Some(3),
        };
        assert_eq!(
            describe_status(Side::Showing, &confirm).unwrap(),
            "link code (showing the code): codes matched, this device sends, 3 accounts"
        );
        let done = PairingStatus::Completed {
            summary: SyncSummary {
                added: 2,
                updated: 1,
                skipped: 0,
                warnings: vec!["A group could not be saved.".into()],
            },
        };
        assert_eq!(
            describe_status(Side::Entering, &done).unwrap(),
            "link code (entered the code): finished, 2 added, 1 updated, 0 skipped, 1 could not be saved"
        );
        let failed = PairingStatus::Failed {
            error: CommandError::new(ErrorCode::Invalid, "That code didn't match."),
        };
        assert_eq!(
            describe_status(Side::Entering, &failed).unwrap(),
            "link code (entered the code): failed (Invalid): That code didn't match."
        );
    }

    #[test]
    fn a_repeated_wifi_answer_is_logged_once_a_minute() {
        let start = std::time::Instant::now();
        assert!(should_log_wifi(None, false, start));
        let last = Some((false, start));
        assert!(!should_log_wifi(
            last,
            false,
            start + std::time::Duration::from_secs(1)
        ));
        assert!(should_log_wifi(
            last,
            true,
            start + std::time::Duration::from_secs(1)
        ));
        assert!(should_log_wifi(last, false, start + WIFI_REPEAT_AFTER));
    }

    #[test]
    fn sizes_and_counts() {
        // SHA-256 of "abc" starts ba7816bf.
        assert_eq!(file_fingerprint(b"abc"), "3 bytes, id ba7816bf");
        assert_eq!(accounts(1), "1 account");
        assert_eq!(accounts(0), "0 accounts");
    }
}

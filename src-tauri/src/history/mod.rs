//! Weekly usage history, for the Usage page.
//!
//! Every live refresh that reports a weekly window leaves a small *reading* behind: when it was
//! taken, how much of the window was used, and when the window resets. Readings are the only thing
//! stored. Daily usage is worked out from them when the page asks (`activity`), so no refresh does
//! more than append a few bytes.
//!
//! - [`store`]: the month files in `<app data dir>/activity-history/` and the rules for what gets
//!   written.
//! - [`activity`]: the pure calculation from readings to one value per local day.
//! - [`report`]: the response of `get_weekly_activity`, built from the live accounts and the store.
//!
//! Nothing here stores or logs an email, a label, a token or a provider response: a tracker is the
//! pair of ids `(account id, window id)`, and everything else is read from the live account when
//! the page asks.

pub(crate) mod activity;
pub(crate) mod report;
mod store;

pub use store::HistoryStore;

use crate::model::{Account, Provider, UsageWindow, WindowKind};
use chrono::DateTime;
use serde::{Deserialize, Serialize};

/// One observation of one tracker. Stored as the array `[t, u, r]`.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(from = "ReadingRepr", into = "ReadingRepr")]
pub struct Reading {
    /// When the refresh happened, in unix seconds.
    pub t: i64,
    /// Percent of the window used, 0 to 100, with two decimals.
    pub u: f32,
    /// When the window resets, in unix seconds, if the provider said.
    pub r: Option<i64>,
}

type ReadingRepr = (i64, f32, Option<i64>);

impl From<ReadingRepr> for Reading {
    fn from((t, u, r): ReadingRepr) -> Self {
        Self { t, u, r }
    }
}

impl From<Reading> for ReadingRepr {
    fn from(reading: Reading) -> Self {
        (reading.t, reading.u, reading.r)
    }
}

impl Reading {
    /// A reading of `used_percent`, kept to two decimals and within 0 to 100, or `None` for a
    /// value that is not a number.
    pub fn new(t: i64, used_percent: f64, resets_at: Option<i64>) -> Option<Self> {
        used_percent.is_finite().then(|| Self {
            t,
            u: round_percent(used_percent),
            r: resets_at,
        })
    }

    /// `u` in hundredths of a percent, which is how readings are compared.
    pub(crate) fn hundredths(&self) -> i32 {
        (self.u * 100.0).round() as i32
    }
}

/// `value` limited to 0 to 100 and rounded to two decimals.
pub(crate) fn round_percent(value: f64) -> f32 {
    ((value.clamp(0.0, 100.0) * 100.0).round() / 100.0) as f32
}

/// Seconds since 1970 for an RFC 3339 timestamp, or `None` if it is not one.
pub(crate) fn parse_timestamp(text: &str) -> Option<i64> {
    DateTime::parse_from_rfc3339(text)
        .ok()
        .map(|time| time.timestamp())
}

/// The windows of `account` that become trackers on the Usage page.
///
/// Antigravity reports a weekly limit per model family, so each of its weekly windows is a
/// tracker. Every other provider has one headline weekly limit: the first weekly window, the same
/// one the sidebar and the alerts use. An account with no weekly window has no tracker. Windows
/// that repeat an id are listed once, since the id is the tracker's key.
pub fn tracker_windows(account: &Account) -> Vec<&UsageWindow> {
    let Some(usage) = account.last_usage.as_ref() else {
        return Vec::new();
    };
    let mut seen = std::collections::HashSet::new();
    let weekly = usage
        .windows
        .iter()
        .filter(|window| window.kind == Some(WindowKind::Weekly))
        .filter(|window| seen.insert(window.id.as_str()));
    if account.provider == Provider::Antigravity {
        weekly.collect()
    } else {
        weekly.take(1).collect()
    }
}

/// The key a tracker has in the month files: `<account id>|<window id>`. Account ids are plain
/// tokens (see `store::is_valid_account_id`), so the first `|` always ends the account id.
pub(crate) fn tracker_key(account_id: &str, window_id: &str) -> String {
    format!("{account_id}|{window_id}")
}

/// The prefix every key of one account starts with.
pub(crate) fn account_prefix(account_id: &str) -> String {
    format!("{account_id}|")
}

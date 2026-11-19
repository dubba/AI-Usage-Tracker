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

pub(crate) mod report;
mod store;

pub use store::HistoryStore;

// Readings, tracker keys and the daily calculation live in `usage-core`.
pub(crate) use usage_core::history::{
    account_prefix, activity, parse_timestamp, tracker_key, tracker_windows, Reading,
};

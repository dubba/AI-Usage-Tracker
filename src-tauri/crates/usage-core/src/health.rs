//! What the app makes of an account's stored state: its health (the card's status chip, the
//! sidebar alerts, "needs attention"), how far a Google AI Studio account's Cloud usage setup has
//! got, and the status the local API reports.
//!
//! Health and the Google setup are sent with every account (`Account`'s `Serialize` in
//! `model.rs`), so the frontend shows them and never works them out itself.

use crate::model::{Account, Provider, UsageFreshness};
use serde::Serialize;

/// The `source` strings of a Google AI Studio usage snapshot (written by the app's
/// `providers/google_ai_studio`).
/// An API key that works but has no quota data.
pub const SOURCE_MODELS_ONLY: &str = "google_ai_studio_model_access";
/// Cloud Monitoring is set up and the first quota data is still on its way.
pub const SOURCE_MONITORING_WAITING: &str = "google_ai_studio_monitoring_waiting";
/// Quota windows read from Cloud Monitoring.
pub const SOURCE_MONITORING: &str = "google_ai_studio_cloud_monitoring";

/// The one state an account's card reports, worst first: the first that applies wins.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub enum AccountHealth {
    /// The provider stopped accepting the saved sign-in: only signing in again fixes it.
    SignedOut,
    /// The last refresh failed and older usage is still shown.
    OutOfDate,
    /// A refresh failed before any usage loaded.
    RefreshFailed,
    /// A Google AI Studio key that works but has no quota data. Not refreshed on a schedule.
    KeyOnly,
    /// A Google AI Studio account whose quota windows are not in yet.
    Setup,
    /// No usage yet, or the provider reports none.
    Inactive,
    Live,
}

impl AccountHealth {
    pub fn of(account: &Account) -> Self {
        let freshness = account.last_usage.as_ref().map(|usage| &usage.freshness);
        let google = GoogleSetup::of(account);
        if signed_out(account) {
            Self::SignedOut
        } else if freshness == Some(&UsageFreshness::Stale) {
            Self::OutOfDate
        } else if account.last_error.is_some() {
            Self::RefreshFailed
        } else if google == Some(GoogleSetup::KeyOnly) {
            Self::KeyOnly
        } else if google.is_some_and(|setup| setup != GoogleSetup::Ready) {
            Self::Setup
        } else if matches!(freshness, None | Some(UsageFreshness::Unavailable)) {
            Self::Inactive
        } else {
            Self::Live
        }
    }
}

/// How far a Google AI Studio account's Cloud usage setup has got, from its last usage.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub enum GoogleSetup {
    /// The key works; Cloud usage is not connected.
    KeyOnly,
    /// Cloud usage is connected and its first quota data is on its way.
    Waiting,
    /// Quota windows with a value were read from Cloud Monitoring.
    Ready,
    /// No usage yet, or Cloud Monitoring returned no quota windows.
    Unknown,
}

impl GoogleSetup {
    /// `None` for an account of another provider.
    pub fn of(account: &Account) -> Option<Self> {
        if account.provider != Provider::GoogleAiStudio {
            return None;
        }
        let Some(usage) = account.last_usage.as_ref() else {
            return Some(Self::Unknown);
        };
        Some(match usage.source.as_str() {
            SOURCE_MODELS_ONLY => Self::KeyOnly,
            SOURCE_MONITORING_WAITING => Self::Waiting,
            SOURCE_MONITORING
                if usage
                    .windows
                    .iter()
                    .any(|window| window.remaining_percent.is_some()) =>
            {
                Self::Ready
            }
            _ => Self::Unknown,
        })
    }
}

/// The provider stopped accepting this account's saved sign-in.
fn signed_out(account: &Account) -> bool {
    account.auth_required
        || account
            .last_usage
            .as_ref()
            .is_some_and(|usage| usage.freshness == UsageFreshness::AuthRequired)
}

/// The `status` the local API reports. Older and narrower than [`AccountHealth`], and part of a
/// published contract (`schemaVersion: 1`): only the sign-in and the usage freshness decide it.
pub fn public_status(account: &Account) -> &'static str {
    if signed_out(account) {
        return "auth_required";
    }
    match account.last_usage.as_ref().map(|usage| &usage.freshness) {
        Some(UsageFreshness::Live) => "available",
        Some(UsageFreshness::Stale) => "stale",
        _ => "unavailable",
    }
}

#[cfg(test)]
mod tests;

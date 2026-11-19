//! Which of an account's windows the sidebar's two meters read: the 5-hour meter and the long
//! meter (7-day, or 30-day for an account that has only a monthly limit). Sent with every account
//! (`Account`'s `Serialize` in `model.rs`). The frontend still skips a window whose reset time
//! has passed, because that depends on the clock when it draws, not when the account was sent.

use crate::model::{Account, Provider, UsageWindow, WindowKind};
use serde::Serialize;

/// Indexes into the account's `lastUsage.windows`, best first.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub struct Headline {
    /// The 5-hour windows. The meter shows the first that has not reset yet, even without a value.
    pub five_hour: Vec<usize>,
    /// The 7-day windows, then the 30-day ones. The meter shows the first that has not reset yet
    /// and has a value.
    pub long: Vec<usize>,
    /// What the long meter measures for this account, for its label.
    pub long_window: Option<LongWindow>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub enum LongWindow {
    Weekly,
    Monthly,
    /// No 7-day or 30-day window yet, but a free ChatGPT plan, whose limit is 30 days.
    MonthlyByPlan,
}

impl Headline {
    pub fn of(account: &Account) -> Self {
        let windows: &[UsageWindow] = account
            .last_usage
            .as_ref()
            .map_or(&[], |usage| usage.windows.as_slice());
        let of_kind = |kind: WindowKind| {
            windows
                .iter()
                .enumerate()
                .filter(move |(_, window)| window.kind == Some(kind))
                .map(|(index, _)| index)
        };
        // A window can name its length in its id without the backend having classified it.
        let has = |kind: WindowKind| {
            windows
                .iter()
                .any(|window| window.kind == Some(kind) || window.id == kind.as_str())
        };
        let long_window = if has(WindowKind::Weekly) {
            Some(LongWindow::Weekly)
        } else if has(WindowKind::Monthly) {
            Some(LongWindow::Monthly)
        } else if is_free_chatgpt(account) {
            Some(LongWindow::MonthlyByPlan)
        } else {
            None
        };
        Self {
            five_hour: of_kind(WindowKind::FiveHour).collect(),
            long: of_kind(WindowKind::Weekly)
                .chain(of_kind(WindowKind::Monthly))
                .collect(),
            long_window,
        }
    }
}

/// A ChatGPT account on a free plan ("free", "Free", "free_workspace").
fn is_free_chatgpt(account: &Account) -> bool {
    account.provider == Provider::Openai
        && account
            .plan
            .as_deref()
            .is_some_and(|plan| plan.to_lowercase().contains("free"))
}

#[cfg(test)]
mod tests;

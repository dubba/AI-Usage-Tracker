//! The usage alert rules: which of an account's windows an alert watches, which alerts can be
//! turned on for an account, and when a watched window has crossed its threshold. The app's
//! alert store (`store/alerts.rs`) keeps the settings and what it already notified about, and
//! sends the notifications.

use crate::{
    model::{Account, UsageWindow, WindowKind},
    plan::{chatgpt_plan, ChatgptPlan},
};
use std::collections::HashSet;

/// The windows an alert can watch, in the order the settings are shown.
pub const ALERT_WINDOW_IDS: [&str; 3] = ["five_hour", "weekly", "monthly"];

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AlertNotification {
    pub window_label: String,
    pub remaining_percent: u8,
    pub threshold_percent: u8,
}

/// The id the alert settings use for a window: its kind, if it has one.
pub fn window_id(window: &UsageWindow) -> Option<&'static str> {
    window.kind.map(WindowKind::as_str)
}

/// Whether a ChatGPT account counts as free for its 30-day alert. Without a stored plan it does:
/// snapshots saved before plans were read may hold the 30-day limit under the id `session`.
fn free_for_alerts(account: &Account) -> bool {
    matches!(
        chatgpt_plan(account),
        Some(ChatgptPlan::Free | ChatgptPlan::Unknown)
    )
}

/// Whether an alert for `window_id` can be turned on: the account has such a window, or its
/// ChatGPT plan says it will (30-day for a free plan, 5-hour and weekly for a paid one), so an
/// alert can be set before the first usage arrives.
pub fn is_available(account: &Account, window_id: &str) -> bool {
    let has_window = account.last_usage.as_ref().is_some_and(|usage| {
        usage
            .windows
            .iter()
            .any(|window| self::window_id(window) == Some(window_id))
    });
    has_window
        || match window_id {
            "monthly" => free_for_alerts(account),
            "five_hour" | "weekly" => chatgpt_plan(account) == Some(ChatgptPlan::Paid),
            _ => false,
        }
}

/// Whether an alert for `window_id` watches `window`.
fn watches(account: &Account, window_id: &str, window: &UsageWindow) -> bool {
    self::window_id(window) == Some(window_id)
        || (window_id == "monthly"
            && free_for_alerts(account)
            && (window.id == "session" || window.id == "monthly"))
}

/// Checks one enabled alert against the account's last usage. `notified` holds the keys of the
/// windows and periods already notified about; a window that is below the threshold for the
/// first time in its period is notified and added, and one that has recovered is removed, so it
/// can notify again. Returns the notifications to send and whether `notified` changed.
pub fn check(
    account: &Account,
    window_id: &str,
    threshold_percent: u8,
    notified: &mut HashSet<String>,
) -> (Vec<AlertNotification>, bool) {
    let mut notifications = Vec::new();
    let mut changed = false;
    let Some(usage) = account.last_usage.as_ref() else {
        return (notifications, changed);
    };
    for window in usage
        .windows
        .iter()
        .filter(|window| watches(account, window_id, window))
    {
        let Some(remaining) = window.remaining_percent.filter(|value| value.is_finite()) else {
            continue;
        };
        let remaining = remaining.clamp(0.0, 100.0).round() as u8;
        // Keys name the window and its period, so a new period can notify again. Keys written
        // before windows were named (`period:threshold`) still count.
        let (key, legacy_key) = match window.resets_at.as_deref() {
            Some(period) => (
                format!("{}:{period}:{threshold_percent}", window.id),
                Some(format!("{period}:{threshold_percent}")),
            ),
            None => (format!("{}:{threshold_percent}", window.id), None),
        };
        let already_notified = notified.contains(&key)
            || legacy_key
                .as_deref()
                .is_some_and(|key| notified.contains(key));

        if remaining <= threshold_percent {
            if !already_notified {
                notified.insert(key);
                changed = true;
                notifications.push(AlertNotification {
                    window_label: label(window_id, window),
                    remaining_percent: remaining,
                    threshold_percent,
                });
            }
        } else if notified.remove(&key)
            || legacy_key
                .as_deref()
                .is_some_and(|key| notified.remove(key))
        {
            changed = true;
        }
    }
    (notifications, changed)
}

/// "30-day (GPT)": the alert's length, then the window's group when its label names one.
fn label(window_id: &str, window: &UsageWindow) -> String {
    let base = match window_id {
        "five_hour" => "5 hour",
        "weekly" => "Weekly",
        "monthly" => "30-day",
        _ => "Usage",
    };
    match window
        .label
        .split_once(" · ")
        .map(|(group, _)| group.trim())
    {
        Some(group) if !group.is_empty() => format!("{base} ({group})"),
        _ => base.into(),
    }
}

#[cfg(test)]
mod tests;

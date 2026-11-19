//! The usage alert rules: which of an account's windows an alert watches, which alerts can be
//! turned on for an account, and when a watched window has crossed its threshold. The app's
//! alert store (`store/alerts.rs`) keeps the settings and what it already notified about, and
//! sends the notifications.

use crate::{
    model::{Account, UsageWindow, WindowKind},
    plan::{chatgpt_plan, ChatgptPlan},
};
use chrono::DateTime;
use std::collections::HashSet;

/// The windows an alert can watch, in the order the settings are shown.
pub const ALERT_WINDOW_IDS: [&str; 3] = ["five_hour", "weekly", "monthly"];

/// Two `resets_at` timestamps this close belong to the same reset period. Providers can shift a
/// window's reset timestamp slightly between refreshes (for example seconds-until-reset rounding).
const RESET_JITTER_SECONDS: i64 = 600;

/// Additional remaining-percent milestones below the configured threshold where another alert is
/// sent once per quota period.
const FOLLOWUP_MILESTONES: [u8; 3] = [15, 5, 0];

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

#[derive(Clone, Copy)]
enum ParsedKey<'a> {
    Window {
        period: Option<&'a str>,
        milestone: Option<u8>,
    },
    Legacy {
        period: &'a str,
    },
}

fn parse_rfc3339_seconds(value: &str) -> Option<i64> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|dt| dt.timestamp())
}

fn periods_match(left: &str, right: &str) -> bool {
    if left == right {
        return true;
    }
    match (parse_rfc3339_seconds(left), parse_rfc3339_seconds(right)) {
        (Some(a), Some(b)) => (a - b).abs() <= RESET_JITTER_SECONDS,
        _ => false,
    }
}

fn parse_key<'a>(key: &'a str, window_id: &str, threshold_percent: u8) -> Option<ParsedKey<'a>> {
    if let Some(rest) = key
        .strip_prefix(window_id)
        .and_then(|s| s.strip_prefix(':'))
    {
        let (base, milestone) = match rest.rsplit_once('@') {
            Some((base, ms)) => (base, Some(ms.parse::<u8>().ok()?)),
            None => (rest, None),
        };
        if let Some((period, threshold)) = base.rsplit_once(':') {
            if threshold.parse::<u8>().ok()? == threshold_percent {
                return Some(ParsedKey::Window {
                    period: Some(period),
                    milestone,
                });
            }
        } else if base.parse::<u8>().ok()? == threshold_percent {
            return Some(ParsedKey::Window {
                period: None,
                milestone,
            });
        }
        return None;
    }

    if !key.contains('@') {
        if let Some((period, threshold)) = key.rsplit_once(':') {
            if threshold.parse::<u8>().ok()? == threshold_percent
                && parse_rfc3339_seconds(period).is_some()
            {
                return Some(ParsedKey::Legacy { period });
            }
        }
    }
    None
}

fn milestones_for(threshold_percent: u8) -> Vec<u8> {
    let mut milestones = Vec::with_capacity(4);
    milestones.push(threshold_percent);
    for milestone in FOLLOWUP_MILESTONES {
        if milestone < threshold_percent {
            milestones.push(milestone);
        }
    }
    milestones
}

fn format_milestone_key(
    window_id: &str,
    period: Option<&str>,
    threshold_percent: u8,
    milestone: u8,
) -> String {
    match period {
        Some(period) => format!("{window_id}:{period}:{threshold_percent}@{milestone}"),
        None => format!("{window_id}:{threshold_percent}@{milestone}"),
    }
}

/// Checks one enabled alert against the account's last usage. `notified` holds the keys of the
/// windows, periods, and milestones already notified about; a window notifies once at
/// `threshold_percent` and again when reaching 15%, 5%, and 0% remaining within the same reset
/// period. Recovering above `threshold_percent` clears the period's keys so a later drop can
/// notify again. Returns the notifications to send and whether `notified` changed.
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
    let milestones = milestones_for(threshold_percent);
    for window in usage
        .windows
        .iter()
        .filter(|window| watches(account, window_id, window))
    {
        let Some(remaining) = window.remaining_percent.filter(|value| value.is_finite()) else {
            continue;
        };
        let remaining = remaining.clamp(0.0, 100.0).round() as u8;
        let current_period = window.resets_at.as_deref();

        let mut matching_keys = Vec::new();
        let mut stale_window_keys = Vec::new();
        let mut canonical_period: Option<String> = None;
        let mut notified_milestones = HashSet::new();

        for key in notified.iter() {
            let Some(parsed) = parse_key(key, &window.id, threshold_percent) else {
                continue;
            };
            match (current_period, parsed) {
                (
                    Some(current),
                    ParsedKey::Window {
                        period: Some(stored),
                        milestone,
                    },
                ) => {
                    if periods_match(stored, current) {
                        if canonical_period
                            .as_deref()
                            .is_none_or(|existing| stored < existing)
                        {
                            canonical_period = Some(stored.to_string());
                        }
                        notified_milestones.insert(milestone.unwrap_or(threshold_percent));
                        matching_keys.push(key.clone());
                    } else {
                        stale_window_keys.push(key.clone());
                    }
                }
                (Some(current), ParsedKey::Legacy { period: stored }) => {
                    if periods_match(stored, current) {
                        if canonical_period
                            .as_deref()
                            .is_none_or(|existing| stored < existing)
                        {
                            canonical_period = Some(stored.to_string());
                        }
                        notified_milestones.insert(threshold_percent);
                        matching_keys.push(key.clone());
                    }
                }
                (
                    None,
                    ParsedKey::Window {
                        period: None,
                        milestone,
                    },
                ) => {
                    notified_milestones.insert(milestone.unwrap_or(threshold_percent));
                    matching_keys.push(key.clone());
                }
                (Some(_), ParsedKey::Window { period: None, .. }) => {
                    stale_window_keys.push(key.clone());
                }
                (
                    None,
                    ParsedKey::Window {
                        period: Some(_), ..
                    }
                    | ParsedKey::Legacy { .. },
                ) => {}
            }
        }

        for stale in stale_window_keys {
            if notified.remove(&stale) {
                changed = true;
            }
        }

        if remaining > threshold_percent {
            for key in matching_keys {
                if notified.remove(&key) {
                    changed = true;
                }
            }
            continue;
        }

        let period_for_keys = canonical_period.as_deref().or(current_period);
        let reached: Vec<u8> = milestones
            .iter()
            .copied()
            .filter(|&milestone| remaining <= milestone)
            .collect();
        let has_new_milestone = reached
            .iter()
            .any(|milestone| !notified_milestones.contains(milestone));

        if has_new_milestone {
            for milestone in reached {
                if !notified_milestones.contains(&milestone) {
                    let key = format_milestone_key(
                        &window.id,
                        period_for_keys,
                        threshold_percent,
                        milestone,
                    );
                    if notified.insert(key) {
                        changed = true;
                    }
                }
            }
            notifications.push(AlertNotification {
                window_label: label(window_id, window),
                remaining_percent: remaining,
                threshold_percent,
            });
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

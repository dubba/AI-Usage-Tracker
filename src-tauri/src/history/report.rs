//! The answer to `get_weekly_activity`: for each tracker of each current account, one value per
//! local day, built from the live accounts (labels, plan, current usage) and the stored readings.
//!
//! The page sends the boundaries of its local days as RFC 3339 instants, so the backend never needs
//! the time zone and daylight saving time is the frontend's `Date` problem. The boundaries cross a
//! trust boundary, so they are checked here before anything is read.

use super::{
    activity::{daily_usage, DayUsage},
    parse_timestamp, tracker_key, tracker_windows, HistoryStore,
};
use crate::{
    model::{Account, UsageWindow, WindowKind, WEEKLY_WINDOW_SECONDS},
    state::AppState,
};
use chrono::{DateTime, SecondsFormat, Utc};
use serde::Serialize;

/// Fewest and most boundaries a request may carry: 1 to 31 days.
const MIN_BOUNDARIES: usize = 2;
const MAX_BOUNDARIES: usize = 32;
/// A local day is 24 hours, or 23 or 25 across a daylight saving change. Time zone shifts of other
/// kinds stay within an hour of that.
const MIN_DAY_SECONDS: i64 = 22 * 3600;
const MAX_DAY_SECONDS: i64 = 26 * 3600;
/// An RFC 3339 instant is at most about 35 characters; anything longer is not one.
const MAX_BOUNDARY_CHARS: usize = 64;
/// Readings are read from this long before the first day, so the weekly period the range starts in
/// is known from its beginning.
const LOOKBACK_SECONDS: i64 = 8 * 24 * 3600;

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WeeklyActivity {
    pub trackers: Vec<ActivityTracker>,
    pub untracked: Vec<UntrackedAccount>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ActivityTracker {
    pub account_id: String,
    pub window_id: String,
    pub window_label: String,
    pub current_used_percent: Option<f64>,
    pub resets_at: Option<String>,
    /// One entry per requested day.
    pub days: Vec<DayUsage>,
    /// Weekly resets inside the range, as RFC 3339 instants.
    pub resets: Vec<String>,
}

/// An account that has no weekly limit to chart.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UntrackedAccount {
    pub account_id: String,
    pub other_limits: Vec<OtherLimit>,
}

/// What an account without a weekly limit has instead.
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum OtherLimit {
    FiveHour,
    Daily,
    PerMinute,
    Monthly,
    Other,
}

impl OtherLimit {
    fn of(window: &UsageWindow) -> Self {
        match window.kind {
            Some(WindowKind::FiveHour) => Self::FiveHour,
            Some(WindowKind::Monthly) => Self::Monthly,
            _ => match window.window_seconds {
                Some(86_400) => Self::Daily,
                Some(60) => Self::PerMinute,
                _ => Self::Other,
            },
        }
    }
}

/// The day boundaries as unix seconds, or why they are refused. `now` is unix seconds.
///
/// Refused: fewer than 2 or more than 32 boundaries, a boundary that is not an RFC 3339 instant,
/// boundaries that do not strictly increase, a day shorter than 22 or longer than 26 hours, and a
/// last boundary more than 26 hours from now (it is the end of today, so it cannot be further).
pub fn validate_day_starts(day_starts: &[String], now: i64) -> Result<Vec<i64>, String> {
    if !(MIN_BOUNDARIES..=MAX_BOUNDARIES).contains(&day_starts.len()) {
        return Err(format!(
            "Activity needs between {MIN_BOUNDARIES} and {MAX_BOUNDARIES} day boundaries."
        ));
    }
    let mut instants = Vec::with_capacity(day_starts.len());
    for text in day_starts {
        let instant = (text.len() <= MAX_BOUNDARY_CHARS)
            .then(|| parse_timestamp(text))
            .flatten()
            .ok_or("A day boundary is not a valid time.")?;
        instants.push(instant);
    }
    for pair in instants.windows(2) {
        if pair[1] <= pair[0] {
            return Err("Day boundaries must be in increasing order.".into());
        }
        if !(MIN_DAY_SECONDS..=MAX_DAY_SECONDS).contains(&(pair[1] - pair[0])) {
            return Err("Each day must last between 22 and 26 hours.".into());
        }
    }
    if instants
        .last()
        .is_some_and(|last| *last > now + MAX_DAY_SECONDS)
    {
        return Err("The last day boundary is too far in the future.".into());
    }
    Ok(instants)
}

/// Weekly activity for the current accounts over the days between `day_starts`.
pub fn weekly_activity(
    app: &AppState,
    day_starts: &[String],
    now: i64,
) -> Result<WeeklyActivity, String> {
    let bounds = validate_day_starts(day_starts, now)?;
    let accounts = app.account_order.apply(app.store.list())?;
    Ok(build(&accounts, &app.history, &bounds))
}

fn build(accounts: &[Account], history: &HistoryStore, bounds: &[i64]) -> WeeklyActivity {
    let mut keys = Vec::new();
    for account in accounts {
        for window in tracker_windows(account) {
            keys.push(tracker_key(&account.id, &window.id));
        }
    }
    let from = bounds.first().map_or(0, |start| start - LOOKBACK_SECONDS);
    let mut readings = history.readings(&keys, from);

    let mut trackers = Vec::new();
    let mut untracked = Vec::new();
    for account in accounts {
        let windows = tracker_windows(account);
        if windows.is_empty() {
            // An account that has never reported usage says nothing about its limits yet.
            if let Some(usage) = account
                .last_usage
                .as_ref()
                .filter(|u| !u.windows.is_empty())
            {
                let mut other_limits: Vec<OtherLimit> =
                    usage.windows.iter().map(OtherLimit::of).collect();
                other_limits.sort_unstable();
                other_limits.dedup();
                untracked.push(UntrackedAccount {
                    account_id: account.id.clone(),
                    other_limits,
                });
            }
            continue;
        }
        for window in windows {
            let own = readings
                .remove(&tracker_key(&account.id, &window.id))
                .unwrap_or_default();
            let window_seconds = window
                .window_seconds
                .and_then(|seconds| i64::try_from(seconds).ok())
                .unwrap_or(WEEKLY_WINDOW_SECONDS as i64);
            let current_reset = window.resets_at.as_deref().and_then(parse_timestamp);
            let activity = daily_usage(&own, bounds, window_seconds, current_reset);
            trackers.push(ActivityTracker {
                account_id: account.id.clone(),
                window_id: window.id.clone(),
                window_label: window.label.clone(),
                current_used_percent: window.used_percent,
                resets_at: window.resets_at.clone(),
                days: activity.days,
                resets: activity.resets.iter().filter_map(|t| rfc3339(*t)).collect(),
            });
        }
    }
    WeeklyActivity {
        trackers,
        untracked,
    }
}

fn rfc3339(t: i64) -> Option<String> {
    DateTime::<Utc>::from_timestamp(t, 0)
        .map(|time| time.to_rfc3339_opts(SecondsFormat::Secs, true))
}

#[cfg(test)]
mod tests;

//! From readings to one number per day: how much of the weekly limit was used on each local day.
//!
//! A reading says how much of the window was used *at that moment*. The difference between two
//! readings is usage that happened somewhere between them, so each difference is spread over the
//! time between the two readings and added to the days it touches. This module knows nothing about
//! time zones: the caller passes the day boundaries.

use super::Reading;
use crate::model::WEEKLY_WINDOW_SECONDS;
use serde::Serialize;

/// Readings further apart than this were not watched continuously. The time between them does not
/// count as observed, and usage found in it is an estimate.
pub const OBSERVED_GAP_SECONDS: i64 = 3 * 3600;

/// Two reset times this close are the same reset. OpenAI derives `resets_at` from "seconds until
/// reset", so it moves a little between refreshes.
const RESET_JITTER_SECONDS: i64 = 600;

/// A fall in used percent at least this big, with no reset time to say why, is a reset. Smaller
/// falls are the provider rounding differently.
const RESET_DROP_PERCENT: f64 = 5.0;

/// How far a new reset time may sit from a whole number of windows and still be the next period
/// of the same schedule. A sliding reset moves by minutes, which is not one of these steps.
const RESET_STEP_SLOP_SECONDS: i64 = 6 * 3600;

/// The one filled-in week and a reset the provider recorded are the same line when this close.
const SAME_RESET_SECONDS: i64 = 24 * 3600;

/// How well a day's value is known.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DayQuality {
    /// Every refresh that contributed was at most three hours from the one before it.
    Measured,
    /// Part of the value was spread over a longer stretch in which the app was not refreshing.
    Approximate,
    /// Nothing was observed that day. This is not the same as 0%.
    None,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DayUsage {
    /// Percent of the weekly limit used that day, or `None` when `quality` is `None`.
    pub used_percent: Option<f64>,
    pub quality: DayQuality,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Activity {
    /// One entry per day.
    pub days: Vec<DayUsage>,
    /// Reset lines to draw, oldest first. Each is a reset time the provider named that has since
    /// passed. A weekly limit also gets the one week before its latest reset when that week was
    /// not named. Nothing older is filled in, and a usage drop does not add a line.
    pub resets: Vec<i64>,
}

#[derive(Clone, Copy, Default)]
struct DayTotal {
    percent: f64,
    /// Some time of the day lies between two readings at most three hours apart.
    observed: bool,
    /// Some of `percent` was spread over a longer stretch.
    estimated: bool,
}

/// Daily usage for the days between consecutive `day_starts` (N days need N + 1 boundaries, in
/// unix seconds, increasing).
///
/// `readings` may be in any order and may repeat; send every reading you have from a week before
/// the range onward, so the period the range starts in is known from its beginning. A reading
/// before the first one is not needed: the first reading is only a starting point and adds
/// nothing itself. `window_seconds` is the length of the window and `current_reset` the reset time
/// the account reports now, if any.
///
/// A new weekly period starts at a reading when
/// - the reset time of the one before has passed (within jitter), unless this reading still names
///   that same reset time (the provider has not rolled over, so nothing was reset), or
/// - the used percent fell at least five points (a reset occurred even if reset times are missing
///   or rescheduled). A sliding future reset time on an unused account does not start a new period.
///
/// Inside a period only a rise above the highest value seen so far counts, so a reading that is a
/// little lower (rounding) or repeated (two devices watching the same account) adds nothing. At the
/// start of a period the whole reading counts, from the start of the period if its reset time is
/// known, else from the reading before.
pub fn daily_usage(
    readings: &[Reading],
    day_starts: &[i64],
    window_seconds: i64,
    current_reset: Option<i64>,
) -> Activity {
    let day_count = day_starts.len().saturating_sub(1);
    let mut totals = vec![DayTotal::default(); day_count];

    let mut sorted = readings.to_vec();
    sorted.sort_by_key(|reading| reading.t);
    sorted.dedup_by_key(|reading| reading.t);

    if let Some((first, rest)) = sorted.split_first() {
        let mut previous = *first;
        let mut high_water = f64::from(first.u);
        for current in rest {
            let used = f64::from(current.u);
            let (increment, from) = if starts_new_period(&previous, current, high_water) {
                high_water = used;
                (used, period_start(&previous, current, window_seconds))
            } else {
                let increment = (used - high_water).max(0.0);
                high_water = high_water.max(used);
                (increment, previous.t)
            };
            if current.t - previous.t <= OBSERVED_GAP_SECONDS {
                for_each_overlap(day_starts, previous.t, current.t, |day, _| {
                    totals[day].observed = true;
                });
            }
            let estimated = current.t - from > OBSERVED_GAP_SECONDS;
            for_each_overlap(day_starts, from, current.t, |day, overlap| {
                let share = increment * overlap as f64 / (current.t - from) as f64;
                totals[day].percent += share;
                totals[day].estimated |= estimated && share > 0.0;
            });
            previous = *current;
        }
    }

    let (Some(&range_start), Some(&range_end)) = (day_starts.first(), day_starts.last()) else {
        return Activity {
            days: Vec::new(),
            resets: Vec::new(),
        };
    };

    // Lines are reset times the provider held still and then moved forward by a whole window.
    // That is the reset that passed. A sliding clock, which moves by minutes, never qualifies.
    // A weekly limit with no older named reset still gets the single week before its latest one.
    let anchor = current_reset.or_else(|| sorted.iter().filter_map(|reading| reading.r).max());
    let mut resets = recorded_reset_instants(&sorted, window_seconds);
    if let Some(anchor) = anchor {
        if window_seconds == WEEKLY_WINDOW_SECONDS as i64 {
            let previous = anchor - window_seconds;
            if (range_start..=range_end).contains(&previous) && !near_any(&resets, previous) {
                resets.push(previous);
            }
        }
        if (range_start..=range_end).contains(&anchor) && !near_any(&resets, anchor) {
            resets.push(anchor);
        }
    }
    resets.retain(|instant| (range_start..=range_end).contains(instant));
    resets.sort_unstable();
    let mut collapsed = Vec::with_capacity(resets.len());
    for instant in resets {
        if collapsed
            .last()
            .is_some_and(|earlier: &i64| instant - earlier <= RESET_JITTER_SECONDS)
        {
            continue;
        }
        collapsed.push(instant);
    }
    let resets = collapsed;

    let days = totals
        .iter()
        .map(|total| {
            if !total.observed && total.percent <= 0.0 {
                DayUsage {
                    used_percent: None,
                    quality: DayQuality::None,
                }
            } else {
                DayUsage {
                    used_percent: Some((total.percent * 100.0).round() / 100.0),
                    quality: if total.estimated {
                        DayQuality::Approximate
                    } else {
                        DayQuality::Measured
                    },
                }
            }
        })
        .collect();
    Activity { days, resets }
}

fn starts_new_period(previous: &Reading, current: &Reading, high_water: f64) -> bool {
    if let Some(before) = previous.r {
        let still_the_old_window =
            matches!(current.r, Some(now) if (now - before).abs() <= RESET_JITTER_SECONDS);
        if current.t + RESET_JITTER_SECONDS >= before && !still_the_old_window {
            return true;
        }
    }
    high_water - f64::from(current.u) >= RESET_DROP_PERCENT
}

/// Where the usage in the first reading of a period starts: the start of the period when the
/// reading names its reset time, else the reading before.
fn period_start(previous: &Reading, current: &Reading, window_seconds: i64) -> i64 {
    match current.r {
        Some(reset) if window_seconds > 0 => {
            let start = reset - window_seconds;
            if start > previous.t && start < current.t {
                start
            } else {
                previous.t
            }
        }
        _ => previous.t,
    }
}

/// Reset times the provider named, then replaced with the next period of the same schedule.
///
/// Readings name the upcoming reset. While that time stays put (within jitter) it is one reset.
/// When the next reading names a time one or more whole windows later, the time that was left
/// behind is a reset that happened. A reset that only slides forward with the clock is not.
fn recorded_reset_instants(readings: &[Reading], window_seconds: i64) -> Vec<i64> {
    let mut events = Vec::new();
    let mut named: Option<i64> = None;
    for reading in readings {
        let Some(reset) = reading.r else {
            continue;
        };
        match named {
            None => named = Some(reset),
            Some(previous) if (reset - previous).abs() <= RESET_JITTER_SECONDS => {}
            Some(previous) => {
                if is_next_period(previous, reset, window_seconds) {
                    events.push(previous);
                }
                named = Some(reset);
            }
        }
    }
    events
}

/// `new_reset` is one or more whole windows after `previous`.
fn is_next_period(previous: i64, new_reset: i64, window_seconds: i64) -> bool {
    if window_seconds <= 0 || new_reset <= previous {
        return false;
    }
    let delta = new_reset - previous;
    let periods = (delta as f64 / window_seconds as f64).round() as i64;
    if periods < 1 {
        return false;
    }
    (delta - periods * window_seconds).abs() <= RESET_STEP_SLOP_SECONDS
}

fn near_any(instants: &[i64], instant: i64) -> bool {
    instants
        .iter()
        .any(|existing| (existing - instant).abs() <= SAME_RESET_SECONDS)
}

/// Calls `visit(day, seconds)` for every day that the interval `(from, to]` overlaps, with the
/// length of the overlap. Day `i` is `day_starts[i]..day_starts[i + 1]`.
fn for_each_overlap(day_starts: &[i64], from: i64, to: i64, mut visit: impl FnMut(usize, i64)) {
    for (day, bounds) in day_starts.windows(2).enumerate() {
        let overlap = to.min(bounds[1]) - from.max(bounds[0]);
        if overlap > 0 {
            visit(day, overlap);
        }
    }
}

#[cfg(test)]
mod tests;

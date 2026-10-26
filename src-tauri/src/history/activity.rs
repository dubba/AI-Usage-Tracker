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
    /// Unix seconds of each weekly reset inside the range, oldest first.
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
    let mut resets = Vec::new();

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
                resets.push(reset_instant(&previous, current));
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

    if window_seconds >= WEEKLY_WINDOW_SECONDS as i64 {
        if let Some(anchor) = current_reset.or_else(|| resets.iter().copied().max()) {
            project_cadence(&mut resets, anchor, window_seconds, range_start, range_end);
        }
    } else {
        resets.extend(current_reset);
    }

    resets.retain(|instant| (range_start..=range_end).contains(instant));
    resets.sort_unstable();
    resets.dedup_by(|later, earlier| *later - *earlier <= RESET_JITTER_SECONDS);

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

/// When the period that ends at `previous` is taken to have ended: its reset time, when it is
/// known and was not in the future of `current`, else when `current` showed it was over.
fn reset_instant(previous: &Reading, current: &Reading) -> i64 {
    previous
        .r
        .map_or(current.t, |reset| reset.clamp(previous.t, current.t))
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

/// Projects a periodic reset cadence (e.g. weekly or monthly) across `[range_start, range_end]`
/// from a known reset instant `anchor`, so scheduled resets on periods without stored readings
/// are still displayed.
fn project_cadence(
    resets: &mut Vec<i64>,
    anchor: i64,
    step: i64,
    range_start: i64,
    range_end: i64,
) {
    if step <= 0 {
        return;
    }
    let mut t = anchor;
    while t > range_end {
        t -= step;
    }
    while t >= range_start {
        resets.push(t);
        t -= step;
    }
    let mut t = anchor + step;
    while t < range_start {
        t += step;
    }
    while t <= range_end {
        resets.push(t);
        t += step;
    }
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

use super::*;

const HOUR: i64 = 3600;
const DAY: i64 = 24 * HOUR;
const WEEK: i64 = 7 * DAY;
/// A UTC midnight (day 20000 since 1970).
const BASE: i64 = 20_000 * DAY;

fn reading(t: i64, used: f32, reset: Option<i64>) -> Reading {
    Reading {
        t,
        u: used,
        r: reset,
    }
}

/// `count` days of 24 hours starting at `BASE`: `count + 1` boundaries.
fn days(count: i64) -> Vec<i64> {
    (0..=count).map(|day| BASE + day * DAY).collect()
}

fn percents(activity: &Activity) -> Vec<Option<f64>> {
    activity.days.iter().map(|day| day.used_percent).collect()
}

fn qualities(activity: &Activity) -> Vec<DayQuality> {
    activity.days.iter().map(|day| day.quality).collect()
}

fn usage(readings: &[Reading], day_count: i64) -> Activity {
    daily_usage(readings, &days(day_count), WEEK, None)
}

#[test]
fn a_rise_between_readings_counts_on_the_day_it_happened() {
    let activity = usage(
        &[
            reading(BASE + HOUR, 10.0, None),
            reading(BASE + 2 * HOUR, 12.0, None),
            reading(BASE + 3 * HOUR, 15.0, None),
        ],
        2,
    );
    assert_eq!(percents(&activity), [Some(5.0), None]);
    assert_eq!(
        qualities(&activity),
        [DayQuality::Measured, DayQuality::None]
    );
    assert!(activity.resets.is_empty());
}

#[test]
fn a_changed_reset_time_starts_a_new_period() {
    let old_reset = BASE + 2 * HOUR + HOUR / 2;
    let activity = usage(
        &[
            reading(BASE + HOUR, 50.0, Some(old_reset)),
            reading(BASE + 2 * HOUR, 60.0, Some(old_reset)),
            // The window reset: the new one ends a week after the old one.
            reading(BASE + 3 * HOUR, 5.0, Some(old_reset + WEEK)),
        ],
        1,
    );
    // 10 points before the reset and the 5 used since it, not a fall of 55.
    assert_eq!(percents(&activity), [Some(15.0)]);
    assert_eq!(activity.resets, [old_reset]);
}

#[test]
fn a_reset_time_that_passed_while_the_app_was_off_starts_a_new_period() {
    let reset = BASE + 2 * HOUR;
    let activity = usage(
        &[
            reading(BASE + HOUR, 80.0, Some(reset)),
            // The app was closed across the reset and the provider names no new one yet.
            reading(BASE + 10 * HOUR, 3.0, None),
        ],
        1,
    );
    assert_eq!(percents(&activity), [Some(3.0)]);
    // Spread over the nine hours it was unwatched, so it is an estimate.
    assert_eq!(qualities(&activity), [DayQuality::Approximate]);
    assert_eq!(activity.resets, [reset]);
}

#[test]
fn a_reading_after_the_reset_time_that_still_names_it_is_not_a_reset() {
    let reset = BASE + 2 * HOUR;
    let activity = usage(
        &[
            reading(BASE + HOUR, 80.0, Some(reset)),
            // The provider has not rolled the window over yet: same reset time, still 81%.
            reading(BASE + 3 * HOUR, 81.0, Some(reset)),
        ],
        1,
    );
    assert_eq!(percents(&activity), [Some(1.0)]);
    // The provider still names this reset, and it falls in the chart, so the line stays. Usage is
    // not started over, because the window has not rolled.
    assert_eq!(activity.resets, [reset]);
}

#[test]
fn a_fall_of_five_points_without_a_reset_time_starts_a_new_period() {
    let activity = usage(
        &[
            reading(BASE + HOUR, 60.0, None),
            reading(BASE + 2 * HOUR, 70.0, None),
            reading(BASE + 3 * HOUR, 4.0, None),
        ],
        1,
    );
    assert_eq!(percents(&activity), [Some(14.0)]);
    // The drop starts a new period for the day totals. It is not a reset the provider recorded,
    // so the chart draws no line.
    assert!(activity.resets.is_empty());
}

#[test]
fn a_fall_of_less_than_five_points_without_a_reset_time_is_rounding() {
    let activity = usage(
        &[
            reading(BASE + HOUR, 60.0, None),
            reading(BASE + 2 * HOUR, 70.0, None),
            reading(BASE + 3 * HOUR, 66.0, None),
        ],
        1,
    );
    assert_eq!(percents(&activity), [Some(10.0)]);
    assert!(activity.resets.is_empty());
}

#[test]
fn reset_times_a_few_minutes_apart_are_the_same_reset() {
    let reset = BASE + 3 * DAY;
    let activity = usage(
        &[
            reading(BASE + HOUR, 10.0, Some(reset)),
            reading(BASE + 2 * HOUR, 12.0, Some(reset + 90)),
            reading(BASE + 3 * HOUR, 13.0, Some(reset - 400)),
        ],
        1,
    );
    assert_eq!(percents(&activity), [Some(3.0)]);
    assert!(activity.resets.is_empty());
}

#[test]
fn a_sliding_future_reset_time_on_an_unused_account_is_not_a_reset() {
    // Providers like Antigravity dynamically report `resetTime = now + 7 days` while quota is
    // unused. The sliding time does not start a new period. The chart still marks one week before
    // the latest advertised reset, and nothing earlier.
    let activity = usage(
        &[
            reading(BASE + HOUR, 0.0, Some(BASE + HOUR + WEEK)),
            reading(BASE + HOUR + 900, 0.0, Some(BASE + HOUR + 900 + WEEK)),
            reading(BASE + HOUR + 1800, 0.0, Some(BASE + HOUR + 1800 + WEEK)),
        ],
        1,
    );
    assert_eq!(percents(&activity), [Some(0.0)]);
    // The latest advertised reset is a week ahead, outside this day. The one line is that instant
    // minus a week, which is the last sample. No earlier line is added.
    assert_eq!(activity.resets, [BASE + HOUR + 1800]);
}

#[test]
fn usage_starting_after_a_sliding_reset_time_counts_as_usage_not_a_reset() {
    let activity = usage(
        &[
            reading(BASE + HOUR, 0.0, Some(BASE + HOUR + WEEK)),
            reading(BASE + HOUR + 900, 0.0, Some(BASE + HOUR + 900 + WEEK)),
            // The user begins using the account; quota becomes 10% and the reset time locks in.
            reading(BASE + HOUR + 1800, 10.0, Some(BASE + HOUR + 1800 + WEEK)),
        ],
        1,
    );
    assert_eq!(percents(&activity), [Some(10.0)]);
    assert_eq!(activity.resets, [BASE + HOUR + 1800]);
}

#[test]
fn a_small_decrease_is_ignored_and_does_not_lower_the_high_water_mark() {
    let activity = usage(
        &[
            reading(BASE + HOUR, 10.0, None),
            reading(BASE + 2 * HOUR, 9.5, None),
            reading(BASE + 3 * HOUR, 10.2, None),
        ],
        1,
    );
    // Only the 0.2 above the earlier 10.0 is new.
    assert_eq!(percents(&activity), [Some(0.2)]);
}

#[test]
fn the_first_reading_is_only_a_starting_point() {
    let activity = usage(&[reading(BASE + HOUR, 40.0, None)], 1);
    assert_eq!(percents(&activity), [None]);
    assert_eq!(qualities(&activity), [DayQuality::None]);

    let none = usage(&[], 2);
    assert_eq!(percents(&none), [None, None]);
}

#[test]
fn a_flat_stretch_that_was_watched_is_zero_not_missing() {
    let activity = usage(
        &[
            reading(BASE + HOUR, 20.0, None),
            reading(BASE + 2 * HOUR, 20.0, None),
        ],
        2,
    );
    assert_eq!(percents(&activity), [Some(0.0), None]);
    assert_eq!(
        qualities(&activity),
        [DayQuality::Measured, DayQuality::None]
    );
}

#[test]
fn a_gap_across_midnight_is_split_by_time_and_marked_approximate() {
    let activity = usage(
        &[
            reading(BASE + DAY - 6 * HOUR, 10.0, None),
            reading(BASE + DAY + 6 * HOUR, 22.0, None),
        ],
        2,
    );
    assert_eq!(percents(&activity), [Some(6.0), Some(6.0)]);
    assert_eq!(
        qualities(&activity),
        [DayQuality::Approximate, DayQuality::Approximate]
    );
}

#[test]
fn a_watched_gap_across_midnight_is_split_but_measured() {
    let activity = usage(
        &[
            reading(BASE + DAY - HOUR, 10.0, None),
            reading(BASE + DAY + 2 * HOUR, 13.0, None),
        ],
        2,
    );
    assert_eq!(percents(&activity), [Some(1.0), Some(2.0)]);
    assert_eq!(
        qualities(&activity),
        [DayQuality::Measured, DayQuality::Measured]
    );
}

#[test]
fn days_of_other_lengths_split_by_the_time_each_one_covers() {
    // A 23-hour day followed by a 25-hour one (the clocks changed).
    let starts = [BASE, BASE + 23 * HOUR, BASE + 48 * HOUR];
    let activity = daily_usage(
        &[
            reading(BASE + 22 * HOUR, 0.0, None),
            reading(BASE + 25 * HOUR, 30.0, None),
        ],
        &starts,
        WEEK,
        None,
    );
    assert_eq!(percents(&activity), [Some(10.0), Some(20.0)]);
}

#[test]
fn a_day_inside_a_long_gap_with_no_usage_has_no_data() {
    let activity = usage(
        &[
            reading(BASE + HOUR, 10.0, None),
            reading(BASE + 2 * HOUR, 11.0, None),
            reading(BASE + 3 * DAY + 5 * HOUR, 11.0, None),
        ],
        4,
    );
    // The app was off for three days and the percent did not move, so nothing was used while it
    // was off; but nobody was watching, so those days are unknown rather than 0.
    assert_eq!(percents(&activity), [Some(1.0), None, None, None]);
}

#[test]
fn the_first_reading_of_a_new_period_counts_from_the_start_of_the_period() {
    let day_two = BASE + DAY;
    let activity = usage(
        &[
            reading(BASE + 12 * HOUR, 90.0, Some(day_two - HOUR)),
            // The app was off. The new window began at midnight (its reset is a week later).
            reading(day_two + 6 * HOUR, 8.0, Some(day_two + WEEK)),
        ],
        2,
    );
    // The 8% was used after midnight, so none of it lands on day one.
    assert_eq!(percents(&activity), [None, Some(8.0)]);
    assert_eq!(qualities(&activity)[1], DayQuality::Approximate);
    // The provider named the reset an hour before midnight. The week implied by the later reset
    // is that same line.
    assert_eq!(activity.resets, [day_two - HOUR]);
}

#[test]
fn a_period_start_outside_the_gap_is_not_trusted() {
    // The new window's reset is a month away, which would put its start after the reading itself.
    let activity = usage(
        &[
            reading(BASE + HOUR, 50.0, Some(BASE + 2 * HOUR)),
            reading(BASE + 5 * HOUR, 5.0, Some(BASE + 5 * HOUR + 30 * DAY)),
        ],
        1,
    );
    assert_eq!(percents(&activity), [Some(5.0)]);
}

#[test]
fn readings_out_of_order_or_repeated_are_counted_once() {
    let in_order = [
        reading(BASE + HOUR, 10.0, None),
        reading(BASE + 2 * HOUR, 12.0, None),
        reading(BASE + 3 * HOUR, 15.0, None),
    ];
    let scrambled = [
        in_order[2],
        in_order[0],
        in_order[1],
        in_order[1],
        in_order[0],
        in_order[2],
    ];
    assert_eq!(usage(&scrambled, 1), usage(&in_order, 1));
    assert_eq!(percents(&usage(&scrambled, 1)), [Some(5.0)]);
}

#[test]
fn two_devices_watching_the_same_account_do_not_double_count() {
    // Device A refreshes on the hour, device B half past; they see the same usage.
    let activity = usage(
        &[
            reading(BASE + HOUR, 10.0, None),
            reading(BASE + HOUR + 1800, 10.0, None),
            reading(BASE + 2 * HOUR, 14.0, None),
            reading(BASE + 2 * HOUR + 1800, 14.0, None),
            reading(BASE + 3 * HOUR, 14.0, None),
        ],
        1,
    );
    assert_eq!(percents(&activity), [Some(4.0)]);
}

#[test]
fn resets_are_listed_inside_the_range_with_the_current_one() {
    let first = BASE + 2 * HOUR;
    let upcoming = BASE + DAY + 5 * HOUR;
    let activity = daily_usage(
        &[
            reading(BASE + HOUR, 80.0, Some(first)),
            reading(BASE + 3 * HOUR, 2.0, Some(first + WEEK)),
        ],
        &days(2),
        WEEK,
        Some(upcoming),
    );
    // The provider named `first`, then a reset one week later. Both `first` and the current reset
    // fall in these two days.
    assert_eq!(activity.resets, [first, upcoming]);

    // A reset past the end of the range is not drawn, and neither is the week before it when that
    // week is also outside.
    let outside = daily_usage(&[], &days(2), WEEK, Some(BASE + 5 * DAY));
    assert!(outside.resets.is_empty());
    let current = daily_usage(
        &[
            reading(BASE + HOUR, 80.0, Some(first)),
            reading(BASE + 3 * HOUR, 2.0, Some(first + WEEK)),
        ],
        &days(2),
        WEEK,
        Some(first + 60),
    );
    // The current reset is a minute after the one the provider already named.
    assert_eq!(current.resets, [first]);
}

#[test]
fn a_weekly_chart_keeps_the_latest_reset_and_the_one_week_before_it() {
    // Both fall inside the 30 days. Weeks older than that are not filled in.
    let upcoming = BASE + 20 * DAY;
    let activity = daily_usage(&[], &days(30), WEEK, Some(upcoming));
    assert_eq!(activity.resets, [upcoming - WEEK, upcoming]);
}

#[test]
fn a_weekly_chart_shows_only_the_previous_week_when_nothing_earlier_was_recorded() {
    // No stored reset times. The next reset is one day past the chart, so the only line is the
    // week before it. Nothing older is invented.
    let upcoming = BASE + 31 * DAY;
    let activity = daily_usage(&[], &days(30), WEEK, Some(upcoming));
    assert_eq!(activity.resets, [upcoming - WEEK]);
}

#[test]
fn provider_recorded_resets_stay_on_the_chart() {
    // The provider named a reset, held it, then named the next week, four times. Each of those
    // times is inside the 30 days. The fifth, the upcoming one, is past the end.
    let first = BASE + 4 * DAY;
    let second = first + WEEK;
    let third = second + WEEK;
    let fourth = third + WEEK;
    let upcoming = fourth + WEEK;
    let activity = daily_usage(
        &[
            reading(first - 2 * HOUR, 40.0, Some(first)),
            reading(first - HOUR, 40.0, Some(first + 60)),
            reading(second - HOUR, 5.0, Some(second)),
            reading(third - HOUR, 6.0, Some(third)),
            reading(fourth - HOUR, 7.0, Some(fourth)),
            reading(fourth + HOUR, 8.0, Some(upcoming)),
        ],
        &days(30),
        WEEK,
        Some(upcoming),
    );
    assert_eq!(activity.resets, [first, second, third, fourth]);
}

#[test]
fn weekly_resets_on_a_seven_day_range_show_the_previous_week() {
    // The next reset is just after these seven days, so the line is the one a week earlier.
    let upcoming_tomorrow = BASE + 7 * DAY + 2 * HOUR;
    let activity = daily_usage(&[], &days(7), WEEK, Some(upcoming_tomorrow));
    assert_eq!(activity.resets, [upcoming_tomorrow - WEEK]);
}

#[test]
fn a_usage_drop_does_not_add_a_reset_line() {
    let scheduled_upcoming = BASE + 8 * DAY + 3 * HOUR;
    let scheduled_past = scheduled_upcoming - WEEK;
    let activity = daily_usage(
        &[
            reading(BASE + DAY - 2 * HOUR, 80.0, None),
            reading(BASE + DAY - HOUR, 5.0, None),
        ],
        &days(7),
        WEEK,
        Some(scheduled_upcoming),
    );
    assert_eq!(activity.resets, [scheduled_past]);
}

#[test]
fn a_gap_in_a_sliding_reset_does_not_add_extra_lines() {
    // The first sample's advertised reset is a week later. After a long gap the provider still
    // says the reset is a week ahead. The chart keeps that latest reset and the one week before
    // it, not a line at the stale advertised time from before the gap.
    let latest = BASE + 20 * DAY + WEEK;
    let activity = daily_usage(
        &[
            reading(BASE + DAY, 0.0, Some(BASE + DAY + WEEK)),
            reading(BASE + 20 * DAY, 0.0, Some(latest)),
        ],
        &days(30),
        WEEK,
        Some(latest),
    );
    assert_eq!(activity.resets, [latest - WEEK, latest]);
}

#[test]
fn a_monthly_chart_does_not_invent_an_earlier_reset() {
    // The recorded monthly reset is after the 30 days. A line 30 days earlier would be a guess,
    // and it is more than a week before the recorded reset, so the chart stays empty.
    let upcoming = BASE + 53 * DAY + 2 * HOUR;
    let activity = daily_usage(&[], &days(30), 30 * DAY, Some(upcoming));
    assert!(activity.resets.is_empty());

    // The recorded reset itself is drawn when it falls inside the range. The month before it is not.
    let inside = BASE + 10 * DAY;
    let activity = daily_usage(&[], &days(30), 30 * DAY, Some(inside));
    assert_eq!(activity.resets, [inside]);
}

#[test]
fn readings_before_the_range_place_the_high_water_mark() {
    // Day zero is before the range: 70% was already used when the range starts.
    let starts = [BASE + DAY, BASE + 2 * DAY];
    let activity = daily_usage(
        &[
            reading(BASE + 10 * HOUR, 65.0, None),
            reading(BASE + 20 * HOUR, 70.0, None),
            reading(BASE + DAY, 69.0, None),
            reading(BASE + DAY + HOUR, 70.5, None),
        ],
        &starts,
        WEEK,
        None,
    );
    assert_eq!(percents(&activity), [Some(0.5)]);
}

#[test]
fn degenerate_boundaries_give_an_empty_answer() {
    assert!(daily_usage(&[], &[], WEEK, None).days.is_empty());
    assert!(daily_usage(&[], &[BASE], WEEK, None).days.is_empty());
}

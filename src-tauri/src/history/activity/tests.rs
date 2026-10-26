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
    assert!(activity.resets.is_empty());
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
    // The reset is placed at the reading that showed it.
    assert_eq!(activity.resets, [BASE + 3 * HOUR]);
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
    // unused. The sliding reset time moves forward on each refresh, but since the scheduled reset
    // is in the future and usage has not dropped, no resets or periods are created.
    let activity = usage(
        &[
            reading(BASE + HOUR, 0.0, Some(BASE + HOUR + WEEK)),
            reading(BASE + HOUR + 900, 0.0, Some(BASE + HOUR + 900 + WEEK)),
            reading(BASE + HOUR + 1800, 0.0, Some(BASE + HOUR + 1800 + WEEK)),
        ],
        1,
    );
    assert_eq!(percents(&activity), [Some(0.0)]);
    assert!(activity.resets.is_empty());
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
    assert!(activity.resets.is_empty());
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
    assert_eq!(activity.resets, [first, upcoming]);

    // Outside the range, or the same moment twice, they are not listed.
    let outside = daily_usage(&[], &days(2), WEEK, Some(BASE + 5 * DAY));
    assert!(outside.resets.is_empty());
    let twice = daily_usage(
        &[
            reading(BASE + HOUR, 80.0, Some(first)),
            reading(BASE + 3 * HOUR, 2.0, Some(first + WEEK)),
        ],
        &days(2),
        WEEK,
        Some(first + 60),
    );
    assert_eq!(twice.resets, [first]);
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

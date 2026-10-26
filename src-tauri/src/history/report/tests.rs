use super::*;
use crate::model::{Provider, UsageFreshness, UsageSnapshot};
use chrono::TimeZone;
use serde_json::json;

const HOUR: i64 = 3600;
const DAY: i64 = 24 * HOUR;

fn at(day: u32, hour: u32, minute: u32) -> i64 {
    Utc.with_ymd_and_hms(2026, 10, day, hour, minute, 0)
        .unwrap()
        .timestamp()
}

/// 2026-10-15 12:00 UTC.
fn now() -> i64 {
    at(15, 12, 0)
}

fn iso(t: i64) -> String {
    DateTime::<Utc>::from_timestamp(t, 0).unwrap().to_rfc3339()
}

/// The boundaries of the seven days Oct 9 to Oct 15: eight instants, the last one tomorrow's
/// midnight.
fn week() -> Vec<String> {
    (9..=16).map(|day| iso(at(day, 0, 0))).collect()
}

// ---- validation ----

fn refused(day_starts: &[String]) -> String {
    validate_day_starts(day_starts, now()).expect_err("these boundaries must be refused")
}

#[test]
fn well_formed_boundaries_are_accepted() {
    let bounds = validate_day_starts(&week(), now()).unwrap();
    assert_eq!(bounds.len(), 8);
    assert_eq!(bounds[0], at(9, 0, 0));

    // Midnights written with a zone offset (Kolkata, Kathmandu) are the same kind of instant.
    let kolkata = ["2026-10-14T00:00:00+05:30", "2026-10-15T00:00:00+05:30"];
    assert_eq!(
        validate_day_starts(&kolkata.map(String::from), now()).unwrap(),
        [at(13, 18, 30), at(14, 18, 30)]
    );
    let kathmandu = ["2026-10-14T00:00:00+05:45", "2026-10-15T00:00:00+05:45"];
    assert!(validate_day_starts(&kathmandu.map(String::from), now()).is_ok());

    // 23 and 25 hour days, as on a daylight saving change.
    let dst = [
        iso(at(9, 0, 0)),
        iso(at(10, 0, 0) - HOUR),
        iso(at(11, 0, 0)),
    ];
    assert!(validate_day_starts(&dst, now()).is_ok());
}

#[test]
fn too_few_or_too_many_boundaries_are_refused() {
    assert!(refused(&[]).contains("between 2 and 32"));
    assert!(refused(&[iso(at(15, 0, 0))]).contains("between 2 and 32"));
    let many: Vec<String> = (0..33)
        .map(|day| iso(at(15, 0, 0) - (32 - day) * DAY))
        .collect();
    assert_eq!(many.len(), 33);
    assert!(refused(&many).contains("between 2 and 32"));
    // 32 is the most: 31 days.
    assert!(validate_day_starts(&many[1..], now()).is_ok());
}

#[test]
fn boundaries_that_are_not_rfc_3339_instants_are_refused() {
    for bad in [
        "",
        "yesterday",
        "2026-10-14",
        // No zone: a local time says nothing about which instant it is.
        "2026-10-14T00:00:00",
        "2026-13-14T00:00:00Z",
        "1760400000",
    ] {
        let starts = [bad.to_string(), iso(at(15, 0, 0))];
        assert!(refused(&starts).contains("not a valid time"), "{bad:?}");
        let starts = [iso(at(14, 0, 0)), bad.to_string()];
        assert!(refused(&starts).contains("not a valid time"), "{bad:?}");
    }
    // Far longer than any instant.
    let long = format!("2026-10-14T00:00:00Z{}", " ".repeat(100));
    assert!(refused(&[long, iso(at(15, 0, 0))]).contains("not a valid time"));
}

#[test]
fn boundaries_must_strictly_increase() {
    let same = [iso(at(14, 0, 0)), iso(at(14, 0, 0))];
    assert!(refused(&same).contains("increasing"));
    let backwards = [iso(at(15, 0, 0)), iso(at(14, 0, 0))];
    assert!(refused(&backwards).contains("increasing"));
    let later_dip = [iso(at(13, 0, 0)), iso(at(14, 0, 0)), iso(at(13, 0, 0))];
    assert!(refused(&later_dip).contains("increasing"));
}

#[test]
fn days_must_last_between_22_and_26_hours() {
    let gap = |seconds: i64| [iso(at(14, 0, 0)), iso(at(14, 0, 0) + seconds)];
    assert!(refused(&gap(22 * HOUR - 1)).contains("22 and 26 hours"));
    assert!(refused(&gap(26 * HOUR + 1)).contains("22 and 26 hours"));
    assert!(refused(&gap(HOUR)).contains("22 and 26 hours"));
    assert!(refused(&gap(7 * DAY)).contains("22 and 26 hours"));
    assert!(validate_day_starts(&gap(22 * HOUR), now()).is_ok());
    assert!(validate_day_starts(&gap(26 * HOUR), now()).is_ok());
    // One bad day among good ones.
    let mut starts = week();
    starts[4] = iso(at(13, 12, 0));
    assert!(refused(&starts).contains("22 and 26 hours"));
}

#[test]
fn the_last_boundary_cannot_be_more_than_26_hours_ahead() {
    let ends_at = |last: i64| [iso(last - DAY), iso(last)];
    assert!(refused(&ends_at(now() + 26 * HOUR + 1)).contains("too far"));
    assert!(refused(&ends_at(now() + 30 * DAY)).contains("too far"));
    assert!(validate_day_starts(&ends_at(now() + 26 * HOUR), now()).is_ok());
    // Looking at the past is fine.
    assert!(validate_day_starts(&ends_at(now() - 40 * DAY), now()).is_ok());
}

// ---- the answer ----

fn weekly_window(id: &str, label: &str, used: f64, reset: Option<i64>) -> UsageWindow {
    UsageWindow {
        id: id.into(),
        label: label.into(),
        used_percent: Some(used),
        remaining_percent: Some(100.0 - used),
        resets_at: reset.map(iso),
        window_seconds: Some(WEEKLY_WINDOW_SECONDS),
        kind: Some(WindowKind::Weekly),
    }
}

fn limit_window(id: &str, kind: Option<WindowKind>, seconds: Option<u64>) -> UsageWindow {
    UsageWindow {
        id: id.into(),
        label: id.into(),
        used_percent: Some(1.0),
        remaining_percent: Some(99.0),
        resets_at: None,
        window_seconds: seconds,
        kind,
    }
}

fn account(
    id: &str,
    provider: Provider,
    windows: Option<Vec<UsageWindow>>,
    fetched_at: i64,
) -> Account {
    Account {
        id: id.into(),
        label: format!("{id} label"),
        provider,
        email: None,
        provider_account_id: None,
        chatgpt_account_id: None,
        plan: None,
        created_at: iso(fetched_at),
        updated_at: iso(fetched_at),
        last_usage: windows.map(|windows| UsageSnapshot {
            plan: None,
            email: None,
            windows,
            credits_usd: None,
            unlimited_credits: false,
            fetched_at: iso(fetched_at),
            freshness: UsageFreshness::Live,
            source: "test".into(),
        }),
        last_error: None,
        auth_required: false,
    }
}

fn app() -> (tempfile::TempDir, AppState) {
    let root = tempfile::tempdir().unwrap();
    let mut app = AppState::new(root.path().to_path_buf(), "test-token".into()).unwrap();
    // The history works from a pinned clock, not the machine's.
    app.history = HistoryStore::load_at(root.path(), now());
    (root, app)
}

fn claude_at(used: f64, reset: i64, fetched_at: i64) -> Account {
    account(
        "claude",
        Provider::Anthropic,
        Some(vec![
            limit_window("five_hour", Some(WindowKind::FiveHour), Some(18_000)),
            weekly_window("weekly", "Weekly", used, Some(reset)),
        ]),
        fetched_at,
    )
}

#[test]
fn trackers_and_untracked_accounts_follow_the_dashboard_order() {
    let (_root, app) = app();
    let reset = at(15, 20, 0);
    let accounts = [
        claude_at(40.0, reset, now()),
        account(
            "anti",
            Provider::Antigravity,
            Some(vec![
                limit_window("five_hour", Some(WindowKind::FiveHour), Some(18_000)),
                weekly_window("gemini_weekly", "Gemini 4 Argon · Weekly", 10.0, None),
                weekly_window("claude_weekly", "Claude · Weekly", 20.0, None),
            ]),
            now(),
        ),
        account(
            "studio",
            Provider::GoogleAiStudio,
            Some(vec![
                limit_window("daily", None, Some(86_400)),
                limit_window("per_minute", None, Some(60)),
            ]),
            now(),
        ),
        account(
            "free",
            Provider::Openai,
            Some(vec![limit_window(
                "monthly",
                Some(WindowKind::Monthly),
                Some(2_592_000),
            )]),
            now(),
        ),
        account(
            "mixed",
            Provider::Grok,
            Some(vec![
                limit_window("rolling", Some(WindowKind::FiveHour), Some(18_000)),
                limit_window("monthly", Some(WindowKind::Monthly), None),
                limit_window("daily", None, Some(86_400)),
                limit_window("other", None, None),
                limit_window("odd", None, Some(1234)),
            ]),
            now(),
        ),
        // Never refreshed, and refreshed with nothing: neither says anything about its limits.
        account("new", Provider::Openai, None, now()),
        account("empty", Provider::Openai, Some(vec![]), now()),
    ];
    for account in accounts {
        app.store.upsert(account).unwrap();
    }
    let order = ["free", "anti", "new", "claude", "mixed", "studio", "empty"];
    app.account_order
        .save(order.map(String::from).to_vec(), app.store.list())
        .unwrap();

    let activity = weekly_activity(&app, &week(), now()).unwrap();

    let tracked: Vec<(&str, &str)> = activity
        .trackers
        .iter()
        .map(|tracker| (tracker.account_id.as_str(), tracker.window_id.as_str()))
        .collect();
    assert_eq!(
        tracked,
        [
            ("free", "monthly"),
            ("anti", "gemini_weekly"),
            ("anti", "claude_weekly"),
            ("claude", "weekly"),
            ("mixed", "monthly"),
        ]
    );
    let kinds: Vec<WindowKind> = activity
        .trackers
        .iter()
        .map(|tracker| tracker.window_kind)
        .collect();
    assert_eq!(
        kinds,
        [
            WindowKind::Monthly,
            WindowKind::Weekly,
            WindowKind::Weekly,
            WindowKind::Weekly,
            WindowKind::Monthly,
        ]
    );
    let untracked: Vec<(&str, &[OtherLimit])> = activity
        .untracked
        .iter()
        .map(|account| (account.account_id.as_str(), account.other_limits.as_slice()))
        .collect();
    assert_eq!(
        untracked,
        [
            ("free", &[OtherLimit::Monthly][..]),
            (
                "mixed",
                &[
                    OtherLimit::FiveHour,
                    OtherLimit::Daily,
                    OtherLimit::Monthly,
                    OtherLimit::Other
                ][..]
            ),
            ("studio", &[OtherLimit::Daily, OtherLimit::PerMinute][..]),
        ]
    );

    // Accounts with only a monthly limit are listed as having no weekly limit too.
    let claude = &activity.trackers[3];
    assert_eq!(claude.window_label, "Weekly");
    assert_eq!(claude.current_used_percent, Some(40.0));
    assert_eq!(claude.resets_at, Some(iso(reset)));
    assert_eq!(claude.days.len(), 7);
    // Nothing recorded yet.
    assert!(claude.days.iter().all(|day| day.used_percent.is_none()));
    // The upcoming reset is today, so it is in the range.
    assert_eq!(claude.resets, ["2026-10-15T20:00:00Z"]);
    assert_eq!(activity.trackers[1].window_label, "Gemini 4 Argon · Weekly");
}

#[test]
fn recorded_readings_become_daily_values_in_the_response() {
    let (_root, app) = app();
    let reset = at(17, 12, 0);
    app.store
        .upsert(claude_at(14.0, reset, at(15, 10, 0)))
        .unwrap();
    app.history
        .record(&claude_at(10.0, reset, at(15, 9, 0)))
        .unwrap();
    app.history
        .record(&claude_at(14.0, reset, at(15, 10, 0)))
        .unwrap();
    // History of an account that has since been removed is not reported.
    app.history
        .record(&account(
            "ghost",
            Provider::Anthropic,
            Some(vec![weekly_window("weekly", "Weekly", 5.0, None)]),
            at(15, 9, 30),
        ))
        .unwrap();

    let activity = weekly_activity(&app, &week(), now()).unwrap();

    assert_eq!(activity.trackers.len(), 1);
    assert!(activity.untracked.is_empty());
    let value = serde_json::to_value(&activity).unwrap();
    let tracker = &value["trackers"][0];
    assert_eq!(tracker["accountId"], "claude");
    assert_eq!(tracker["windowId"], "weekly");
    assert_eq!(tracker["currentUsedPercent"], 14.0);
    assert_eq!(tracker["resetsAt"], iso(reset));
    // The weekly reset is projected across the range: Oct 17 minus 1 week is Oct 10.
    assert_eq!(tracker["resets"], json!(["2026-10-10T12:00:00Z"]));
    let days = tracker["days"].as_array().unwrap();
    assert_eq!(days.len(), 7);
    assert_eq!(days[6], json!({"usedPercent": 4.0, "quality": "measured"}));
    for day in &days[..6] {
        assert_eq!(day, &json!({"usedPercent": null, "quality": "none"}));
    }
}

fn monthly_account(used: f64, reset: i64, fetched_at: i64) -> Account {
    account(
        "free",
        Provider::Openai,
        Some(vec![UsageWindow {
            id: "monthly".into(),
            label: "Monthly".into(),
            used_percent: Some(used),
            remaining_percent: Some(100.0 - used),
            resets_at: Some(iso(reset)),
            window_seconds: None,
            kind: Some(WindowKind::Monthly),
        }]),
        fetched_at,
    )
}

#[test]
fn a_monthly_tracker_reports_its_daily_usage_and_says_it_is_monthly() {
    let (_root, app) = app();
    let reset = at(30, 0, 0);
    app.store
        .upsert(monthly_account(13.0, reset, at(15, 11, 0)))
        .unwrap();
    app.history
        .record(&monthly_account(10.0, reset, at(15, 10, 0)))
        .unwrap();
    app.history
        .record(&monthly_account(13.0, reset, at(15, 11, 0)))
        .unwrap();

    let activity = weekly_activity(&app, &week(), now()).unwrap();

    assert_eq!(activity.trackers.len(), 1);
    let tracker = &activity.trackers[0];
    assert_eq!(tracker.window_kind, WindowKind::Monthly);
    assert_eq!(tracker.days[6].used_percent, Some(3.0));
    // It is still listed as having no weekly limit, which the 7 day view shows.
    assert_eq!(activity.untracked.len(), 1);
    assert_eq!(activity.untracked[0].other_limits, [OtherLimit::Monthly]);
    let value = serde_json::to_value(tracker).unwrap();
    assert_eq!(value["windowKind"], "monthly");
}

#[test]
fn a_monthly_tracker_reads_far_enough_back_to_know_where_its_period_began() {
    let (_root, mut app) = app();
    let reset = at(30, 0, 0);
    app.store
        .upsert(monthly_account(14.0, reset, at(15, 10, 0)))
        .unwrap();
    // A reading from Oct 1, which a weekly tracker would not look back to from Oct 9.
    let early = HistoryStore::load_at(_root.path(), at(1, 0, 0));
    early
        .record(&monthly_account(10.0, reset, at(1, 12, 0)))
        .unwrap();
    drop(early);
    app.history = HistoryStore::load_at(_root.path(), now());
    app.history
        .record(&monthly_account(14.0, reset, at(15, 10, 0)))
        .unwrap();

    let activity = weekly_activity(&app, &week(), now()).unwrap();
    let days = &activity.trackers[0].days;
    // The 4% rise since Oct 1 is spread over the fourteen days between the readings, so some of it
    // lands on the days of the range, as an estimate.
    let total: f64 = days.iter().filter_map(|day| day.used_percent).sum();
    assert!(total > 0.0 && total < 4.0, "{total}");
    assert!(days
        .iter()
        .any(|day| day.quality == crate::history::activity::DayQuality::Approximate));
}

#[test]
fn a_thirty_day_range_spans_month_files() {
    let (root, mut app) = app();
    app.store
        .upsert(claude_at(30.0, at(17, 12, 0), now()))
        .unwrap();
    // History recorded in September, by a store whose clock was September's.
    let sept_20 = Utc
        .with_ymd_and_hms(2026, 9, 20, 0, 0, 0)
        .unwrap()
        .timestamp();
    let september = HistoryStore::load_at(root.path(), sept_20);
    for (hour, used) in [(1, 10.0), (2, 16.0)] {
        let reset = sept_20 + 3 * DAY;
        september
            .record(&claude_at(used, reset, sept_20 + hour * HOUR))
            .unwrap();
    }
    drop(september);
    app.history = HistoryStore::load_at(root.path(), now());

    // Sep 16 to Oct 15.
    let thirty: Vec<String> = (0..=30)
        .map(|offset| iso(at(16, 0, 0) - (30 - offset) * DAY))
        .collect();
    let activity = weekly_activity(&app, &thirty, now()).unwrap();
    let days = &activity.trackers[0].days;
    assert_eq!(days.len(), 30);
    // The readings are on Sep 20, the fifth day.
    assert_eq!(days[4].used_percent, Some(6.0));
    assert_eq!(days[3].used_percent, None);
}

#[test]
fn monthly_tracker_projects_reset_on_thirty_day_view() {
    let (_root, app) = app();
    let reset = at(30, 0, 0);
    app.store
        .upsert(monthly_account(10.0, reset, at(15, 11, 0)))
        .unwrap();

    let thirty: Vec<String> = (0..=30)
        .map(|offset| iso(at(16, 0, 0) - (30 - offset) * DAY))
        .collect();
    let activity = weekly_activity(&app, &thirty, now()).unwrap();
    let tracker = &activity.trackers[0];
    assert_eq!(tracker.resets, ["2026-09-30T00:00:00Z"]);
}

#[test]
fn unused_antigravity_tracker_projects_weekly_resets() {
    let (_root, app) = app();
    let reset = at(17, 12, 0);
    let mut account = claude_at(0.0, reset, now());
    account.provider = Provider::Antigravity;
    app.store.upsert(account).unwrap();

    let activity = weekly_activity(&app, &week(), now()).unwrap();
    let tracker = &activity.trackers[0];
    assert_eq!(tracker.resets, ["2026-10-10T12:00:00Z"]);
}

#[test]
fn a_request_with_bad_boundaries_reads_nothing() {
    let (_root, app) = app();
    app.store
        .upsert(claude_at(1.0, at(17, 0, 0), now()))
        .unwrap();
    let error = weekly_activity(&app, &["nope".to_string()], now()).unwrap_err();
    assert!(error.contains("between 2 and 32"));
    assert!(weekly_activity(&app, &[], now()).is_err());
}

#[test]
fn the_response_uses_the_names_the_page_expects() {
    let activity = WeeklyActivity {
        trackers: vec![],
        untracked: vec![UntrackedAccount {
            account_id: "a".into(),
            other_limits: vec![
                OtherLimit::FiveHour,
                OtherLimit::Daily,
                OtherLimit::PerMinute,
                OtherLimit::Monthly,
                OtherLimit::Other,
            ],
        }],
    };
    assert_eq!(
        serde_json::to_value(&activity).unwrap(),
        json!({
            "trackers": [],
            "untracked": [{
                "accountId": "a",
                "otherLimits": ["five_hour", "daily", "per_minute", "monthly", "other"]
            }]
        })
    );
}

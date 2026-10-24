use super::*;
use crate::model::{Provider, UsageSnapshot, UsageWindow, WindowKind, WEEKLY_WINDOW_SECONDS};
use chrono::TimeZone;

const HOUR: i64 = 3600;
const DAY: i64 = 24 * HOUR;

fn at(year: i32, month: u32, day: u32, hour: u32) -> i64 {
    Utc.with_ymd_and_hms(year, month, day, hour, 0, 0)
        .unwrap()
        .timestamp()
}

/// 2026-10-15 12:00 UTC.
fn now() -> i64 {
    at(2026, 10, 15, 12)
}

fn rfc3339(t: i64) -> String {
    DateTime::<Utc>::from_timestamp(t, 0).unwrap().to_rfc3339()
}

fn window(
    id: &str,
    kind: Option<WindowKind>,
    used: Option<f64>,
    reset: Option<i64>,
) -> UsageWindow {
    UsageWindow {
        id: id.into(),
        label: format!("{id} label"),
        used_percent: used,
        remaining_percent: used.map(|used| 100.0 - used),
        resets_at: reset.map(rfc3339),
        window_seconds: match kind {
            Some(WindowKind::Weekly) => Some(WEEKLY_WINDOW_SECONDS),
            Some(WindowKind::FiveHour) => Some(18_000),
            _ => None,
        },
        kind,
    }
}

fn weekly(id: &str, used: f64, reset: Option<i64>) -> UsageWindow {
    window(id, Some(WindowKind::Weekly), Some(used), reset)
}

fn account_with(
    id: &str,
    provider: Provider,
    windows: Vec<UsageWindow>,
    fetched_at: i64,
    freshness: UsageFreshness,
) -> Account {
    Account {
        id: id.into(),
        label: "A label that must not be stored".into(),
        provider,
        email: Some("person@example.com".into()),
        provider_account_id: None,
        chatgpt_account_id: None,
        plan: Some("pro".into()),
        created_at: rfc3339(fetched_at),
        updated_at: rfc3339(fetched_at),
        last_usage: Some(UsageSnapshot {
            plan: None,
            email: None,
            windows,
            credits_usd: None,
            unlimited_credits: false,
            fetched_at: rfc3339(fetched_at),
            freshness,
            source: "test".into(),
        }),
        last_error: None,
        auth_required: false,
    }
}

/// A live Claude-style account with one weekly window.
fn claude(id: &str, used: f64, reset: Option<i64>, fetched_at: i64) -> Account {
    account_with(
        id,
        Provider::Anthropic,
        vec![
            window("five_hour", Some(WindowKind::FiveHour), Some(5.0), None),
            weekly("weekly", used, reset),
        ],
        fetched_at,
        UsageFreshness::Live,
    )
}

fn history_dir(root: &Path) -> PathBuf {
    root.join(DIR_NAME)
}

fn read_json(root: &Path, name: &str) -> serde_json::Value {
    let text = fs::read_to_string(history_dir(root).join(name)).unwrap();
    serde_json::from_str(&text).unwrap()
}

fn key(account: &str, window: &str) -> String {
    tracker_key(account, window)
}

fn stored(store: &HistoryStore, account: &str, window: &str) -> Vec<Reading> {
    store
        .readings(&[key(account, window)], 0)
        .remove(&key(account, window))
        .unwrap_or_default()
}

fn file_names(root: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(history_dir(root))
        .unwrap()
        .flatten()
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

#[test]
fn the_first_reading_of_a_tracker_is_stored_with_its_reset_time() {
    let root = tempfile::tempdir().unwrap();
    let store = HistoryStore::load_at(root.path(), now());
    let reset = now() + 3 * DAY;
    store
        .record(&claude("acc", 12.345, Some(reset), now()))
        .unwrap();

    let json = read_json(root.path(), "2026-10.json");
    assert_eq!(json["version"], 1);
    assert_eq!(
        json["trackers"]["acc|weekly"][0],
        serde_json::json!([now(), 12.35, reset])
    );
    assert_eq!(stored(&store, "acc", "weekly").len(), 1);
}

#[test]
fn files_are_compact_and_hold_no_labels_emails_or_plans() {
    let root = tempfile::tempdir().unwrap();
    let store = HistoryStore::load_at(root.path(), now());
    store.record(&claude("acc", 10.0, None, now())).unwrap();

    let text = fs::read_to_string(history_dir(root.path()).join("2026-10.json")).unwrap();
    assert!(!text.contains('\n') && !text.contains(' '), "{text}");
    assert_eq!(
        text,
        format!(
            r#"{{"version":1,"trackers":{{"acc|weekly":[[{},10.0,null]]}}}}"#,
            now()
        )
    );
    for secret in ["label", "person@example.com", "pro"] {
        assert!(!text.contains(secret), "{text}");
    }
}

#[test]
fn only_changes_and_hourly_heartbeats_are_written() {
    let root = tempfile::tempdir().unwrap();
    let store = HistoryStore::load_at(root.path(), now());
    let reset = now() + 3 * DAY;
    let record = |used: f64, reset: Option<i64>, minutes: i64| {
        store
            .record(&claude("acc", used, reset, now() + minutes * 60))
            .unwrap();
        stored(&store, "acc", "weekly").len()
    };

    assert_eq!(record(20.0, Some(reset), 0), 1, "no previous reading");
    assert_eq!(record(20.0, Some(reset), 10), 1, "nothing changed");
    assert_eq!(
        record(20.01, Some(reset), 20),
        1,
        "0.01 is not more than 0.01"
    );
    assert_eq!(record(20.0, Some(reset), 25), 1, "back within rounding");
    assert_eq!(record(20.5, Some(reset), 30), 2, "the percent moved");
    assert_eq!(
        record(20.5, Some(reset + 3600), 35),
        3,
        "the reset time moved"
    );
    assert_eq!(
        record(20.5, Some(reset + 3600), 94),
        3,
        "59 minutes after the last"
    );
    assert_eq!(record(20.5, Some(reset + 3600), 95), 4, "the heartbeat");
    assert_eq!(record(20.5, Some(reset + 3600), 100), 4);

    let readings = stored(&store, "acc", "weekly");
    let times: Vec<i64> = readings.iter().map(|reading| reading.t - now()).collect();
    assert_eq!(times, [0, 30 * 60, 35 * 60, 95 * 60]);
}

#[test]
fn a_reading_that_is_not_newer_than_the_last_is_never_stored() {
    let root = tempfile::tempdir().unwrap();
    let store = HistoryStore::load_at(root.path(), now());
    store.record(&claude("acc", 10.0, None, now())).unwrap();
    // The clock stepped back, or two refreshes finished in the same second.
    store
        .record(&claude("acc", 50.0, None, now() - 60))
        .unwrap();
    store.record(&claude("acc", 50.0, None, now())).unwrap();
    assert_eq!(stored(&store, "acc", "weekly").len(), 1);
}

#[test]
fn only_live_results_with_a_used_percent_are_recorded() {
    let root = tempfile::tempdir().unwrap();
    let store = HistoryStore::load_at(root.path(), now());
    for freshness in [
        UsageFreshness::Stale,
        UsageFreshness::Unavailable,
        UsageFreshness::AuthRequired,
    ] {
        let cached = account_with(
            "acc",
            Provider::Anthropic,
            vec![weekly("weekly", 30.0, None)],
            now(),
            freshness,
        );
        store.record(&cached).unwrap();
    }
    let unknown = account_with(
        "acc",
        Provider::Anthropic,
        vec![window("weekly", Some(WindowKind::Weekly), None, None)],
        now(),
        UsageFreshness::Live,
    );
    store.record(&unknown).unwrap();
    let not_a_number = account_with(
        "acc",
        Provider::Anthropic,
        vec![weekly("weekly", f64::NAN, None)],
        now(),
        UsageFreshness::Live,
    );
    store.record(&not_a_number).unwrap();

    assert!(stored(&store, "acc", "weekly").is_empty());
    assert!(!history_dir(root.path()).join("2026-10.json").exists());
}

#[test]
fn accounts_without_a_weekly_window_produce_no_readings() {
    let root = tempfile::tempdir().unwrap();
    let store = HistoryStore::load_at(root.path(), now());
    let studio = account_with(
        "studio",
        Provider::GoogleAiStudio,
        vec![
            window("daily", None, Some(10.0), None),
            window("per_minute", None, Some(1.0), None),
        ],
        now(),
        UsageFreshness::Live,
    );
    let five_hour_only = account_with(
        "short",
        Provider::Openai,
        vec![window(
            "five_hour",
            Some(WindowKind::FiveHour),
            Some(40.0),
            None,
        )],
        now(),
        UsageFreshness::Live,
    );
    let never_refreshed = Account {
        last_usage: None,
        ..claude("never", 1.0, None, now())
    };
    for account in [&studio, &five_hour_only, &never_refreshed] {
        store.record(account).unwrap();
    }
    assert!(!history_dir(root.path()).join("2026-10.json").exists());
}

#[test]
fn an_account_with_no_weekly_window_tracks_its_first_monthly_one() {
    let names = |account: &Account| -> Vec<String> {
        tracker_windows(account)
            .iter()
            .map(|window| window.id.clone())
            .collect()
    };
    let monthly = |id: &str| window(id, Some(WindowKind::Monthly), Some(40.0), None);
    let free = account_with(
        "free",
        Provider::Openai,
        vec![
            window("five_hour", Some(WindowKind::FiveHour), Some(1.0), None),
            monthly("monthly"),
            monthly("other_monthly"),
            monthly("monthly"),
        ],
        now(),
        UsageFreshness::Live,
    );
    assert_eq!(names(&free), ["monthly"]);

    // A weekly limit wins: the monthly one is not tracked beside it.
    let both = account_with(
        "both",
        Provider::Anthropic,
        vec![monthly("monthly"), weekly("weekly", 5.0, None)],
        now(),
        UsageFreshness::Live,
    );
    assert_eq!(names(&both), ["weekly"]);

    // Antigravity falls back the same way when it has no weekly window at all.
    let anti = account_with(
        "anti",
        Provider::Antigravity,
        vec![monthly("monthly")],
        now(),
        UsageFreshness::Live,
    );
    assert_eq!(names(&anti), ["monthly"]);

    let root = tempfile::tempdir().unwrap();
    let store = HistoryStore::load_at(root.path(), now());
    store.record(&free).unwrap();
    assert_eq!(stored(&store, "free", "monthly").len(), 1);
    assert!(stored(&store, "free", "other_monthly").is_empty());
}

#[test]
fn antigravity_tracks_every_weekly_window_and_other_providers_only_the_first() {
    let weekly_windows = || {
        vec![
            window("five_hour", Some(WindowKind::FiveHour), Some(1.0), None),
            weekly("gemini_weekly", 10.0, None),
            weekly("claude_weekly", 20.0, None),
            weekly("gemini_weekly", 99.0, None),
        ]
    };
    let antigravity = account_with(
        "anti",
        Provider::Antigravity,
        weekly_windows(),
        now(),
        UsageFreshness::Live,
    );
    let other = account_with(
        "other",
        Provider::Grok,
        weekly_windows(),
        now(),
        UsageFreshness::Live,
    );
    let names = |account: &Account| -> Vec<String> {
        tracker_windows(account)
            .iter()
            .map(|window| window.id.clone())
            .collect()
    };
    assert_eq!(names(&antigravity), ["gemini_weekly", "claude_weekly"]);
    assert_eq!(names(&other), ["gemini_weekly"]);

    let root = tempfile::tempdir().unwrap();
    let store = HistoryStore::load_at(root.path(), now());
    store.record(&antigravity).unwrap();
    store.record(&other).unwrap();
    let json = read_json(root.path(), "2026-10.json");
    let mut keys: Vec<&String> = json["trackers"].as_object().unwrap().keys().collect();
    keys.sort();
    assert_eq!(
        keys,
        [
            "anti|claude_weekly",
            "anti|gemini_weekly",
            "other|gemini_weekly"
        ]
    );
    // The repeated id keeps its first reading.
    assert_eq!(stored(&store, "anti", "gemini_weekly")[0].u, 10.0);
}

#[test]
fn readings_survive_a_restart() {
    let root = tempfile::tempdir().unwrap();
    {
        let store = HistoryStore::load_at(root.path(), now());
        store.record(&claude("acc", 10.0, None, now())).unwrap();
        store
            .record(&claude("acc", 15.0, None, now() + HOUR / 2))
            .unwrap();
    }
    let reopened = HistoryStore::load_at(root.path(), now() + HOUR);
    let readings = stored(&reopened, "acc", "weekly");
    assert_eq!(readings.len(), 2);
    assert_eq!(readings[1].u, 15.0);
    // The reopened store also knows what the last reading was.
    reopened
        .record(&claude("acc", 15.0, None, now() + HOUR))
        .unwrap();
    assert_eq!(stored(&reopened, "acc", "weekly").len(), 2);
}

#[test]
fn a_new_month_starts_a_new_file_and_remembers_the_last_reading() {
    let root = tempfile::tempdir().unwrap();
    let store = HistoryStore::load_at(root.path(), at(2026, 10, 31, 22));
    store
        .record(&claude("acc", 10.0, None, at(2026, 10, 31, 23) + 1200))
        .unwrap();
    // Fifty minutes later it is November and nothing has changed, so nothing is written.
    store
        .record(&claude("acc", 10.0, None, at(2026, 11, 1, 0) + 600))
        .unwrap();
    assert_eq!(file_names(root.path()), ["2026-10.json"]);

    store
        .record(&claude("acc", 11.0, None, at(2026, 11, 1, 1)))
        .unwrap();
    assert_eq!(file_names(root.path()), ["2026-10.json", "2026-11.json"]);
    assert_eq!(
        read_json(root.path(), "2026-11.json")["trackers"]["acc|weekly"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(stored(&store, "acc", "weekly").len(), 2);
}

#[test]
fn only_the_current_and_previous_month_stay_in_memory() {
    let root = tempfile::tempdir().unwrap();
    let store = HistoryStore::load_at(root.path(), at(2026, 8, 10, 0));
    for (month, day) in [(8, 10), (9, 10), (10, 10)] {
        store
            .record(&claude(
                "acc",
                f64::from(month),
                None,
                at(2026, month, day, 6),
            ))
            .unwrap();
    }
    let held: Vec<MonthKey> = store.inner.lock().months.keys().copied().collect();
    assert_eq!(
        held,
        [
            MonthKey {
                year: 2026,
                month: 9
            },
            MonthKey {
                year: 2026,
                month: 10
            }
        ]
    );
    // A long range still sees all three, reading the oldest from disk without keeping it.
    assert_eq!(stored(&store, "acc", "weekly").len(), 3);
    assert_eq!(store.inner.lock().months.len(), 2);

    let recent = store
        .readings(&[key("acc", "weekly")], at(2026, 9, 1, 0))
        .remove(&key("acc", "weekly"))
        .unwrap();
    assert_eq!(recent.len(), 2);
}

#[test]
fn files_older_than_thirteen_months_are_deleted_at_startup() {
    let root = tempfile::tempdir().unwrap();
    let dir = history_dir(root.path());
    fs::create_dir_all(&dir).unwrap();
    for name in [
        "2025-07.json",
        "2025-08.json",
        "2025-09.json",
        "2026-10.json",
        "notes.txt",
    ] {
        fs::write(dir.join(name), r#"{"version":1,"trackers":{}}"#).unwrap();
    }
    let _store = HistoryStore::load_at(root.path(), now());
    // October 2026 minus 13 months is September 2025, which is kept.
    assert_eq!(
        file_names(root.path()),
        ["2025-09.json", "2026-10.json", "notes.txt"]
    );
}

#[test]
fn files_older_than_thirteen_months_are_deleted_at_a_month_rollover() {
    let root = tempfile::tempdir().unwrap();
    let store = HistoryStore::load_at(root.path(), now());
    let dir = history_dir(root.path());
    fs::write(dir.join("2025-09.json"), r#"{"version":1,"trackers":{}}"#).unwrap();
    store.record(&claude("acc", 10.0, None, now())).unwrap();
    assert!(dir.join("2025-09.json").exists(), "still within 13 months");

    store
        .record(&claude("acc", 20.0, None, at(2026, 11, 2, 0)))
        .unwrap();
    assert_eq!(file_names(root.path()), ["2026-10.json", "2026-11.json"]);
}

#[test]
fn an_unreadable_file_is_set_aside_and_loading_continues() {
    let root = tempfile::tempdir().unwrap();
    let dir = history_dir(root.path());
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("2026-10.json"), "{not json").unwrap();
    fs::write(dir.join("2026-09.json"), r#"{"version":9,"trackers":{}}"#).unwrap();

    let store = HistoryStore::load_at(root.path(), now());
    assert_eq!(
        file_names(root.path()),
        ["2026-09.json.invalid", "2026-10.json.invalid"]
    );
    assert_eq!(
        fs::read_to_string(dir.join("2026-10.json.invalid")).unwrap(),
        "{not json"
    );

    // The month starts empty and works.
    store.record(&claude("acc", 10.0, None, now())).unwrap();
    assert_eq!(stored(&store, "acc", "weekly").len(), 1);
    assert!(dir.join("2026-10.json").exists());
}

#[test]
fn a_file_that_is_too_large_is_set_aside() {
    let root = tempfile::tempdir().unwrap();
    let dir = history_dir(root.path());
    fs::create_dir_all(&dir).unwrap();
    let path = dir.join("2026-10.json");
    let file = fs::File::create(&path).unwrap();
    file.set_len(MAX_FILE_BYTES + 1).unwrap();
    drop(file);

    let _store = HistoryStore::load_at(root.path(), now());
    assert_eq!(file_names(root.path()), ["2026-10.json.invalid"]);
}

#[test]
fn readings_that_cannot_be_right_are_dropped_and_the_rest_sorted() {
    let root = tempfile::tempdir().unwrap();
    let dir = history_dir(root.path());
    fs::create_dir_all(&dir).unwrap();
    let t = now();
    fs::write(
        dir.join("2026-10.json"),
        format!(
            r#"{{"version":1,"trackers":{{
                "acc|weekly":[[{b},20.0,null],[{a},10.0,null],[{a},11.0,null],[0,5.0,null],[{c},150.0,null],[{c},-3.0,null]],
                "gone|weekly":[]
            }}}}"#,
            a = t,
            b = t + 60,
            c = t + 120,
        ),
    )
    .unwrap();
    let store = HistoryStore::load_at(root.path(), t);
    let readings = stored(&store, "acc", "weekly");
    assert_eq!(
        readings.iter().map(|r| (r.t - t, r.u)).collect::<Vec<_>>(),
        [(0, 10.0), (60, 20.0)]
    );
    assert!(!store.inner.lock().months[&MonthKey {
        year: 2026,
        month: 10
    }]
        .trackers
        .contains_key("gone|weekly"));
}

#[cfg(unix)]
#[test]
fn the_folder_and_its_files_are_owner_only() {
    use std::os::unix::fs::PermissionsExt;
    let root = tempfile::tempdir().unwrap();
    let store = HistoryStore::load_at(root.path(), now());
    store.record(&claude("acc", 10.0, None, now())).unwrap();
    let mode = |path: PathBuf| fs::metadata(path).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode(history_dir(root.path())), 0o700);
    assert_eq!(mode(history_dir(root.path()).join("2026-10.json")), 0o600);
}

#[test]
fn removing_an_account_clears_it_from_every_month_and_leaves_the_others() {
    let root = tempfile::tempdir().unwrap();
    let store = HistoryStore::load_at(root.path(), at(2026, 8, 10, 0));
    for (month, day) in [(8, 10), (9, 10), (10, 10)] {
        let t = at(2026, month, day, 6);
        store.record(&claude("gone", 10.0, None, t)).unwrap();
        store.record(&claude("kept", 10.0, None, t)).unwrap();
    }
    // The oldest month is only on disk, and "gone" is the only account in this file.
    fs::write(
        history_dir(root.path()).join("2026-05.json"),
        format!(
            r#"{{"version":1,"trackers":{{"gone|weekly":[[{},5.0,null]]}}}}"#,
            at(2026, 5, 5, 0)
        ),
    )
    .unwrap();

    store.remove_account("gone").unwrap();

    assert_eq!(
        file_names(root.path()),
        ["2026-08.json", "2026-09.json", "2026-10.json"]
    );
    assert!(stored(&store, "gone", "weekly").is_empty());
    assert_eq!(stored(&store, "kept", "weekly").len(), 3);
    for name in ["2026-08.json", "2026-09.json", "2026-10.json"] {
        let json = read_json(root.path(), name);
        let keys: Vec<&String> = json["trackers"].as_object().unwrap().keys().collect();
        assert_eq!(keys, ["kept|weekly"], "{name}");
    }
    // An id that merely starts with the removed one is not removed with it.
    store.record(&claude("gone2", 1.0, None, now())).unwrap();
    store.remove_account("gone").unwrap();
    assert_eq!(stored(&store, "gone2", "weekly").len(), 1);
}

#[test]
fn clearing_deletes_every_file_and_forgets_the_readings() {
    let root = tempfile::tempdir().unwrap();
    let store = HistoryStore::load_at(root.path(), now());
    store.record(&claude("acc", 10.0, None, now())).unwrap();
    let dir = history_dir(root.path());
    fs::write(dir.join("2026-03.json.invalid"), "x").unwrap();
    fs::write(dir.join("2026-02.json"), r#"{"version":1,"trackers":{}}"#).unwrap();

    store.clear().unwrap();

    assert!(file_names(root.path()).is_empty());
    assert!(stored(&store, "acc", "weekly").is_empty());
    // Recording starts fresh.
    store
        .record(&claude("acc", 30.0, None, now() + HOUR))
        .unwrap();
    let readings = stored(&store, "acc", "weekly");
    assert_eq!(readings.len(), 1);
    assert_eq!(readings[0].u, 30.0);
}

#[test]
fn a_failed_write_is_kept_and_retried_by_the_next_reading() {
    let root = tempfile::tempdir().unwrap();
    let store = HistoryStore::load_at(root.path(), now());
    let dir = history_dir(root.path());
    fs::remove_dir_all(&dir).unwrap();
    // A file where the folder belongs makes every write fail.
    fs::write(&dir, "in the way").unwrap();

    assert!(store.record(&claude("acc", 10.0, None, now())).is_err());
    assert_eq!(stored(&store, "acc", "weekly").len(), 1, "kept in memory");

    fs::remove_file(&dir).unwrap();
    store
        .record(&claude("acc", 12.0, None, now() + HOUR / 2))
        .unwrap();
    let json = read_json(root.path(), "2026-10.json");
    assert_eq!(json["trackers"]["acc|weekly"].as_array().unwrap().len(), 2);
}

#[test]
fn a_folder_that_cannot_be_created_does_not_stop_loading() {
    let root = tempfile::tempdir().unwrap();
    fs::write(history_dir(root.path()), "in the way").unwrap();
    let store = HistoryStore::load_at(root.path(), now());
    assert!(store.record(&claude("acc", 10.0, None, now())).is_err());
    assert_eq!(stored(&store, "acc", "weekly").len(), 1, "kept in memory");
}

#[test]
fn month_file_names_are_read_strictly() {
    let month = |name: &str| MonthKey::from_file_name(name);
    assert_eq!(
        month("2026-10.json"),
        Some(MonthKey {
            year: 2026,
            month: 10
        })
    );
    for name in [
        "2026-13.json",
        "2026-00.json",
        "2026-1.json",
        "26-10.json",
        "2026-10.json.invalid",
        "2026-10.json.tmp",
        "x2026-10.json",
        "2026-10",
        "+026-10.json",
        "",
    ] {
        assert_eq!(month(name), None, "{name}");
    }
    assert_eq!(
        MonthKey {
            year: 2026,
            month: 1
        }
        .previous(),
        MonthKey {
            year: 2025,
            month: 12
        }
    );
    assert_eq!(
        MonthKey {
            year: 2026,
            month: 10
        }
        .minus_months(13),
        MonthKey {
            year: 2025,
            month: 9
        }
    );
}

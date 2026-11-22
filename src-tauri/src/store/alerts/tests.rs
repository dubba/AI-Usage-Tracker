use super::*;
use crate::model::{now_rfc3339, Provider, UsageSnapshot, UsageWindow};

fn account_with_weekly(remaining: f64) -> Account {
    let now = now_rfc3339();
    Account {
        id: "account-1".into(),
        label: "Test account".into(),
        provider: Provider::Openai,
        created_at: now.clone(),
        updated_at: now.clone(),
        last_usage: Some(UsageSnapshot {
            windows: vec![UsageWindow {
                id: "weekly".into(),
                label: "Weekly".into(),
                used_percent: Some(100.0 - remaining),
                remaining_percent: Some(remaining),
                resets_at: Some("2026-07-20T00:00:00Z".into()),
                window_seconds: Some(604_800),
                kind: None,
            }
            .classified()],
            fetched_at: now,
            ..UsageSnapshot::for_test()
        }),
        ..Account::for_test()
    }
}

#[test]
fn notifies_once_per_period_below_threshold() {
    let directory = tempfile::tempdir().unwrap();
    let store = AlertStore::load(directory.path()).unwrap();
    store
        .save(
            "account-1",
            vec![UsageAlertSetting {
                window_id: "weekly".into(),
                enabled: true,
                threshold_percent: 20,
            }],
        )
        .unwrap();
    let account = account_with_weekly(18.0);
    assert_eq!(store.evaluate(&account).unwrap().len(), 1);
    assert!(store.evaluate(&account).unwrap().is_empty());
}

#[test]
fn rejects_unknown_windows() {
    let directory = tempfile::tempdir().unwrap();
    let store = AlertStore::load(directory.path()).unwrap();
    assert!(store
        .save(
            "account-1",
            vec![UsageAlertSetting {
                window_id: "daily".into(),
                enabled: true,
                threshold_percent: 20,
            }],
        )
        .is_err());
}

#[test]
fn antigravity_multi_window_evaluation_triggers_alert_for_depleted_window() {
    let directory = tempfile::tempdir().unwrap();
    let store = AlertStore::load(directory.path()).unwrap();
    store
        .save(
            "antigravity-1",
            vec![
                UsageAlertSetting {
                    window_id: "five_hour".into(),
                    enabled: true,
                    threshold_percent: 20,
                },
                UsageAlertSetting {
                    window_id: "weekly".into(),
                    enabled: true,
                    threshold_percent: 20,
                },
            ],
        )
        .unwrap();

    let now = now_rfc3339();
    let mut account = Account {
        id: "antigravity-1".into(),
        label: "Work Antigravity".into(),
        provider: Provider::Antigravity,
        created_at: now.clone(),
        updated_at: now.clone(),
        last_usage: Some(UsageSnapshot {
            windows: vec![
                UsageWindow {
                    id: "five_hour_1".into(),
                    label: "Claude models · 5-Hour Limit".into(),
                    used_percent: Some(5.0),
                    remaining_percent: Some(95.0),
                    resets_at: Some("2026-09-05T06:00:00Z".into()),
                    window_seconds: Some(18_000),
                    kind: None,
                }
                .classified(),
                UsageWindow {
                    id: "weekly_1".into(),
                    label: "Claude models · Weekly Limit".into(),
                    used_percent: Some(10.0),
                    remaining_percent: Some(90.0),
                    resets_at: Some("2026-09-12T00:00:00Z".into()),
                    window_seconds: Some(604_800),
                    kind: None,
                }
                .classified(),
                UsageWindow {
                    id: "five_hour_2".into(),
                    label: "Gemini models · 5-Hour Limit".into(),
                    used_percent: Some(85.0),
                    remaining_percent: Some(15.0),
                    resets_at: Some("2026-09-05T07:00:00Z".into()),
                    window_seconds: Some(18_000),
                    kind: None,
                }
                .classified(),
                UsageWindow {
                    id: "weekly_2".into(),
                    label: "Gemini models · Weekly Limit".into(),
                    used_percent: Some(92.0),
                    remaining_percent: Some(8.0),
                    resets_at: Some("2026-09-12T00:00:00Z".into()),
                    window_seconds: Some(604_800),
                    kind: None,
                }
                .classified(),
            ],
            fetched_at: now.clone(),
            source: "antigravity".into(),
            ..UsageSnapshot::for_test()
        }),
        ..Account::for_test()
    };

    // First evaluation: Gemini 5h and Gemini weekly are below 20%
    let alerts = store.evaluate(&account).unwrap();
    assert_eq!(alerts.len(), 2);
    assert!(alerts
        .iter()
        .any(|a| a.window_label == "5 hour (Gemini models)" && a.remaining_percent == 15));
    assert!(alerts
        .iter()
        .any(|a| a.window_label == "Weekly (Gemini models)" && a.remaining_percent == 8));

    // Second evaluation with identical usage: no duplicate alerts
    let alerts_second = store.evaluate(&account).unwrap();
    assert!(alerts_second.is_empty());

    // Now Claude 5h also drops below threshold (to 10%)
    if let Some(usage) = account.last_usage.as_mut() {
        usage.windows[0].remaining_percent = Some(10.0);
        usage.windows[0].used_percent = Some(90.0);
    }

    let alerts_third = store.evaluate(&account).unwrap();
    assert_eq!(alerts_third.len(), 1);
    assert_eq!(alerts_third[0].window_label, "5 hour (Claude models)");
    assert_eq!(alerts_third[0].remaining_percent, 10);
}

#[test]
fn thirty_day_alert_triggers_and_formats_label() {
    let directory = tempfile::tempdir().unwrap();
    let store = AlertStore::load(directory.path()).unwrap();
    store
        .save(
            "openai-1",
            vec![UsageAlertSetting {
                window_id: "monthly".into(),
                enabled: true,
                threshold_percent: 20,
            }],
        )
        .unwrap();

    let now = now_rfc3339();
    let account = Account {
        id: "openai-1".into(),
        label: "Free ChatGPT".into(),
        provider: Provider::Openai,
        created_at: now.clone(),
        updated_at: now.clone(),
        last_usage: Some(UsageSnapshot {
            windows: vec![UsageWindow {
                id: "monthly".into(),
                label: "GPT · 30-Day Limit".into(),
                used_percent: Some(85.0),
                remaining_percent: Some(15.0),
                resets_at: Some("2026-10-01T00:00:00Z".into()),
                window_seconds: Some(2_592_000),
                kind: None,
            }
            .classified()],
            fetched_at: now,
            source: "wham".into(),
            ..UsageSnapshot::for_test()
        }),
        ..Account::for_test()
    };

    let alerts = store.evaluate(&account).unwrap();
    assert_eq!(alerts.len(), 1);
    assert_eq!(alerts[0].window_label, "30-day (GPT)");
    assert_eq!(alerts[0].remaining_percent, 15);
    assert_eq!(alerts[0].threshold_percent, 20);

    // Deduplication
    assert!(store.evaluate(&account).unwrap().is_empty());
}

#[test]
fn a_window_is_alerted_under_its_kind() {
    let weekly = UsageWindow {
        id: "weekly_2".into(),
        label: "Gemini models · 7-Day Limit".into(),
        used_percent: None,
        remaining_percent: None,
        resets_at: None,
        window_seconds: None,
        kind: None,
    };
    assert_eq!(
        usage_core::alerts::window_id(&weekly),
        None,
        "not classified yet"
    );
    assert_eq!(
        usage_core::alerts::window_id(&weekly.classified()),
        Some("weekly")
    );
}

#[test]
fn window_without_reset_time_notifies_once_and_does_not_repeat_on_subsequent_refreshes() {
    let directory = tempfile::tempdir().unwrap();
    let store = AlertStore::load(directory.path()).unwrap();
    store
        .save(
            "account-no-reset",
            vec![UsageAlertSetting {
                window_id: "five_hour".into(),
                enabled: true,
                threshold_percent: 20,
            }],
        )
        .unwrap();

    let mut account = Account {
        id: "account-no-reset".into(),
        label: "Account without reset".into(),
        provider: Provider::Openai,
        created_at: "2026-11-01T00:00:00Z".into(),
        updated_at: "2026-11-01T00:00:00Z".into(),
        last_usage: Some(UsageSnapshot {
            windows: vec![UsageWindow {
                id: "five_hour".into(),
                label: "5-Hour Limit".into(),
                used_percent: Some(85.0),
                remaining_percent: Some(15.0),
                resets_at: None,
                window_seconds: Some(18_000),
                kind: None,
            }
            .classified()],
            fetched_at: "2026-11-01T12:00:00Z".into(),
            ..UsageSnapshot::for_test()
        }),
        ..Account::for_test()
    };

    // First evaluation: remaining is 15% <= 20% -> triggers alert
    let alerts = store.evaluate(&account).unwrap();
    assert_eq!(alerts.len(), 1);
    assert_eq!(alerts[0].remaining_percent, 15);

    // Second evaluation with a new fetched_at (simulating periodic refresh) but same usage:
    // Should NOT re-trigger because window has already notified for this threshold.
    if let Some(usage) = account.last_usage.as_mut() {
        usage.fetched_at = "2026-11-01T12:05:00Z".into();
    }
    assert!(store.evaluate(&account).unwrap().is_empty());

    // Third evaluation: usage recovers above threshold (80% remaining)
    if let Some(usage) = account.last_usage.as_mut() {
        usage.windows[0].remaining_percent = Some(80.0);
        usage.windows[0].used_percent = Some(20.0);
        usage.fetched_at = "2026-11-01T12:10:00Z".into();
    }
    assert!(store.evaluate(&account).unwrap().is_empty());

    // Fourth evaluation: usage drops below threshold again -> triggers again
    if let Some(usage) = account.last_usage.as_mut() {
        usage.windows[0].remaining_percent = Some(10.0);
        usage.windows[0].used_percent = Some(90.0);
        usage.fetched_at = "2026-11-01T12:15:00Z".into();
    }
    let alerts_recovered = store.evaluate(&account).unwrap();
    assert_eq!(alerts_recovered.len(), 1);
    assert_eq!(alerts_recovered[0].remaining_percent, 10);
}

#[test]
fn persists_milestone_alerts_across_reload_and_ignores_reset_jitter() {
    let directory = tempfile::tempdir().unwrap();
    let store = AlertStore::load(directory.path()).unwrap();
    store
        .save(
            "account-1",
            vec![UsageAlertSetting {
                window_id: "weekly".into(),
                enabled: true,
                threshold_percent: 20,
            }],
        )
        .unwrap();

    let mut account = account_with_weekly(19.0);
    assert_eq!(store.evaluate(&account).unwrap().len(), 1);

    // Reload from disk and jitter resets_at while above 15%: no alert.
    let reloaded = AlertStore::load(directory.path()).unwrap();
    if let Some(usage) = account.last_usage.as_mut() {
        usage.windows[0].remaining_percent = Some(16.0);
        usage.windows[0].used_percent = Some(84.0);
        usage.windows[0].resets_at = Some("2026-07-20T00:00:08Z".into());
    }
    assert!(reloaded.evaluate(&account).unwrap().is_empty());

    // Reaching 15%, 5%, and 0% each emit one alert; 11%, 10%, 1% do not.
    for (pct, reset, expected) in [
        (15.0, "2026-07-20T00:00:12Z", 1),
        (11.0, "2026-07-20T00:00:15Z", 0),
        (10.0, "2026-07-20T00:00:18Z", 0),
        (5.0, "2026-07-20T00:00:22Z", 1),
        (1.0, "2026-07-20T00:00:25Z", 0),
        (0.0, "2026-07-20T00:00:30Z", 1),
        (0.0, "2026-07-20T00:00:35Z", 0),
    ] {
        if let Some(usage) = account.last_usage.as_mut() {
            usage.windows[0].remaining_percent = Some(pct);
            usage.windows[0].used_percent = Some(100.0 - pct);
            usage.windows[0].resets_at = Some(reset.into());
        }
        assert_eq!(
            reloaded.evaluate(&account).unwrap().len(),
            expected,
            "unexpected alert count at {pct}%"
        );
    }
}

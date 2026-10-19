use super::*;
use crate::model::{now_rfc3339, Provider, UsageFreshness, UsageSnapshot};

fn account_with_weekly(remaining: f64) -> Account {
    let now = now_rfc3339();
    Account {
        id: "account-1".into(),
        label: "Test account".into(),
        provider: Provider::Openai,
        email: None,
        provider_account_id: None,
        chatgpt_account_id: None,
        plan: None,
        created_at: now.clone(),
        updated_at: now.clone(),
        last_usage: Some(UsageSnapshot {
            plan: None,
            email: None,
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
            credits_usd: None,
            unlimited_credits: false,
            fetched_at: now,
            freshness: UsageFreshness::Live,
            source: "test".into(),
        }),
        last_error: None,
        auth_required: false,
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
        email: None,
        provider_account_id: None,
        chatgpt_account_id: None,
        plan: None,
        created_at: now.clone(),
        updated_at: now.clone(),
        last_usage: Some(UsageSnapshot {
            plan: None,
            email: None,
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
            credits_usd: None,
            unlimited_credits: false,
            fetched_at: now.clone(),
            freshness: UsageFreshness::Live,
            source: "antigravity".into(),
        }),
        last_error: None,
        auth_required: false,
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
        email: None,
        provider_account_id: None,
        chatgpt_account_id: None,
        plan: None,
        created_at: now.clone(),
        updated_at: now.clone(),
        last_usage: Some(UsageSnapshot {
            plan: None,
            email: None,
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
            credits_usd: None,
            unlimited_credits: false,
            fetched_at: now,
            freshness: UsageFreshness::Live,
            source: "wham".into(),
        }),
        last_error: None,
        auth_required: false,
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
    assert_eq!(canonical_window_id(&weekly), None, "not classified yet");
    assert_eq!(canonical_window_id(&weekly.classified()), Some("weekly"));
}

use super::*;
use crate::model::{now_rfc3339, Provider, UsageSnapshot};

fn window(id: &str, label: &str, remaining: f64, resets_at: Option<&str>) -> UsageWindow {
    UsageWindow {
        id: id.into(),
        label: label.into(),
        used_percent: Some(100.0 - remaining),
        remaining_percent: Some(remaining),
        resets_at: resets_at.map(Into::into),
        window_seconds: None,
        kind: None,
    }
    .classified()
}

fn account(provider: Provider, plan: Option<&str>, windows: Option<Vec<UsageWindow>>) -> Account {
    Account {
        id: "account".into(),
        label: "Account".into(),
        provider,
        plan: plan.map(Into::into),
        created_at: now_rfc3339(),
        updated_at: now_rfc3339(),
        last_usage: windows.map(|windows| UsageSnapshot {
            windows,
            fetched_at: now_rfc3339(),
            ..UsageSnapshot::for_test()
        }),
        ..Account::for_test()
    }
}

#[test]
fn the_chatgpt_plan_rule() {
    let plan = |provider, plan| chatgpt_plan(&account(provider, plan, None));
    assert_eq!(
        plan(Provider::Openai, Some("free")),
        Some(ChatgptPlan::Free)
    );
    assert_eq!(
        plan(Provider::Openai, Some("Free-Tier")),
        Some(ChatgptPlan::Free)
    );
    assert_eq!(
        plan(Provider::Openai, Some("free_workspace")),
        Some(ChatgptPlan::Free)
    );
    assert_eq!(
        plan(Provider::Openai, Some("plus")),
        Some(ChatgptPlan::Paid)
    );
    assert_eq!(plan(Provider::Openai, None), Some(ChatgptPlan::Unknown));
    assert_eq!(
        plan(Provider::Openai, Some("  ")),
        Some(ChatgptPlan::Unknown)
    );
    assert_eq!(plan(Provider::Anthropic, Some("free")), None);
}

#[test]
fn which_alerts_can_be_turned_on() {
    let weekly = vec![window("seven_day", "Weekly", 50.0, None)];
    let claude = account(Provider::Anthropic, Some("max"), Some(weekly));
    assert!(is_available(&claude, "weekly"));
    assert!(!is_available(&claude, "five_hour"));
    assert!(!is_available(&claude, "monthly"));

    // Before any usage, a ChatGPT account's plan says which limits it will have.
    let free = account(Provider::Openai, Some("free"), None);
    let unknown = account(Provider::Openai, None, None);
    let paid = account(Provider::Openai, Some("plus"), None);
    assert!(is_available(&free, "monthly") && !is_available(&free, "five_hour"));
    assert!(is_available(&unknown, "monthly") && !is_available(&unknown, "weekly"));
    assert!(is_available(&paid, "five_hour") && is_available(&paid, "weekly"));
    assert!(!is_available(&paid, "monthly"));
    assert!(!is_available(
        &account(Provider::Anthropic, None, None),
        "monthly"
    ));
}

#[test]
fn a_free_chatgpt_thirty_day_alert_also_watches_a_legacy_session_window() {
    let legacy = || Some(vec![window("session", "GPT · Session Limit", 10.0, None)]);
    let mut notified = HashSet::new();
    for plan in [Some("free"), None] {
        notified.clear();
        let (sent, changed) = check(
            &account(Provider::Openai, plan, legacy()),
            "monthly",
            20,
            &mut notified,
        );
        assert_eq!(sent.len(), 1, "plan {plan:?}");
        assert_eq!(sent[0].window_label, "30-day (GPT)");
        assert!(changed);
    }
    notified.clear();
    let (sent, _) = check(
        &account(Provider::Openai, Some("plus"), legacy()),
        "monthly",
        20,
        &mut notified,
    );
    assert!(
        sent.is_empty(),
        "a paid plan's session window is not its 30-day limit"
    );
}

#[test]
fn notifies_once_per_period_and_again_after_recovering() {
    let low = |resets_at| {
        account(
            Provider::Anthropic,
            Some("max"),
            Some(vec![window("seven_day", "Weekly", 10.0, Some(resets_at))]),
        )
    };
    let mut notified = HashSet::new();
    let (sent, changed) = check(&low("2026-10-01T00:00:00Z"), "weekly", 20, &mut notified);
    assert_eq!((sent.len(), changed), (1, true));
    assert_eq!(sent[0].window_label, "Weekly");
    assert_eq!(
        (sent[0].remaining_percent, sent[0].threshold_percent),
        (10, 20)
    );
    assert_eq!(
        check(&low("2026-10-01T00:00:00Z"), "weekly", 20, &mut notified),
        (Vec::new(), false)
    );

    // A new period notifies again.
    assert_eq!(
        check(&low("2026-10-08T00:00:00Z"), "weekly", 20, &mut notified)
            .0
            .len(),
        1
    );

    // Recovering above the threshold forgets the period, so dropping again notifies again.
    let recovered = account(
        Provider::Anthropic,
        Some("max"),
        Some(vec![window(
            "seven_day",
            "Weekly",
            60.0,
            Some("2026-10-08T00:00:00Z"),
        )]),
    );
    assert!(check(&recovered, "weekly", 20, &mut notified).1);
    assert_eq!(
        check(&low("2026-10-08T00:00:00Z"), "weekly", 20, &mut notified)
            .0
            .len(),
        1
    );
}

#[test]
fn a_key_written_before_windows_were_named_still_counts() {
    let mut notified = HashSet::from(["2026-10-01T00:00:00Z:20".to_string()]);
    let still_above_fifteen = account(
        Provider::Anthropic,
        Some("max"),
        Some(vec![window(
            "seven_day",
            "Weekly",
            18.0,
            Some("2026-10-01T00:00:00Z"),
        )]),
    );
    assert!(check(&still_above_fifteen, "weekly", 20, &mut notified)
        .0
        .is_empty());

    // Dropping to 15% still notifies for the 15% milestone.
    let at_fifteen = account(
        Provider::Anthropic,
        Some("max"),
        Some(vec![window(
            "seven_day",
            "Weekly",
            15.0,
            Some("2026-10-01T00:00:00Z"),
        )]),
    );
    let (sent, _) = check(&at_fifteen, "weekly", 20, &mut notified);
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].remaining_percent, 15);
}

#[test]
fn notifies_at_threshold_then_15_5_and_0_without_repeating_on_jitter() {
    let reading = |remaining, resets_at| {
        account(
            Provider::Anthropic,
            Some("max"),
            Some(vec![window(
                "five_hour",
                "5-Hour",
                remaining,
                Some(resets_at),
            )]),
        )
    };
    let mut notified = HashSet::new();

    // First crossing below 20% notifies once.
    let (sent, changed) = check(
        &reading(19.0, "2026-10-01T05:00:00Z"),
        "five_hour",
        20,
        &mut notified,
    );
    assert_eq!((sent.len(), changed), (1, true));
    assert_eq!(sent[0].remaining_percent, 19);

    // 18%..16% with slight resets_at jitter do NOT re-notify or dirty state.
    for (pct, reset) in [
        (18.0, "2026-10-01T05:00:01Z"),
        (17.0, "2026-10-01T05:00:04.250Z"),
        (16.0, "2026-10-01T04:59:58Z"),
    ] {
        assert_eq!(
            check(&reading(pct, reset), "five_hour", 20, &mut notified),
            (Vec::new(), false),
            "should not re-notify at {pct}%"
        );
    }

    // Reaching 15% notifies once.
    let (sent, changed) = check(
        &reading(15.0, "2026-10-01T05:00:02Z"),
        "five_hour",
        20,
        &mut notified,
    );
    assert_eq!((sent.len(), changed), (1, true));
    assert_eq!(sent[0].remaining_percent, 15);

    // Small upward rounding bounce (15 -> 16 -> 15) and countdown 14%..6% stay silent.
    for (pct, reset) in [
        (16.0, "2026-10-01T05:00:03Z"),
        (15.0, "2026-10-01T05:00:05Z"),
        (11.0, "2026-10-01T05:00:06Z"),
        (10.0, "2026-10-01T05:00:07Z"),
        (6.0, "2026-10-01T05:00:08Z"),
    ] {
        assert_eq!(
            check(&reading(pct, reset), "five_hour", 20, &mut notified),
            (Vec::new(), false),
            "should not re-notify at {pct}%"
        );
    }

    // Reaching 5% notifies once.
    let (sent, changed) = check(
        &reading(5.0, "2026-10-01T05:00:09Z"),
        "five_hour",
        20,
        &mut notified,
    );
    assert_eq!((sent.len(), changed), (1, true));
    assert_eq!(sent[0].remaining_percent, 5);

    // 4%..1% stay silent.
    assert_eq!(
        check(
            &reading(1.0, "2026-10-01T05:00:10Z"),
            "five_hour",
            20,
            &mut notified
        ),
        (Vec::new(), false)
    );

    // Reaching 0% notifies once, then stays silent.
    let (sent, changed) = check(
        &reading(0.0, "2026-10-01T05:00:11Z"),
        "five_hour",
        20,
        &mut notified,
    );
    assert_eq!((sent.len(), changed), (1, true));
    assert_eq!(sent[0].remaining_percent, 0);
    assert_eq!(
        check(
            &reading(0.0, "2026-10-01T05:00:15Z"),
            "five_hour",
            20,
            &mut notified
        ),
        (Vec::new(), false)
    );

    // A genuinely new reset period clears stale keys and notifies again.
    let (sent, changed) = check(
        &reading(18.0, "2026-10-01T10:00:00Z"),
        "five_hour",
        20,
        &mut notified,
    );
    assert_eq!((sent.len(), changed), (1, true));
    assert_eq!(sent[0].remaining_percent, 18);
}

#[test]
fn jumping_across_milestones_sends_one_alert_and_skips_threshold_above_10_percent() {
    let reading = |remaining| {
        account(
            Provider::Anthropic,
            Some("max"),
            Some(vec![window(
                "five_hour",
                "5-Hour",
                remaining,
                Some("2026-10-01T05:00:00Z"),
            )]),
        )
    };

    // With threshold = 20%, jumping straight from 50% to 12% sends one alert and suppresses 15%.
    let mut notified = HashSet::new();
    let (sent, _) = check(&reading(12.0), "five_hour", 20, &mut notified);
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].remaining_percent, 12);
    assert!(check(&reading(10.0), "five_hour", 20, &mut notified)
        .0
        .is_empty());
    let (sent, _) = check(&reading(5.0), "five_hour", 20, &mut notified);
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].remaining_percent, 5);

    // With threshold = 10%, 15% does not trigger; only 10%, 5%, and 0% do.
    notified.clear();
    assert!(check(&reading(15.0), "five_hour", 10, &mut notified)
        .0
        .is_empty());
    let (sent, _) = check(&reading(10.0), "five_hour", 10, &mut notified);
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].remaining_percent, 10);
    assert!(check(&reading(6.0), "five_hour", 10, &mut notified)
        .0
        .is_empty());
    let (sent, _) = check(&reading(5.0), "five_hour", 10, &mut notified);
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].remaining_percent, 5);
    let (sent, _) = check(&reading(0.0), "five_hour", 10, &mut notified);
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].remaining_percent, 0);
}

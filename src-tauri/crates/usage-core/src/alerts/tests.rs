use super::*;
use crate::model::{now_rfc3339, Provider, UsageFreshness, UsageSnapshot};

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
        email: None,
        provider_account_id: None,
        chatgpt_account_id: None,
        plan: plan.map(Into::into),
        created_at: now_rfc3339(),
        updated_at: now_rfc3339(),
        last_usage: windows.map(|windows| UsageSnapshot {
            plan: None,
            email: None,
            windows,
            credits_usd: None,
            unlimited_credits: false,
            fetched_at: now_rfc3339(),
            freshness: UsageFreshness::Live,
            source: "test".into(),
            limit_resets: Vec::new(),
        }),
        last_error: None,
        auth_required: false,
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
    let low = account(
        Provider::Anthropic,
        Some("max"),
        Some(vec![window(
            "seven_day",
            "Weekly",
            10.0,
            Some("2026-10-01T00:00:00Z"),
        )]),
    );
    assert!(check(&low, "weekly", 20, &mut notified).0.is_empty());
}

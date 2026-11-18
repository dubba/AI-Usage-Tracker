use super::*;
use crate::model::{now_rfc3339, Account};
use std::sync::Arc;

fn account(id: &str, provider: Provider, provider_account_id: Option<&str>) -> Account {
    let now = now_rfc3339();
    Account {
        id: id.into(),
        label: id.into(),
        provider,
        email: None,
        provider_account_id: provider_account_id.map(Into::into),
        chatgpt_account_id: None,
        plan: None,
        created_at: now.clone(),
        updated_at: now,
        last_usage: None,
        last_error: None,
        auth_required: false,
    }
}

fn app_with(accounts: Vec<Account>) -> Arc<AppState> {
    let temp = tempfile::tempdir().unwrap();
    let app = Arc::new(AppState::new(temp.path().to_path_buf(), "test-token".into()).unwrap());
    std::mem::forget(temp);
    for account in accounts {
        app.store.upsert(account).unwrap();
    }
    app
}

#[test]
fn a_migrated_google_ai_studio_account_keeps_its_fingerprint() {
    // L-53: the Antigravity clean-up used to run on the pre-migration snapshot
    // and clear the id this migration had just kept.
    let app = app_with(vec![account(
        "studio",
        Provider::Antigravity,
        Some("google-ai-studio:0123456789abcdef"),
    )]);
    migrate_google_ai_studio_accounts(&app);
    let migrated = app.store.get("studio").unwrap();
    assert_eq!(migrated.provider, Provider::GoogleAiStudio);
    assert_eq!(migrated.plan.as_deref(), Some("Google AI Studio"));
    assert_eq!(
        migrated.provider_account_id.as_deref(),
        Some("google-ai-studio:0123456789abcdef")
    );
}

#[test]
fn antigravity_project_ids_are_cleared_and_user_ids_kept() {
    let app = app_with(vec![
        account(
            "project",
            Provider::Antigravity,
            Some("my-cloud-project-123"),
        ),
        account("user", Provider::Antigravity, Some("104857600123456789012")),
        account("none", Provider::Antigravity, None),
    ]);
    migrate_google_ai_studio_accounts(&app);
    assert_eq!(app.store.get("project").unwrap().provider_account_id, None);
    assert_eq!(
        app.store
            .get("user")
            .unwrap()
            .provider_account_id
            .as_deref(),
        Some("104857600123456789012")
    );
    assert_eq!(app.store.get("none").unwrap().provider_account_id, None);
    assert_eq!(
        app.store.get("project").unwrap().provider,
        Provider::Antigravity
    );
}

#[test]
fn other_providers_are_left_alone_and_a_second_run_changes_nothing() {
    let app = app_with(vec![
        account("openai", Provider::Openai, Some("acct-not-digits")),
        account(
            "studio",
            Provider::Antigravity,
            Some("google-ai-studio:0123456789abcdef"),
        ),
    ]);
    migrate_google_ai_studio_accounts(&app);
    let first = serde_json::to_string(&app.store.list()).unwrap();
    migrate_google_ai_studio_accounts(&app);
    assert_eq!(serde_json::to_string(&app.store.list()).unwrap(), first);
    assert_eq!(
        app.store
            .get("openai")
            .unwrap()
            .provider_account_id
            .as_deref(),
        Some("acct-not-digits")
    );
}

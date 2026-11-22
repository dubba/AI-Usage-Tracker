use super::*;
use crate::model::{now_rfc3339, Account};
use std::sync::Arc;

fn account(id: &str, provider: Provider, provider_account_id: Option<&str>) -> Account {
    let now = now_rfc3339();
    Account {
        id: id.into(),
        label: id.into(),
        provider,
        provider_account_id: provider_account_id.map(Into::into),
        created_at: now.clone(),
        updated_at: now,
        ..Account::for_test()
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

#[test]
fn legacy_labels_and_errors_are_rewritten_once() {
    let mut codex = account("codex", Provider::Openai, None);
    codex.label = "Codex/GPT 2".into();
    codex.last_error = Some("authentication is required".into());
    let mut custom = account("custom", Provider::Openai, None);
    custom.label = "Work".into();
    custom.last_error = Some("Rate limit exceeded. Try again later.".into());
    let app = app_with(vec![codex, custom]);

    normalize_legacy_text(&app);
    let codex = app.store.get("codex").unwrap();
    assert_eq!(codex.label, "ChatGPT 2");
    assert_eq!(
        codex.last_error.as_deref(),
        Some("Re-authentication required")
    );
    let custom = app.store.get("custom").unwrap();
    assert_eq!(custom.label, "Work");
    assert_eq!(
        custom.last_error.as_deref(),
        Some("Rate limit exceeded. Try again later.")
    );

    let updated_at = codex.updated_at.clone();
    normalize_legacy_text(&app);
    assert_eq!(
        app.store.get("codex").unwrap().updated_at,
        updated_at,
        "a second run writes nothing"
    );
}

#[test]
fn a_moved_google_ai_studio_account_gets_the_current_name() {
    let mut legacy = account(
        "studio",
        Provider::Antigravity,
        Some("google-ai-studio:abc"),
    );
    legacy.label = "Google AI Studio".into();
    let app = app_with(vec![legacy]);
    migrate_google_ai_studio_accounts(&app);
    normalize_legacy_text(&app);
    assert_eq!(app.store.get("studio").unwrap().label, "AI Studio");
}

/// The error the migration writes is the one a refused sign-in produces today.
#[test]
fn the_rewritten_sign_in_error_is_the_current_one() {
    assert_eq!(
        crate::providers::ProviderError::Auth.to_string(),
        usage_core::legacy::AUTH_ERROR
    );
}

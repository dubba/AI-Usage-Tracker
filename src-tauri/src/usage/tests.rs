use super::*;
use crate::providers::google_ai_studio::SOURCE_MONITORING;

fn account(provider: Provider, source: &str, auth_required: bool) -> Account {
    let now = now_rfc3339();
    Account {
        id: "account".into(),
        label: "Account".into(),
        provider,
        email: None,
        provider_account_id: None,
        chatgpt_account_id: None,
        plan: None,
        created_at: now.clone(),
        updated_at: now.clone(),
        last_usage: Some(UsageSnapshot {
            plan: None,
            email: None,
            windows: Vec::new(),
            credits_usd: None,
            unlimited_credits: false,
            fetched_at: now,
            freshness: UsageFreshness::Live,
            source: source.into(),
        }),
        last_error: None,
        auth_required,
    }
}

#[test]
fn skips_accounts_that_require_reconnection() {
    assert!(!should_auto_refresh(&account(
        Provider::Openai,
        "wham",
        true,
    )));
}

#[test]
fn skips_google_ai_studio_until_cloud_setup_finishes() {
    assert!(!should_auto_refresh(&account(
        Provider::GoogleAiStudio,
        SOURCE_MODELS_ONLY,
        false,
    )));
}

#[test]
fn refreshes_connected_google_ai_studio_accounts() {
    assert!(should_auto_refresh(&account(
        Provider::GoogleAiStudio,
        SOURCE_MONITORING,
        false,
    )));
}

#[test]
fn account_refresh_timeout_is_bounded() {
    assert_eq!(ACCOUNT_REFRESH_TIMEOUT, Duration::from_secs(45));
}

#[tokio::test]
async fn refresh_all_runs_without_panicking_on_empty_or_skipped() {
    let temp = tempfile::tempdir().unwrap();
    let app = Arc::new(AppState::new(temp.path().to_path_buf(), "test-token".into()).unwrap());

    let mut account1 = account(Provider::Openai, "test", true);
    account1.id = "account1".into();
    let mut account2 = account(Provider::GoogleAiStudio, SOURCE_MODELS_ONLY, false);
    account2.id = "account2".into();
    app.store.upsert(account1).unwrap();
    app.store.upsert(account2).unwrap();

    let list = refresh_all(app.clone()).await;
    assert_eq!(list.len(), 2);
}

#[tokio::test]
async fn refresh_account_aborts_cleanly_if_account_is_missing() {
    let temp = tempfile::tempdir().unwrap();
    let app = Arc::new(AppState::new(temp.path().to_path_buf(), "test-token".into()).unwrap());

    let result = refresh_account(app.clone(), "nonexistent").await;
    assert!(result.is_err());
    assert_eq!(result.unwrap_err(), "Account not found.");
}

fn openai_secret() -> ProviderSecret {
    ProviderSecret::Openai(crate::model::OAuthSecret {
        access_token: "access".into(),
        refresh_token: "refresh".into(),
        id_token: None,
        expires_at: i64::MAX,
    })
}

fn rotated_openai_secret() -> ProviderSecret {
    ProviderSecret::Openai(crate::model::OAuthSecret {
        access_token: "access-2".into(),
        refresh_token: "refresh-2".into(),
        id_token: None,
        expires_at: i64::MAX,
    })
}

fn usage_with_one_window() -> ProviderUsage {
    ProviderUsage {
        plan: None,
        email: None,
        provider_account_id: None,
        windows: vec![crate::model::UsageWindow {
            id: "session".into(),
            label: "Session".into(),
            used_percent: Some(10.0),
            remaining_percent: Some(90.0),
            resets_at: None,
            window_seconds: None,
            kind: None,
        }],
        credits_usd: None,
        unlimited_credits: false,
        source: "test".into(),
    }
}

fn test_app_with_account(id: &str) -> Arc<AppState> {
    let temp = tempfile::tempdir().unwrap();
    let app = Arc::new(AppState::new(temp.path().to_path_buf(), "test-token".into()).unwrap());
    // The temp dir must outlive the app for the whole test.
    std::mem::forget(temp);
    let mut openai = account(Provider::Openai, "wham", false);
    openai.id = id.into();
    app.store.persist_account(openai, &openai_secret()).unwrap();
    app
}

#[tokio::test]
async fn timed_out_refresh_keeps_the_account_locked_until_the_task_finishes() {
    let id = "usage-timeout-lock";
    let app = test_app_with_account(id);
    let (release, wait) = tokio::sync::oneshot::channel::<()>();

    let result = refresh_account_with(
        app.clone(),
        id,
        Duration::from_millis(50),
        move |_, _, _| async move {
            let _ = wait.await;
            Err(ProviderError::Transient("late".into()))
        },
    )
    .await
    .unwrap();
    assert_eq!(
        result.last_error.as_deref(),
        Some("Account refresh timed out.")
    );

    // We stopped waiting, but the provider task is still running with the
    // account lock: nothing else may touch this account yet.
    let lock = app.account_lock(id);
    assert!(lock.try_lock().is_err());

    release.send(()).unwrap();
    let _guard = tokio::time::timeout(Duration::from_secs(2), lock.lock())
        .await
        .expect("lock is released once the task finishes");
}

#[tokio::test]
async fn timed_out_refresh_still_saves_the_rotated_secret() {
    let id = "usage-timeout-rotation";
    let app = test_app_with_account(id);
    let (release, wait) = tokio::sync::oneshot::channel::<()>();

    let result = refresh_account_with(
        app.clone(),
        id,
        Duration::from_millis(50),
        move |_, _, _| async move {
            let _ = wait.await;
            Ok((usage_with_one_window(), rotated_openai_secret()))
        },
    )
    .await
    .unwrap();
    assert_eq!(
        result.last_error.as_deref(),
        Some("Account refresh timed out.")
    );

    // The provider answers after we stopped waiting, having already
    // revoked the old refresh token. Its replacement must still be kept.
    release.send(()).unwrap();
    let lock = app.account_lock(id);
    let _guard = tokio::time::timeout(Duration::from_secs(2), lock.lock())
        .await
        .expect("lock is released once the task finishes");
    match load_provider_secret(id).unwrap() {
        ProviderSecret::Openai(secret) => assert_eq!(secret.refresh_token, "refresh-2"),
        _ => panic!("unexpected provider secret"),
    }
}

#[tokio::test]
async fn refresh_does_not_resurrect_credentials_of_a_removed_account() {
    let id = "usage-removed-during-refresh";
    let app = test_app_with_account(id);
    let remover = app.clone();
    let result = refresh_account_with(
        app.clone(),
        id,
        Duration::from_secs(5),
        move |_, _, _| async move {
            remover.store.remove(id).unwrap();
            Ok((usage_with_one_window(), rotated_openai_secret()))
        },
    )
    .await;
    assert_eq!(result.unwrap_err(), "Account removed during refresh.");
    assert!(load_provider_secret(id).is_err());
}

#[tokio::test]
async fn finished_refresh_releases_the_account_lock() {
    let id = "usage-finished-lock";
    let app = test_app_with_account(id);
    let result = refresh_account_with(app.clone(), id, Duration::from_secs(5), |_, _, _| async {
        Err(ProviderError::Transient("boom".into()))
    })
    .await
    .unwrap();
    assert_eq!(result.last_error.as_deref(), Some("boom"));
    assert!(app.account_lock(id).try_lock().is_ok());
}

#[tokio::test]
async fn panicking_provider_task_is_reported_as_a_transient_failure() {
    let id = "usage-panic-lock";
    let app = test_app_with_account(id);
    let result = refresh_account_with(app.clone(), id, Duration::from_secs(5), |_, _, _| async {
        panic!("provider bug")
    })
    .await
    .unwrap();
    assert_eq!(
        result.last_error.as_deref(),
        Some("Account refresh stopped unexpectedly.")
    );
    assert!(!result.auth_required);
    assert!(app.account_lock(id).try_lock().is_ok());
}

#[tokio::test]
async fn rate_limit_hint_defers_only_automatic_refreshes() {
    let id = "usage-rate-limited";
    let app = test_app_with_account(id);
    refresh_account_with(app.clone(), id, Duration::from_secs(5), |_, _, _| async {
        Err(ProviderError::RateLimited {
            message: "OpenAI rate-limited the usage request.".into(),
            retry_after: Some(Duration::from_secs(1800)),
        })
    })
    .await
    .unwrap();
    assert!(app.refresh_backoff.lock().is_deferred(id, Instant::now()));

    // The scheduled pass leaves the account alone (no network involved).
    let before = app.store.get(id).unwrap().updated_at;
    refresh_all_auto(app.clone()).await;
    assert_eq!(app.store.get(id).unwrap().updated_at, before);
}

#[tokio::test]
async fn success_and_auth_failure_clear_backoff() {
    let id = "usage-backoff-clear";
    let app = test_app_with_account(id);
    app.refresh_backoff.lock().record_failure(
        id,
        Some(Duration::from_secs(1800)),
        Instant::now(),
        0.0,
    );
    let usage = usage_with_one_window();
    refresh_account_with(
        app.clone(),
        id,
        Duration::from_secs(5),
        move |_, _, secret| async move { Ok((usage, secret)) },
    )
    .await
    .unwrap();
    assert!(!app.refresh_backoff.lock().is_deferred(id, Instant::now()));

    app.refresh_backoff.lock().record_failure(
        id,
        Some(Duration::from_secs(1800)),
        Instant::now(),
        0.0,
    );
    refresh_account_with(app.clone(), id, Duration::from_secs(5), |_, _, _| async {
        Err(ProviderError::Auth)
    })
    .await
    .unwrap();
    assert!(!app.refresh_backoff.lock().is_deferred(id, Instant::now()));
}

#[tokio::test]
async fn refresh_slots_are_capped() {
    let app = test_app_with_account("usage-permits");
    let mut held = Vec::new();
    for _ in 0..crate::state::MAX_CONCURRENT_REFRESHES {
        held.push(app.refresh_permits.clone().acquire_owned().await.unwrap());
    }
    assert!(app.refresh_permits.clone().try_acquire_owned().is_err());
    held.pop();
    assert!(app.refresh_permits.clone().try_acquire_owned().is_ok());
}

#[test]
fn test_sanitize_error_message() {
    assert_eq!(
        sanitize_error_message("OpenAI rate-limited the usage request."),
        "OpenAI rate-limited the usage request."
    );
    assert_eq!(
        sanitize_error_message("Invalid authorization header: Bearer abcdef123456"),
        "A provider error occurred while processing the request."
    );
    assert_eq!(
        sanitize_error_message("Failed with response: {\"error\": \"invalid_client\"}"),
        "A provider error occurred while processing the request."
    );
    assert_eq!(
        sanitize_error_message("   "),
        "An unknown provider error occurred."
    );
    let long_message = "word ".repeat(60);
    let sanitized = sanitize_error_message(&long_message);
    assert_eq!(sanitized.len(), 200);
    assert!(sanitized.ends_with("..."));
}

#[test]
fn sanitize_error_message_keeps_only_plain_prose() {
    // Every message the providers build passes unchanged.
    for message in [
        "OpenAI rate-limited the usage request. Retry after 30 seconds.",
        "Antigravity endpoint /v1internal:retrieveUserQuota returned 503 Service Unavailable.",
        "Anthropic usage request failed: the request timed out.",
        "Google Cloud denied Monitoring access. Confirm the project ID, enable the Cloud Monitoring API.",
        "Select no more than 8 Google models.",
    ] {
        assert_eq!(sanitize_error_message(message), message);
    }
    // Shapes that could carry secrets or raw responses are dropped.
    for message in [
        "request failed for https://api.example.com/usage?key=abc123",
        "Bad key sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
        "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r",
        "cookie: session=abc; other=def",
        "<html>challenge</html>",
        "user someone@example.com denied",
    ] {
        assert_eq!(
            sanitize_error_message(message),
            "A provider error occurred while processing the request.",
            "{message}"
        );
    }
}

#[test]
fn sanitize_error_message_never_splits_a_multibyte_character() {
    // 3-byte characters: byte 197 is inside one, which used to panic.
    let long_message = "界 ".repeat(150);
    let sanitized = sanitize_error_message(&long_message);
    assert_eq!(sanitized.chars().count(), 200);
    assert!(sanitized.ends_with("..."));

    // Exactly at the limit is returned untouched, multi-byte or not.
    let at_limit = "界 ".repeat(100).trim().to_string();
    assert_eq!(sanitize_error_message(&at_limit), at_limit);
}

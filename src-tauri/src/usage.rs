use crate::{
    model::{now_rfc3339, Account, Provider, ProviderSecret, UsageFreshness, UsageSnapshot},
    providers::{self, ProviderError, ProviderUsage},
    state::AppState,
    store::{load_provider_secret, save_provider_secret},
};
use std::{
    future::Future,
    sync::Arc,
    time::{Duration, Instant},
};
use tauri::Emitter;
use tauri_plugin_notification::NotificationExt;

const GOOGLE_AI_STUDIO_MODELS_ONLY_SOURCE: &str = "google_ai_studio_model_access";
const ACCOUNT_REFRESH_TIMEOUT: Duration = Duration::from_secs(45);

pub async fn refresh_account(app: Arc<AppState>, account_id: &str) -> Result<Account, String> {
    refresh_account_with(
        app,
        account_id,
        ACCOUNT_REFRESH_TIMEOUT,
        |app, account, secret| async move { providers::refresh(app, &account, secret).await },
    )
    .await
}

type RefreshOutcome = Result<(ProviderUsage, ProviderSecret), ProviderError>;

/// `refresh_account` with the provider call and timeout injectable for tests.
async fn refresh_account_with<Run, RunFuture>(
    app: Arc<AppState>,
    account_id: &str,
    timeout: Duration,
    run: Run,
) -> Result<Account, String>
where
    Run: FnOnce(Arc<AppState>, Account, ProviderSecret) -> RunFuture + Send + 'static,
    RunFuture: Future<Output = RefreshOutcome> + Send + 'static,
{
    let lock = app.account_lock(account_id);
    let guard = lock.lock_owned().await;

    let mut account = app
        .store
        .get(account_id)
        .ok_or_else(|| "Account not found.".to_string())?;
    let secret = match load_provider_secret(account_id) {
        Ok(secret) if secret.provider() == account.provider => secret,
        Ok(secret)
            if secret.provider() == Provider::GoogleAiStudio
                && account.provider == Provider::Antigravity
                && account
                    .provider_account_id
                    .as_deref()
                    .is_some_and(|value| value.starts_with("google-ai-studio:")) =>
        {
            account = app
                .store
                .mutate(account_id, |account| {
                    account.provider = Provider::GoogleAiStudio;
                    account.plan = Some("Google AI Studio".into());
                })
                .map_err(|error| error.to_string())?;
            secret
        }
        Ok(_) => return save_failure(&app, account_id, ProviderError::Auth),
        Err(_) => {
            return save_credential_failure(
                &app,
                account_id,
                "Unable to load provider credentials.".into(),
            )
        }
    };

    // Run the provider refresh on its own task. The timeout below only stops
    // *waiting*: dropping the future mid-flight could discard a rotated
    // refresh token after the provider already revoked the old one. The
    // task is still bounded by the HTTP client's per-request timeouts.
    //
    // The task also owns the account lock and hands it back with the result.
    // If we stop waiting, the lock stays held until the task really finishes,
    // so a removal, re-login, or second refresh cannot interleave with it and
    // leave an orphaned or stale credential behind.
    let refresh_app = app.clone();
    let refresh_task = tokio::spawn(async move {
        let outcome = run(refresh_app, account, secret).await;
        (outcome, guard)
    });
    let (refresh_result, _guard) = match tokio::time::timeout(timeout, refresh_task).await {
        Ok(Ok((outcome, guard))) => (Ok(outcome), Some(guard)),
        Ok(Err(_join_error)) => (
            Ok(Err(ProviderError::Transient(
                "Account refresh stopped unexpectedly.".into(),
            ))),
            None,
        ),
        Err(elapsed) => (Err(elapsed), None),
    };

    if app.store.get(account_id).is_none() {
        return Err("Account removed during refresh.".into());
    }

    match refresh_result {
        Ok(Ok((usage, refreshed_secret))) => {
            save_provider_secret(account_id, &refreshed_secret)
                .map_err(|_| "Unable to save refreshed credentials.".to_string())?;
            save_success(&app, account_id, usage)
        }
        Ok(Err(error)) => save_failure(&app, account_id, error),
        Err(_) => save_failure(
            &app,
            account_id,
            ProviderError::Transient("Account refresh timed out.".into()),
        ),
    }
}

/// Refreshes every eligible account now (the "Refresh all" button). Ignores
/// failure backoff: the user asked for it.
pub async fn refresh_all(app: Arc<AppState>) -> Vec<Account> {
    refresh_accounts(app, false).await
}

/// Scheduled refresh. Skips accounts still backing off after repeated
/// failures or a provider `Retry-After`.
pub async fn refresh_all_auto(app: Arc<AppState>) -> Vec<Account> {
    refresh_accounts(app, true).await
}

async fn refresh_accounts(app: Arc<AppState>, respect_backoff: bool) -> Vec<Account> {
    let accounts = app.store.list();
    let now = Instant::now();
    let mut tasks = tokio::task::JoinSet::new();

    for account in &accounts {
        if !should_auto_refresh(account) {
            continue;
        }
        if respect_backoff && app.refresh_backoff.lock().is_deferred(&account.id, now) {
            continue;
        }
        let refresh_app = app.clone();
        let refresh_id = account.id.clone();
        tasks.spawn(async move {
            // Wait for a slot *before* taking the account lock or starting the
            // per-account timeout, so queueing never counts against either.
            let _permit = refresh_app.refresh_permits.clone().acquire_owned().await;
            let result = refresh_account(refresh_app, &refresh_id).await;
            (refresh_id, result)
        });
    }

    while let Some(join_result) = tasks.join_next().await {
        match join_result {
            Ok((_id, _result)) => {}
            Err(error) => {
                if error.is_panic() {
                    eprintln!("Automatic refresh task stopped unexpectedly: {error}");
                }
            }
        }
    }

    app.store.list()
}

fn should_auto_refresh(account: &Account) -> bool {
    if account.auth_required {
        return false;
    }

    if account.provider == Provider::GoogleAiStudio
        && account
            .last_usage
            .as_ref()
            .is_some_and(|usage| usage.source == GOOGLE_AI_STUDIO_MODELS_ONLY_SOURCE)
    {
        return false;
    }

    true
}

fn mark_account_refresh_suspended(
    app: &AppState,
    account_id: &str,
    message: String,
) -> Result<Account, String> {
    app.refresh_backoff.lock().forget(account_id);
    app.store
        .mutate(account_id, |account| {
            if let Some(usage) = account.last_usage.as_mut() {
                usage.freshness = UsageFreshness::AuthRequired;
            }
            account.last_error = Some(message);
            account.auth_required = true;
        })
        .map_err(|error| error.to_string())
}

fn save_credential_failure(
    app: &AppState,
    account_id: &str,
    message: String,
) -> Result<Account, String> {
    mark_account_refresh_suspended(app, account_id, message)
}

fn save_success(app: &AppState, account_id: &str, usage: ProviderUsage) -> Result<Account, String> {
    if usage.windows.is_empty() {
        return save_failure(
            app,
            account_id,
            ProviderError::Transient("The provider returned no usable usage windows.".into()),
        );
    }
    let fetched_at = now_rfc3339();
    let account = app
        .store
        .mutate(account_id, |account| {
            account.plan = usage.plan.clone().or_else(|| account.plan.clone());
            account.email = usage.email.clone().or_else(|| account.email.clone());
            // Antigravity reports its Google Cloud project id in the usage
            // response. That is NOT an account identity: every project id is
            // shared across accounts, so persisting it here would make distinct
            // Antigravity accounts look like duplicates during device pairing.
            if account.provider != Provider::Antigravity {
                account.provider_account_id = usage
                    .provider_account_id
                    .clone()
                    .or_else(|| account.provider_account_id.clone());
            }
            if account.provider == Provider::Openai {
                account.chatgpt_account_id = account.provider_account_id.clone();
            }
            account.last_usage = Some(UsageSnapshot {
                plan: account.plan.clone(),
                email: account.email.clone(),
                windows: usage.windows,
                credits_usd: usage.credits_usd,
                unlimited_credits: usage.unlimited_credits,
                fetched_at,
                freshness: UsageFreshness::Live,
                source: usage.source,
            });
            account.last_error = None;
            account.auth_required = false;
        })
        .map_err(|error| error.to_string())?;
    app.refresh_backoff.lock().record_success(account_id);
    emit_alerts_for_account(app, &account);
    Ok(account)
}

#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct UsageAlertPayload {
    pub account_id: String,
    pub account_label: String,
    pub provider: String,
    pub window_label: String,
    pub remaining_percent: u8,
    pub threshold_percent: u8,
    pub title: String,
    pub body: String,
}

pub fn emit_alerts_for_account(app: &AppState, account: &Account) {
    let Ok(notifications) = app.alerts.evaluate(account) else {
        return;
    };
    if notifications.is_empty() {
        return;
    }
    let app_handle = app.app_handle.read().clone();
    let Some(app_handle) = app_handle else {
        return;
    };

    for notification in notifications {
        let title = format!(
            "{} {} limit alert",
            account.provider.display_name(),
            notification.window_label
        );
        let body = format!(
            "{} has {}% remaining in the {} window. Your alert threshold is {}%.",
            account.label,
            notification.remaining_percent,
            notification.window_label,
            notification.threshold_percent
        );
        #[cfg(target_os = "android")]
        let notify_result = crate::lan_binding::post_expandable_notification(&title, &body);
        #[cfg(not(target_os = "android"))]
        let notify_result = app_handle
            .notification()
            .builder()
            .title(&title)
            .body(&body)
            .show();
        if let Err(err) = notify_result {
            eprintln!("[Notification] System notification error: {err}");
        }

        let payload = UsageAlertPayload {
            account_id: account.id.clone(),
            account_label: account.label.clone(),
            provider: account.provider.display_name().to_string(),
            window_label: notification.window_label,
            remaining_percent: notification.remaining_percent,
            threshold_percent: notification.threshold_percent,
            title,
            body,
        };
        let _ = app_handle.emit("usage-alert", payload);
    }
}

fn sanitize_error_message(message: &str) -> String {
    let trimmed = message.trim();
    if trimmed.is_empty() {
        return "An unknown provider error occurred.".to_string();
    }
    let lower = trimmed.to_ascii_lowercase();
    if lower.contains("bearer ")
        || lower.contains("refresh_token")
        || lower.contains("access_token")
        || lower.contains("client_secret")
        || lower.contains("eyjh")
        || lower.contains("{\"")
        || (trimmed.starts_with('{') && trimmed.ends_with('}'))
    {
        return "A provider error occurred while processing the request.".to_string();
    }
    if trimmed.len() > 200 {
        return format!("{}...", &trimmed[..197]);
    }
    trimmed.to_string()
}

fn save_failure(app: &AppState, account_id: &str, error: ProviderError) -> Result<Account, String> {
    let is_auth = matches!(&error, ProviderError::Auth);
    {
        let mut backoff = app.refresh_backoff.lock();
        if is_auth {
            // Suspended accounts are not refreshed automatically anyway.
            backoff.forget(account_id);
        } else {
            let retry_after = match &error {
                ProviderError::RateLimited { retry_after, .. } => *retry_after,
                _ => None,
            };
            backoff.record_failure(
                account_id,
                retry_after,
                Instant::now(),
                rand::random::<f64>(),
            );
        }
    }
    let message = sanitize_error_message(&error.to_string());
    app.store
        .mutate(account_id, |account| {
            if let Some(usage) = account.last_usage.as_mut() {
                usage.freshness = if is_auth {
                    UsageFreshness::AuthRequired
                } else {
                    UsageFreshness::Stale
                };
            }
            account.last_error = Some(message);
            account.auth_required = is_auth;
        })
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

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
            GOOGLE_AI_STUDIO_MODELS_ONLY_SOURCE,
            false,
        )));
    }

    #[test]
    fn refreshes_connected_google_ai_studio_accounts() {
        assert!(should_auto_refresh(&account(
            Provider::GoogleAiStudio,
            "google_ai_studio_cloud_monitoring",
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
        let mut account2 = account(
            Provider::GoogleAiStudio,
            GOOGLE_AI_STUDIO_MODELS_ONLY_SOURCE,
            false,
        );
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
    async fn finished_refresh_releases_the_account_lock() {
        let id = "usage-finished-lock";
        let app = test_app_with_account(id);
        let result =
            refresh_account_with(app.clone(), id, Duration::from_secs(5), |_, _, _| async {
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
        let result =
            refresh_account_with(app.clone(), id, Duration::from_secs(5), |_, _, _| async {
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
        let usage = ProviderUsage {
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
            }],
            credits_usd: None,
            unlimited_credits: false,
            source: "test".into(),
        };
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
        let long_message = "x".repeat(300);
        let sanitized = sanitize_error_message(&long_message);
        assert_eq!(sanitized.len(), 200);
        assert!(sanitized.ends_with("..."));
    }
}

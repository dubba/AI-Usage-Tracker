use crate::{
    model::{now_rfc3339, Account, Provider, UsageFreshness, UsageSnapshot},
    providers::{self, ProviderError, ProviderUsage},
    state::AppState,
    store::{load_provider_secret, save_provider_secret},
};
use std::sync::Arc;
use tauri_plugin_notification::NotificationExt;

const GOOGLE_AI_STUDIO_MODELS_ONLY_SOURCE: &str = "google_ai_studio_model_access";

pub async fn refresh_account(app: Arc<AppState>, account_id: &str) -> Result<Account, String> {
    let lock = app.account_lock(account_id);
    let _guard = lock.lock().await;
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
        Err(error) => {
            return save_credential_failure(
                &app,
                account_id,
                format!("Unable to load provider credentials: {error}"),
            )
        }
    };

    match providers::refresh(app.clone(), &account, secret).await {
        Ok((usage, refreshed_secret)) => {
            save_provider_secret(account_id, &refreshed_secret)
                .map_err(|error| format!("Unable to save refreshed credentials: {error}"))?;
            save_success(&app, account_id, usage)
        }
        Err(error) => save_failure(&app, account_id, error),
    }
}

pub async fn refresh_all(app: Arc<AppState>) -> Vec<Account> {
    let accounts = app.store.list();
    let mut tasks = tokio::task::JoinSet::new();

    for account in &accounts {
        if should_auto_refresh(account) {
            let refresh_app = app.clone();
            let refresh_id = account.id.clone();
            tasks.spawn(async move {
                let result = refresh_account(refresh_app, &refresh_id).await;
                (refresh_id, result)
            });
        }
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
        && account.last_usage.as_ref().is_some_and(|usage| {
            usage.source == GOOGLE_AI_STUDIO_MODELS_ONLY_SOURCE
        })
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
            account.provider_account_id = usage
                .provider_account_id
                .clone()
                .or_else(|| account.provider_account_id.clone());
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
    emit_alerts_for_account(app, &account);
    Ok(account)
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
        let _ = app_handle
            .notification()
            .builder()
            .title(title)
            .body(body)
            .show();
    }
}

fn save_failure(app: &AppState, account_id: &str, error: ProviderError) -> Result<Account, String> {
    let is_auth = matches!(&error, ProviderError::Auth);
    let message = error.to_string();
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

    #[tokio::test]
    async fn refresh_all_runs_without_panicking_on_empty_or_skipped() {
        let temp = tempfile::tempdir().unwrap();
        let app = Arc::new(AppState::new(temp.path().to_path_buf(), "test-token".into()).unwrap());

        let mut account1 = account(Provider::Openai, "test", true);
        account1.id = "account1".into();
        let mut account2 = account(Provider::GoogleAiStudio, GOOGLE_AI_STUDIO_MODELS_ONLY_SOURCE, false);
        account2.id = "account2".into();
        app.store.upsert(account1).unwrap();
        app.store.upsert(account2).unwrap();

        let list = refresh_all(app.clone()).await;
        assert_eq!(list.len(), 2);
    }
}

use crate::{
    model::{now_rfc3339, Account, Provider, ProviderSecret, UsageFreshness, UsageSnapshot},
    providers::{self, ProviderError, ProviderUsage},
    state::AppState,
    store::{load_provider_secret, save_provider_secret},
};
use providers::google_ai_studio::SOURCE_MODELS_ONLY;
use std::{
    future::Future,
    sync::Arc,
    time::{Duration, Instant},
};
use tauri::Emitter;
use tauri_plugin_notification::NotificationExt;

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
    //
    // A rotated secret is saved inside the task for the same reason: if it
    // were left for the caller, a timeout would drop it on the floor and the
    // next refresh would present a refresh token the provider already revoked.
    let refresh_app = app.clone();
    let task_account_id = account_id.to_string();
    let refresh_task = tokio::spawn(async move {
        let outcome = match run(refresh_app.clone(), account, secret).await {
            Ok((usage, refreshed_secret)) => {
                // A removed account must not get its credential written back.
                if refresh_app.store.get(&task_account_id).is_some() {
                    save_provider_secret(&task_account_id, &refreshed_secret)
                        .map(|()| Ok(usage))
                        .map_err(|_| "Unable to save refreshed credentials.".to_string())
                } else {
                    Ok(Ok(usage))
                }
            }
            Err(error) => Ok(Err(error)),
        };
        (outcome, guard)
    });
    let (refresh_result, _guard) = match tokio::time::timeout(timeout, refresh_task).await {
        Ok(Ok((outcome, guard))) => (Ok(outcome), Some(guard)),
        Ok(Err(_join_error)) => (
            Ok(Ok(Err(ProviderError::Transient(
                "Account refresh stopped unexpectedly.".into(),
            )))),
            None,
        ),
        Err(elapsed) => (Err(elapsed), None),
    };

    if app.store.get(account_id).is_none() {
        return Err("Account removed during refresh.".into());
    }

    match refresh_result {
        Ok(Ok(Ok(usage))) => save_success(&app, account_id, usage),
        Ok(Ok(Err(error))) => save_failure(&app, account_id, error),
        Ok(Err(save_error)) => Err(save_error),
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
                    crate::diagnostics::warn(&format!(
                        "Automatic refresh task stopped unexpectedly: {error}"
                    ));
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
            .is_some_and(|usage| usage.source == SOURCE_MODELS_ONLY)
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
    // The usage history is a bonus: failing to record must never fail the refresh.
    if let Err(error) = app.history.record(&account) {
        crate::diagnostics::warn(&format!("Could not record usage history: {error}"));
    }
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
        let notify_result =
            crate::platform::lan_binding::post_expandable_notification(&title, &body);
        #[cfg(not(target_os = "android"))]
        let notify_result = app_handle
            .notification()
            .builder()
            .title(&title)
            .body(&body)
            .show();
        if let Err(err) = notify_result {
            crate::diagnostics::warn(&format!("[Notification] System notification error: {err}"));
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

/// Longest unbroken run of letters and digits a stored message may contain.
/// Tokens, keys, ids, and encoded blobs are all longer; ordinary words and
/// endpoint names are not.
const MAX_PLAIN_WORD_CHARS: usize = 32;

/// Longest run without whitespace. Words joined by dots or slashes (a JWT, a
/// dotted key) stay under the per-word limit, so the whole token is measured too.
const MAX_PLAIN_TOKEN_CHARS: usize = 48;

/// True only for plain prose: letters, digits, spaces, and basic sentence
/// punctuation, with no long token-like run. Everything the app writes on
/// purpose passes; JSON, headers, URLs with queries, and encoded secrets do
/// not. This is an allowlist, so an unexpected shape is dropped rather than
/// stored.
fn is_plain_status_text(text: &str) -> bool {
    text.chars().all(|ch| {
        ch.is_alphanumeric() || ch.is_whitespace() || ".,:;()'\u{2019}\"/-!?%".contains(ch)
    }) && !text
        .split(|ch: char| !ch.is_alphanumeric())
        .any(|run| run.chars().count() > MAX_PLAIN_WORD_CHARS)
        && !text
            .split_whitespace()
            .any(|token| token.chars().count() > MAX_PLAIN_TOKEN_CHARS)
}

/// The text stored in `last_error` and shown in the app and the local API.
///
/// Provider errors are built from fixed sentences (see `providers`), never from
/// raw response text. This is the last line of defense: it keeps only plain
/// prose, and the keyword check stays as a second guard for credentials that
/// happen to be short.
fn sanitize_error_message(message: &str) -> String {
    let trimmed = message.trim();
    if trimmed.is_empty() {
        return "An unknown provider error occurred.".to_string();
    }
    let lower = trimmed.to_ascii_lowercase();
    if !is_plain_status_text(trimmed)
        || lower.contains("bearer ")
        || lower.contains("refresh_token")
        || lower.contains("access_token")
        || lower.contains("client_secret")
        || lower.contains("eyjh")
    {
        return "A provider error occurred while processing the request.".to_string();
    }
    // Count characters, not bytes: slicing at byte 197 panics when it lands
    // inside a multi-byte character (for example a localized provider message).
    if trimmed.chars().count() > 200 {
        let shortened: String = trimmed.chars().take(197).collect();
        return format!("{shortened}...");
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
mod tests;

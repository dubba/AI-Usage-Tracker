//! Reading and saving the account's stored secret during the sign-in, under the account's lock.

use super::*;

pub(super) fn validate_google_ai_studio_account(
    app: &AppState,
    account_id: &str,
) -> Result<(), String> {
    app.store
        .get(account_id)
        .ok_or_else(|| "Google AI Studio account not found.".to_string())?;
    let secret = load_provider_secret(account_id).map_err(|error| error.to_string())?;
    if !matches!(secret, ProviderSecret::GoogleAiStudio(_)) {
        return Err("This account is not a Google AI Studio API-key connection.".into());
    }
    Ok(())
}

/// Loads the Google AI Studio secret, runs `modify`, and saves the secret it
/// returns, while this account's lock is held. Usage refresh holds the same
/// lock for its whole provider call, including a Cloud token rotation.
pub(super) async fn modify_google_ai_studio_secret<T, F, Fut>(
    app: &AppState,
    account_id: &str,
    modify: F,
) -> Result<T, String>
where
    F: FnOnce(GoogleAiStudioSecret) -> Fut,
    Fut: std::future::Future<Output = Result<(GoogleAiStudioSecret, T), String>>,
{
    let lock = app.account_lock(account_id);
    let _guard = lock.lock().await;
    let current = load_google_ai_studio_secret(account_id)?;
    let (updated, value) = modify(current).await?;
    save_provider_secret(account_id, &ProviderSecret::GoogleAiStudio(updated))
        .map_err(|error| error.to_string())?;
    Ok(value)
}

pub(super) fn load_google_ai_studio_secret(
    account_id: &str,
) -> Result<GoogleAiStudioSecret, String> {
    match load_provider_secret(account_id).map_err(|error| error.to_string())? {
        ProviderSecret::GoogleAiStudio(secret) => Ok(secret),
        _ => Err("This account is not a Google AI Studio connection.".into()),
    }
}

pub(super) async fn ensure_fresh_oauth(
    app: &AppState,
    oauth: OAuthSecret,
) -> Result<OAuthSecret, String> {
    if !oauth.expires_within(300) {
        return Ok(oauth);
    }
    google_ai_studio::refresh_cloud_secret(app, &oauth, IdToken::PreferNew)
        .await
        .map_err(|error| match error {
            ProviderError::Auth => "Google authorization expired. Sign in again.".to_string(),
            other => other.to_string(),
        })
}

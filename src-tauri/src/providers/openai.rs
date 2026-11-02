use super::{
    body_too_large, classify_status,
    oauth_refresh::{
        refresh_oauth_secret, IdToken, InvalidGrant, Lifetime, RefreshBody, RefreshRequest,
    },
    read_capped_text, with_fresh_secret, CappedBodyError, Forbidden, ProviderError, ProviderUsage,
    StatusPolicy, MAX_PROVIDER_BODY_BYTES,
};
use crate::{
    model::{Account, OAuthSecret, ProviderSecret, UsageWindow},
    state::AppState,
};
use chrono::{TimeZone, Utc};
use reqwest::header::RETRY_AFTER;
use serde::Deserialize;
use serde_json::Value;

const USAGE_URL: &str = "https://chatgpt.com/backend-api/wham/usage";
/// The OAuth client and token endpoint, shared with sign-in (`oauth.rs`) so a login and a
/// later refresh always talk to the same one.
pub(crate) const TOKEN_URL: &str = "https://auth.openai.com/oauth/token";
pub(crate) const CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";

#[derive(Debug, Deserialize)]
struct RawUsage {
    plan_type: Option<String>,
    email: Option<String>,
    rate_limit: Option<RawRateLimit>,
    code_review_rate_limit: Option<RawCodeReviewRateLimit>,
    credits: Option<RawCredits>,
}

#[derive(Debug, Deserialize)]
struct RawRateLimit {
    primary_window: Option<RawWindow>,
    secondary_window: Option<RawWindow>,
}

#[derive(Debug, Deserialize)]
struct RawCodeReviewRateLimit {
    primary_window: Option<RawWindow>,
}

#[derive(Debug, Deserialize)]
struct RawWindow {
    used_percent: Option<Value>,
    reset_at: Option<Value>,
    reset_after_seconds: Option<Value>,
    limit_window_seconds: Option<Value>,
}

#[derive(Debug, Deserialize)]
struct RawCredits {
    unlimited: Option<bool>,
    balance: Option<Value>,
}

pub async fn refresh(
    app: &AppState,
    account: &Account,
    secret: OAuthSecret,
) -> Result<(ProviderUsage, OAuthSecret), ProviderError> {
    let (raw, secret) = with_fresh_secret(
        account,
        secret,
        ProviderSecret::Openai,
        |secret| Box::pin(async move { refresh_secret(app, &secret).await }),
        |secret| Box::pin(async move { call_usage(app, account, &secret).await }),
    )
    .await?;

    let is_free_plan = raw
        .plan_type
        .as_deref()
        .or(account.plan.as_deref())
        .is_some_and(|p| p.eq_ignore_ascii_case("free"));

    let mut windows = Vec::new();
    if let Some(window) = raw
        .rate_limit
        .as_ref()
        .and_then(|rate| rate.primary_window.as_ref())
    {
        let window_seconds = window
            .limit_window_seconds
            .as_ref()
            .and_then(value_as_u64)
            .or_else(|| window.reset_after_seconds.as_ref().and_then(value_as_u64));
        let (id, label) = if window_seconds.is_some_and(|s| s >= 2_000_000) || is_free_plan {
            ("monthly", "GPT · 30-Day Limit")
        } else if window_seconds.is_some_and(|s| s >= 500_000) {
            ("weekly", "GPT · Weekly Limit")
        } else {
            ("session", "GPT · Session Limit")
        };
        if let Some(window) = normalize_window(id, label, window) {
            windows.push(window);
        }
    }
    if let Some(window) = raw
        .rate_limit
        .as_ref()
        .and_then(|rate| rate.secondary_window.as_ref())
    {
        let window_seconds = window
            .limit_window_seconds
            .as_ref()
            .and_then(value_as_u64)
            .or_else(|| window.reset_after_seconds.as_ref().and_then(value_as_u64));
        let (id, label) = if window_seconds.is_some_and(|s| s >= 2_000_000) {
            ("monthly", "GPT · 30-Day Limit")
        } else {
            ("weekly", "GPT · Weekly Limit")
        };
        if let Some(window) = normalize_window(id, label, window) {
            windows.push(window);
        }
    }
    if let Some(window) = raw
        .code_review_rate_limit
        .as_ref()
        .and_then(|rate| rate.primary_window.as_ref())
    {
        if let Some(window) = normalize_window("code_review", "Code Review · Limit", window) {
            windows.push(window);
        }
    }
    if windows.is_empty() {
        return Err(ProviderError::Transient(
            "The OpenAI response contained no usable usage windows.".into(),
        ));
    }

    let credits_usd = raw
        .credits
        .as_ref()
        .and_then(|credits| credits.balance.as_ref())
        .and_then(value_as_f64);
    let unlimited_credits = raw
        .credits
        .as_ref()
        .and_then(|credits| credits.unlimited)
        .unwrap_or(false);

    Ok((
        ProviderUsage {
            plan: raw.plan_type.or_else(|| account.plan.clone()),
            email: raw.email.or_else(|| account.email.clone()),
            provider_account_id: account.effective_account_id().map(str::to_string),
            windows,
            credits_usd,
            unlimited_credits,
            source: "wham".into(),
        },
        secret,
    ))
}

async fn call_usage(
    app: &AppState,
    account: &Account,
    secret: &OAuthSecret,
) -> Result<RawUsage, ProviderError> {
    let mut request = app
        .client
        .get(USAGE_URL)
        .bearer_auth(&secret.access_token)
        .header("Accept", "application/json");
    if let Some(account_id) = account.effective_account_id() {
        request = request.header("ChatGPT-Account-Id", account_id);
    }

    let response = request.send().await.map_err(|error| {
        ProviderError::Transient(format!(
            "Usage request failed: {}.",
            super::transport_failure(&error)
        ))
    })?;
    let status = response.status();
    let retry_after = response
        .headers()
        .get(RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let body = match read_capped_text(response, MAX_PROVIDER_BODY_BYTES).await {
        Ok(body) => body,
        Err(CappedBodyError::TooLarge) => return Err(body_too_large("OpenAI")),
        Err(CappedBodyError::Unreadable(reason)) => {
            return Err(ProviderError::Transient(format!(
                "Unable to read the usage response: {reason}."
            )))
        }
    };

    let denied = if body.trim_start().starts_with('<') {
        "OpenAI returned an HTML access challenge. Cached usage is being kept."
    } else {
        "OpenAI denied the usage request. Cached usage is being kept."
    };
    if let Some(error) = classify_status(
        "OpenAI",
        status,
        retry_after.as_deref(),
        &StatusPolicy::usage("OpenAI", Forbidden::Transient(denied)),
    ) {
        return Err(error);
    }
    if body.trim_start().starts_with('<') {
        return Err(ProviderError::Transient(
            "OpenAI returned HTML instead of usage JSON.".into(),
        ));
    }
    serde_json::from_str(&body)
        .map_err(|_| ProviderError::Transient("OpenAI returned incompatible usage data.".into()))
}

async fn refresh_secret(
    app: &AppState,
    secret: &OAuthSecret,
) -> Result<OAuthSecret, ProviderError> {
    refresh_oauth_secret(
        RefreshRequest {
            client: &app.client,
            provider: "OpenAI",
            url: TOKEN_URL,
            body: RefreshBody::Form(&[
                ("grant_type", "refresh_token"),
                ("client_id", CLIENT_ID),
                ("refresh_token", secret.refresh_token.as_str()),
            ]),
            invalid_grant: InvalidGrant::BadRequestOnly,
            lifetime: Lifetime::Required,
            id_token: IdToken::PreferNew,
        },
        secret,
    )
    .await
}

fn normalize_window(id: &str, label: &str, raw: &RawWindow) -> Option<UsageWindow> {
    let used = raw
        .used_percent
        .as_ref()
        .and_then(value_as_f64)
        .map(|value| value.clamp(0.0, 100.0))?;
    let reset_at_seconds = raw.reset_at.as_ref().and_then(value_as_i64).or_else(|| {
        raw.reset_after_seconds
            .as_ref()
            .and_then(value_as_i64)
            .filter(|_| used > 0.0)
            .map(|seconds| Utc::now().timestamp() + seconds)
    });
    let resets_at = reset_at_seconds
        .and_then(|seconds| Utc.timestamp_opt(seconds, 0).single())
        .map(|value| value.to_rfc3339());
    let window_seconds = raw
        .limit_window_seconds
        .as_ref()
        .and_then(value_as_u64)
        .or_else(|| {
            if id == "monthly" {
                Some(2_592_000)
            } else {
                raw.reset_after_seconds.as_ref().and_then(value_as_u64)
            }
        });
    Some(UsageWindow {
        id: id.into(),
        label: label.into(),
        used_percent: Some(used),
        remaining_percent: Some((100.0 - used).max(0.0)),
        resets_at,
        window_seconds,
        kind: None,
    })
}

fn value_as_f64(value: &Value) -> Option<f64> {
    value
        .as_f64()
        .or_else(|| value.as_str()?.parse().ok())
        .filter(|v| v.is_finite())
}

fn value_as_i64(value: &Value) -> Option<i64> {
    value
        .as_i64()
        .or_else(|| value.as_u64().and_then(|value| i64::try_from(value).ok()))
        .or_else(|| value.as_str()?.parse().ok())
}

fn value_as_u64(value: &Value) -> Option<u64> {
    value
        .as_u64()
        .or_else(|| value.as_i64().and_then(|value| u64::try_from(value).ok()))
        .or_else(|| value.as_str()?.parse().ok())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn normalize_window_skips_synthetic_resets_at_when_quota_unused() {
        let raw: RawWindow = serde_json::from_value(json!({
            "used_percent": 0.0,
            "reset_after_seconds": 18000,
            "limit_window_seconds": 18000
        }))
        .unwrap();

        let window = normalize_window("session", "Session", &raw).unwrap();
        assert_eq!(window.used_percent, Some(0.0));
        assert_eq!(window.remaining_percent, Some(100.0));
        assert!(window.resets_at.is_none());
    }

    #[test]
    fn normalize_window_synthesizes_resets_at_when_quota_used() {
        let raw: RawWindow = serde_json::from_value(json!({
            "used_percent": 15.0,
            "reset_after_seconds": 18000,
            "limit_window_seconds": 18000
        }))
        .unwrap();

        let window = normalize_window("session", "Session", &raw).unwrap();
        assert_eq!(window.used_percent, Some(15.0));
        assert_eq!(window.remaining_percent, Some(85.0));
        assert!(window.resets_at.is_some());
    }

    #[test]
    fn normalize_window_handles_thirty_day_window() {
        let raw: RawWindow = serde_json::from_value(json!({
            "used_percent": 25.0,
            "reset_after_seconds": 2592000,
            "limit_window_seconds": 2592000
        }))
        .unwrap();

        let window = normalize_window("monthly", "GPT · 30-Day Limit", &raw).unwrap();
        assert_eq!(window.id, "monthly");
        assert_eq!(window.label, "GPT · 30-Day Limit");
        assert_eq!(window.used_percent, Some(25.0));
        assert_eq!(window.remaining_percent, Some(75.0));
        assert_eq!(window.window_seconds, Some(2592000));
        assert!(window.resets_at.is_some());
    }

    #[test]
    fn normalize_window_drops_non_finite_used_percent() {
        let nan_raw: RawWindow = serde_json::from_value(json!({
            "used_percent": "NaN",
            "reset_after_seconds": 18000,
        }))
        .unwrap();
        assert!(normalize_window("session", "Session", &nan_raw).is_none());

        let inf_raw: RawWindow = serde_json::from_value(json!({
            "used_percent": "Infinity",
            "reset_after_seconds": 18000,
        }))
        .unwrap();
        assert!(normalize_window("session", "Session", &inf_raw).is_none());

        let neg_inf_raw: RawWindow = serde_json::from_value(json!({
            "used_percent": "-Infinity",
            "reset_after_seconds": 18000,
        }))
        .unwrap();
        assert!(normalize_window("session", "Session", &neg_inf_raw).is_none());

        let missing_raw: RawWindow = serde_json::from_value(json!({
            "reset_after_seconds": 18000,
        }))
        .unwrap();
        assert!(normalize_window("session", "Session", &missing_raw).is_none());
    }
}

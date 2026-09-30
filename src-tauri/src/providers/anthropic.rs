use super::{ProviderError, ProviderUsage};
use crate::{
    model::{Account, OAuthSecret, ProviderSecret, UsageWindow},
    state::AppState,
    store::save_provider_secret,
};
use chrono::Utc;
use reqwest::{header::RETRY_AFTER, StatusCode};
use serde::Deserialize;
use serde_json::Value;

const USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";
const PROFILE_URL: &str = "https://api.anthropic.com/api/oauth/profile";
const LEGACY_PROFILE_URL: &str = "https://api.anthropic.com/api/auth/oauth/profile";
const TOKEN_URL: &str = "https://platform.claude.com/v1/oauth/token";
const CLIENT_ID: &str = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const OAUTH_BETA: &str = "oauth-2025-04-20";

#[derive(Debug, Deserialize)]
struct RefreshResponse {
    access_token: String,
    refresh_token: Option<String>,
    expires_in: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct RawWindow {
    utilization: Option<f64>,
    resets_at: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RawExtraUsage {
    utilization: Option<f64>,
    spent_usd: Option<f64>,
    limit_usd: Option<f64>,
    resets_at: Option<String>,
    is_enabled: Option<bool>,
}

#[derive(Debug, Deserialize)]
struct RawUsage {
    five_hour: Option<RawWindow>,
    seven_day: Option<RawWindow>,
    extra_usage: Option<RawExtraUsage>,
}

pub async fn refresh(
    app: &AppState,
    account: &Account,
    mut secret: OAuthSecret,
) -> Result<(ProviderUsage, OAuthSecret), ProviderError> {
    if secret.expires_within(300) {
        secret = refresh_secret(app, secret).await?;
        save_provider_secret(&account.id, &ProviderSecret::Anthropic(secret.clone()))
            .map_err(|_| ProviderError::Transient("Unable to save refreshed credentials.".into()))?;
    }

    let raw = match call_usage(app, &secret).await {
        Err(ProviderError::Auth) => {
            secret = refresh_secret(app, secret).await?;
            save_provider_secret(&account.id, &ProviderSecret::Anthropic(secret.clone()))
                .map_err(|_| {
                    ProviderError::Transient("Unable to save refreshed credentials.".into())
                })?;
            call_usage(app, &secret).await?
        }
        result => result?,
    };

    let windows = windows_from_raw(&raw);
    if windows.is_empty() {
        return Err(ProviderError::Transient(
            "Anthropic returned no usable usage windows.".into(),
        ));
    }

    // Fetched every refresh so plan changes (upgrade, downgrade, lapse) are
    // picked up; failures fall back to the stored values below.
    let profile = fetch_profile(app, &secret.access_token).await.ok();
    let email = profile
        .as_ref()
        .and_then(email_from_profile)
        .or_else(|| account.email.clone());
    let provider_account_id = profile
        .as_ref()
        .and_then(account_id_from_profile)
        .or_else(|| account.provider_account_id.clone());
    let plan = profile
        .as_ref()
        .and_then(plan_from_profile)
        .or_else(|| account.plan.clone());

    let credits_usd = raw.extra_usage.as_ref().and_then(|extra| match (extra.limit_usd, extra.spent_usd) {
        (Some(limit), Some(spent)) => Some((limit - spent).max(0.0)),
        _ => None,
    });

    Ok((
        ProviderUsage {
            plan,
            email,
            provider_account_id,
            windows,
            credits_usd,
            unlimited_credits: false,
            source: "anthropic_oauth_usage".into(),
        },
        secret,
    ))
}

async fn call_usage(app: &AppState, secret: &OAuthSecret) -> Result<RawUsage, ProviderError> {
    let response = app
        .client
        .get(USAGE_URL)
        .bearer_auth(&secret.access_token)
        .header("Accept", "application/json")
        .header("anthropic-beta", OAUTH_BETA)
        .send()
        .await
        .map_err(|error| ProviderError::Transient(format!("Anthropic usage request failed: {error}")))?;
    let status = response.status();
    let retry_after = response
        .headers()
        .get(RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let body = response.text().await.map_err(|error| {
        ProviderError::Transient(format!("Unable to read the Anthropic usage response: {error}"))
    })?;

    if let Some(error) = usage_status_error(status, retry_after) {
        return Err(error);
    }
    serde_json::from_str(&body).map_err(|_| {
        ProviderError::Transient("Anthropic returned incompatible usage data.".into())
    })
}

/// Maps a non-success usage response to a provider error. Only 401 means the
/// credentials are rejected. 403 is also what Anthropic's edge returns for
/// bot challenges and regional blocks, so it must stay transient: treating it
/// as an auth failure suspends the account until the user signs in again.
fn usage_status_error(status: StatusCode, retry_after: Option<String>) -> Option<ProviderError> {
    if status.is_success() {
        return None;
    }
    Some(match status {
        StatusCode::UNAUTHORIZED => ProviderError::Auth,
        StatusCode::FORBIDDEN => ProviderError::Transient(
            "Anthropic denied the usage request. Cached usage is being kept.".into(),
        ),
        StatusCode::TOO_MANY_REQUESTS => ProviderError::Transient(match retry_after {
            Some(value) => format!("Anthropic rate-limited the usage request. Retry after {value}."),
            None => "Anthropic rate-limited the usage request.".into(),
        }),
        _ => ProviderError::Transient(format!("Anthropic usage request returned {status}.")),
    })
}

async fn refresh_secret(
    app: &AppState,
    secret: OAuthSecret,
) -> Result<OAuthSecret, ProviderError> {
    let response = app
        .client
        .post(TOKEN_URL)
        .json(&serde_json::json!({
            "grant_type": "refresh_token",
            "client_id": CLIENT_ID,
            "refresh_token": secret.refresh_token,
        }))
        .send()
        .await
        .map_err(|_| ProviderError::Transient("Anthropic token refresh failed.".into()))?;
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if !status.is_success() {
        if status == StatusCode::UNAUTHORIZED
            || status == StatusCode::FORBIDDEN
            || body.to_ascii_lowercase().contains("invalid_grant")
        {
            return Err(ProviderError::Auth);
        }
        return Err(ProviderError::Transient(format!(
            "Anthropic token refresh returned {status}."
        )));
    }
    let tokens: RefreshResponse = serde_json::from_str(&body).map_err(|_| {
        ProviderError::Transient("Invalid Anthropic token refresh response.".into())
    })?;
    Ok(OAuthSecret {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token.unwrap_or(secret.refresh_token),
        id_token: secret.id_token,
        expires_at: Utc::now().timestamp_millis() + tokens.expires_in.unwrap_or(3600) * 1000,
    })
}

async fn fetch_profile(app: &AppState, access_token: &str) -> Result<Value, ProviderError> {
    match fetch_profile_url(app, access_token, PROFILE_URL).await {
        Ok(profile) => Ok(profile),
        Err(_) => fetch_profile_url(app, access_token, LEGACY_PROFILE_URL).await,
    }
}

async fn fetch_profile_url(
    app: &AppState,
    access_token: &str,
    url: &str,
) -> Result<Value, ProviderError> {
    let response = app
        .client
        .get(url)
        .bearer_auth(access_token)
        .header("Accept", "application/json")
        .header("anthropic-beta", OAUTH_BETA)
        .send()
        .await
        .map_err(|_| ProviderError::Transient("Anthropic profile request failed.".into()))?;
    if !response.status().is_success() {
        return Err(ProviderError::Transient(format!(
            "Anthropic profile request returned {}.",
            response.status()
        )));
    }
    response
        .json()
        .await
        .map_err(|_| ProviderError::Transient("Invalid Anthropic profile response.".into()))
}

fn windows_from_raw(raw: &RawUsage) -> Vec<UsageWindow> {
    let mut windows = Vec::new();
    push_window(&mut windows, "five_hour", "5 hour", raw.five_hour.as_ref(), Some(18_000));
    push_window(&mut windows, "weekly", "Weekly", raw.seven_day.as_ref(), Some(604_800));
    if let Some(extra) = raw.extra_usage.as_ref() {
        if extra.is_enabled.unwrap_or(true) && extra.utilization.is_some() {
            let utilization = extra.utilization.unwrap_or_default().clamp(0.0, 100.0);
            windows.push(UsageWindow {
                id: "extra_usage".into(),
                label: "Extra usage".into(),
                used_percent: Some(utilization),
                remaining_percent: Some((100.0 - utilization).max(0.0)),
                resets_at: extra.resets_at.clone(),
                window_seconds: None,
            });
        }
    }
    windows
}

fn push_window(
    windows: &mut Vec<UsageWindow>,
    id: &str,
    label: &str,
    raw: Option<&RawWindow>,
    window_seconds: Option<u64>,
) {
    let Some(raw) = raw else { return };
    let used = raw.utilization.map(|value| value.clamp(0.0, 100.0));
    windows.push(UsageWindow {
        id: id.into(),
        label: label.into(),
        used_percent: used,
        remaining_percent: used.map(|value| (100.0 - value).max(0.0)),
        resets_at: raw.resets_at.clone(),
        window_seconds,
    });
}

fn non_empty_str(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn account_object(value: &Value) -> Option<&Value> {
    value.get("account")
}

pub(crate) fn email_from_profile(value: &Value) -> Option<String> {
    let account = account_object(value);
    non_empty_str(account.and_then(|account| account.get("email")))
        .or_else(|| non_empty_str(account.and_then(|account| account.get("email_address"))))
        .or_else(|| non_empty_str(value.get("email")))
        .or_else(|| non_empty_str(value.get("email_address")))
        .or_else(|| non_empty_str(value.get("account_email")))
}

pub(crate) fn account_id_from_profile(value: &Value) -> Option<String> {
    let account = account_object(value);
    non_empty_str(account.and_then(|account| account.get("uuid")))
        .or_else(|| non_empty_str(account.and_then(|account| account.get("account_id"))))
        .or_else(|| non_empty_str(account.and_then(|account| account.get("id"))))
        .or_else(|| non_empty_str(value.get("account_id")))
        .or_else(|| non_empty_str(value.get("account_uuid")))
}

/// Normalizes an Anthropic profile into a plan id (`claude_pro`,
/// `claude_max_5x`, `claude_max_20x`, `claude_team`, `claude_enterprise`,
/// `free`). Returns `None` when the profile carries no recognizable plan
/// signal, so callers keep the last known plan instead of guessing.
///
/// `rate_limit_tier` alone is not a plan: Pro and Free accounts both report
/// `default_claude_ai`, so it is only used to tell Max 5x from Max 20x.
pub(crate) fn plan_from_profile(value: &Value) -> Option<String> {
    let plan = ["organization_type", "subscription_type", "subscription_tier", "plan"]
        .iter()
        .flat_map(|key| collect_strings(value, key))
        .find_map(|text| classify_plan(&text))
        .or_else(|| {
            if find_bool(value, "has_claude_max") == Some(true) {
                Some("claude_max")
            } else if find_bool(value, "has_claude_pro") == Some(true) {
                Some("claude_pro")
            } else {
                None
            }
        })
        .or_else(|| {
            let has_max = find_bool(value, "has_claude_max")?;
            let has_pro = find_bool(value, "has_claude_pro")?;
            (!has_max && !has_pro).then_some("free")
        })?;
    if plan == "claude_max" {
        let tier = collect_strings(value, "rate_limit_tier")
            .iter()
            .find_map(|text| classify_plan(text).filter(|plan| plan.starts_with("claude_max_")));
        return Some(tier.unwrap_or(plan).to_string());
    }
    Some(plan.to_string())
}

fn classify_plan(text: &str) -> Option<&'static str> {
    let lower = text.to_ascii_lowercase();
    if lower.contains("max") {
        if lower.contains("20x") || lower.contains("200") {
            Some("claude_max_20x")
        } else if lower.contains("5x") || lower.contains("100") {
            Some("claude_max_5x")
        } else {
            Some("claude_max")
        }
    } else if lower.contains("enterprise") {
        Some("claude_enterprise")
    } else if lower.contains("team") {
        Some("claude_team")
    } else if lower.contains("pro") {
        Some("claude_pro")
    } else if lower.contains("free") {
        Some("free")
    } else {
        None
    }
}

fn collect_strings(value: &Value, key: &str) -> Vec<String> {
    let mut found = Vec::new();
    collect_strings_into(value, key, &mut found);
    found
}

fn collect_strings_into(value: &Value, key: &str, found: &mut Vec<String>) {
    match value {
        Value::Object(object) => {
            if let Some(text) = object.get(key).and_then(Value::as_str) {
                if !text.trim().is_empty() {
                    found.push(text.to_string());
                }
            }
            object.values().for_each(|value| collect_strings_into(value, key, found));
        }
        Value::Array(values) => values.iter().for_each(|value| collect_strings_into(value, key, found)),
        _ => {}
    }
}

fn find_bool(value: &Value, key: &str) -> Option<bool> {
    match value {
        Value::Object(object) => object
            .get(key)
            .and_then(Value::as_bool)
            .or_else(|| object.values().find_map(|value| find_bool(value, key))),
        Value::Array(values) => values.iter().find_map(|value| find_bool(value, key)),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_401_marks_anthropic_credentials_as_rejected() {
        assert!(matches!(
            usage_status_error(StatusCode::UNAUTHORIZED, None),
            Some(ProviderError::Auth)
        ));
        // Edge challenges and regional blocks must keep cached usage and keep
        // the account refreshing instead of suspending it.
        assert!(matches!(
            usage_status_error(StatusCode::FORBIDDEN, None),
            Some(ProviderError::Transient(_))
        ));
        assert!(matches!(
            usage_status_error(StatusCode::TOO_MANY_REQUESTS, Some("30".into())),
            Some(ProviderError::Transient(message)) if message.contains("Retry after 30")
        ));
        assert!(matches!(
            usage_status_error(StatusCode::BAD_GATEWAY, None),
            Some(ProviderError::Transient(_))
        ));
        assert!(usage_status_error(StatusCode::OK, None).is_none());
    }

    #[test]
    fn normalizes_anthropic_windows() {
        let raw: RawUsage = serde_json::from_value(serde_json::json!({
            "five_hour": { "utilization": 25, "resets_at": "2026-07-13T20:00:00Z" },
            "seven_day": { "utilization": 50, "resets_at": "2026-07-19T00:00:00Z" }
        }))
        .unwrap();
        let windows = windows_from_raw(&raw);
        assert_eq!(windows.len(), 2);
        assert_eq!(windows[0].remaining_percent, Some(75.0));
        assert_eq!(windows[1].id, "weekly");
    }

    #[test]
    fn ignores_unnamed_anthropic_quota_buckets() {
        let raw: RawUsage = serde_json::from_value(serde_json::json!({
            "five_hour": { "utilization": 0, "resets_at": "2026-09-29T12:00:00Z" },
            "seven_day": { "utilization": 0, "resets_at": "2026-10-04T12:00:00Z" },
            "nimbus_quill": { "utilization": 0 },
            "iguana_necktie": { "utilization": 12 },
            "seven_day_omelette": { "utilization": 7, "resets_at": "2026-10-04T12:00:00Z" },
            "seven_day_sonnet": { "utilization": 3 }
        }))
        .unwrap();
        let windows = windows_from_raw(&raw);
        assert_eq!(
            windows.iter().map(|window| window.id.as_str()).collect::<Vec<_>>(),
            ["five_hour", "weekly"]
        );
    }

    #[test]
    fn reads_nested_anthropic_profile_email() {
        let profile = serde_json::json!({
            "account": {
                "uuid": "acct-1",
                "email": "claude.user@example.com"
            },
            "organization": {
                "uuid": "org-9",
                "name": "Personal"
            }
        });
        assert_eq!(
            email_from_profile(&profile).as_deref(),
            Some("claude.user@example.com")
        );
        assert_eq!(account_id_from_profile(&profile).as_deref(), Some("acct-1"));
    }

    #[test]
    fn detects_pro_plan_despite_generic_rate_limit_tier() {
        let profile = serde_json::json!({
            "account": { "email": "a@example.com", "has_claude_max": false, "has_claude_pro": true },
            "organization": {
                "organization_type": "claude_pro",
                "rate_limit_tier": "default_claude_ai",
                "billing_type": "stripe_subscription"
            }
        });
        assert_eq!(plan_from_profile(&profile).as_deref(), Some("claude_pro"));
    }

    #[test]
    fn detects_pro_plan_from_account_flags_alone() {
        let profile = serde_json::json!({
            "account": { "has_claude_max": false, "has_claude_pro": true },
            "organization": { "rate_limit_tier": "default_claude_ai" }
        });
        assert_eq!(plan_from_profile(&profile).as_deref(), Some("claude_pro"));
    }

    #[test]
    fn detects_max_tiers_from_rate_limit_tier() {
        let five = serde_json::json!({
            "organization": { "organization_type": "claude_max", "rate_limit_tier": "default_claude_max_5x" }
        });
        let twenty = serde_json::json!({
            "account": { "has_claude_max": true },
            "organization": { "rate_limit_tier": "default_claude_max_20x" }
        });
        assert_eq!(plan_from_profile(&five).as_deref(), Some("claude_max_5x"));
        assert_eq!(plan_from_profile(&twenty).as_deref(), Some("claude_max_20x"));
    }

    #[test]
    fn detects_free_plan_only_from_explicit_signals() {
        let free = serde_json::json!({
            "account": { "has_claude_max": false, "has_claude_pro": false },
            "organization": { "rate_limit_tier": "default_claude_ai" }
        });
        assert_eq!(plan_from_profile(&free).as_deref(), Some("free"));
        let unknown = serde_json::json!({ "organization": { "rate_limit_tier": "default_claude_ai" } });
        assert_eq!(plan_from_profile(&unknown), None);
    }
}

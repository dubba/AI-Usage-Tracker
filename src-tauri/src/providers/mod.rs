pub mod anthropic;
pub mod antigravity;
pub mod google_ai_studio;
pub mod grok;
pub mod oauth_refresh;
pub mod openai;
pub mod opencode_go;

use crate::{
    model::{Account, ProviderSecret, UsageWindow},
    state::AppState,
};
use std::{sync::Arc, time::Duration};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ProviderError {
    #[error("authentication is required")]
    Auth,
    #[error("{0}")]
    Transient(String),
    /// The provider asked us to slow down. `retry_after` is the provider's own
    /// hint (from `Retry-After`) when it sent a usable one.
    #[error("{message}")]
    RateLimited {
        message: String,
        retry_after: Option<Duration>,
    },
}

/// Parses an HTTP `Retry-After` value: either delay-seconds or an HTTP-date.
/// Returns `None` for anything unusable, and never a negative delay.
pub fn parse_retry_after(value: &str) -> Option<Duration> {
    let value = value.trim();
    if let Ok(seconds) = value.parse::<u64>() {
        return Some(Duration::from_secs(seconds));
    }
    let when = chrono::DateTime::parse_from_rfc2822(value).ok()?;
    let delay = when.signed_duration_since(chrono::Utc::now());
    Some(delay.to_std().unwrap_or(Duration::ZERO))
}

/// A fixed description of why a request failed, for messages the user sees.
/// `reqwest::Error`'s own text names the request URL and can quote what the
/// server sent, so it must never be interpolated into a stored message.
pub fn transport_failure(error: &reqwest::Error) -> &'static str {
    if error.is_timeout() {
        "the request timed out"
    } else if error.is_connect() {
        "the connection could not be made"
    } else if error.is_decode() || error.is_body() {
        "the response could not be read"
    } else {
        "the connection failed"
    }
}

/// The error for an HTTP 429. The user-visible text is built from the parsed
/// delay, never from the raw `Retry-After` header, which the provider controls.
pub fn rate_limited(provider: &str, retry_after_header: Option<&str>) -> ProviderError {
    let retry_after = retry_after_header.and_then(parse_retry_after);
    let message = match retry_after {
        Some(delay) => format!(
            "{provider} rate-limited the usage request. Retry after {} seconds.",
            delay.as_secs()
        ),
        None => format!("{provider} rate-limited the usage request."),
    };
    ProviderError::RateLimited {
        message,
        retry_after,
    }
}

#[derive(Clone, Debug)]
pub struct ProviderUsage {
    pub plan: Option<String>,
    pub email: Option<String>,
    pub provider_account_id: Option<String>,
    pub windows: Vec<UsageWindow>,
    pub credits_usd: Option<f64>,
    pub unlimited_credits: bool,
    pub source: String,
}

pub async fn refresh(
    app: Arc<AppState>,
    account: &Account,
    secret: ProviderSecret,
) -> Result<(ProviderUsage, ProviderSecret), ProviderError> {
    match secret {
        ProviderSecret::Openai(secret) => {
            let (usage, secret) = openai::refresh(app.as_ref(), account, secret).await?;
            Ok((usage, ProviderSecret::Openai(secret)))
        }
        ProviderSecret::Anthropic(secret) => {
            let (usage, secret) = anthropic::refresh(app.as_ref(), account, secret).await?;
            Ok((usage, ProviderSecret::Anthropic(secret)))
        }
        ProviderSecret::Antigravity(secret) => {
            let (usage, secret) = antigravity::refresh(app.as_ref(), account, secret).await?;
            Ok((usage, ProviderSecret::Antigravity(secret)))
        }
        ProviderSecret::OpencodeGo(secret) => {
            let usage = opencode_go::refresh(app.as_ref(), account, &secret).await?;
            Ok((usage, ProviderSecret::OpencodeGo(secret)))
        }
        ProviderSecret::GoogleAiStudio(secret) => {
            let (usage, secret) = google_ai_studio::refresh(app.as_ref(), account, secret).await?;
            Ok((usage, ProviderSecret::GoogleAiStudio(secret)))
        }
        ProviderSecret::Grok(secret) => {
            let (usage, secret) = grok::refresh(app.as_ref(), account, &secret).await?;
            Ok((usage, ProviderSecret::Grok(secret)))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retry_after_accepts_seconds_and_http_dates() {
        assert_eq!(parse_retry_after("120"), Some(Duration::from_secs(120)));
        assert_eq!(parse_retry_after(" 7 "), Some(Duration::from_secs(7)));
        assert_eq!(parse_retry_after("0"), Some(Duration::ZERO));

        let future = (chrono::Utc::now() + chrono::Duration::seconds(90)).to_rfc2822();
        let parsed = parse_retry_after(&future).unwrap();
        assert!(parsed <= Duration::from_secs(90) && parsed >= Duration::from_secs(80));

        // A date in the past means "retry now", never a negative delay.
        assert_eq!(
            parse_retry_after("Wed, 21 Oct 2015 07:28:00 GMT"),
            Some(Duration::ZERO)
        );
    }

    #[test]
    fn rate_limit_message_never_echoes_the_raw_header() {
        let ProviderError::RateLimited {
            message,
            retry_after,
        } = rate_limited("Acme", Some("120"))
        else {
            unreachable!()
        };
        assert_eq!(
            message,
            "Acme rate-limited the usage request. Retry after 120 seconds."
        );
        assert_eq!(retry_after, Some(Duration::from_secs(120)));

        let ProviderError::RateLimited { message, .. } =
            rate_limited("Acme", Some("Bearer sk-secret-value {\"a\":1}"))
        else {
            unreachable!()
        };
        assert_eq!(message, "Acme rate-limited the usage request.");
        assert!(!message.contains("sk-secret"));
    }

    #[test]
    fn retry_after_rejects_garbage() {
        assert_eq!(parse_retry_after(""), None);
        assert_eq!(parse_retry_after("soon"), None);
        assert_eq!(parse_retry_after("-5"), None);
    }
}

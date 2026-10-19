pub mod anthropic;
pub mod antigravity;
pub mod google_ai_studio;
pub mod grok;
pub mod oauth_refresh;
pub mod openai;
pub mod opencode_go;

use crate::{
    model::{Account, OAuthSecret, ProviderSecret, UsageWindow},
    state::AppState,
    store::save_provider_secret,
};
use reqwest::StatusCode;
use std::{future::Future, pin::Pin, sync::Arc, time::Duration};
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

/// A token that expires within this many seconds is refreshed before it is used, so a request
/// does not start with a token that dies on the way.
pub(crate) const REFRESH_SKEW_SECS: i64 = 300;

/// A provider call that borrows the secret it runs with.
pub(crate) type SecretFuture<'a, T> =
    Pin<Box<dyn Future<Output = Result<T, ProviderError>> + Send + 'a>>;

/// Stores a secret the provider just rotated. The refresh already happened, so a failure here
/// is reported without the underlying error, which can name the credential store's paths.
pub(crate) fn save_refreshed(
    account_id: &str,
    secret: ProviderSecret,
) -> Result<(), ProviderError> {
    save_provider_secret(account_id, &secret)
        .map_err(|_| ProviderError::Transient("Unable to save refreshed credentials.".into()))
}

/// Runs `call` with a token that is valid, refreshing it as needed:
///
/// 1. if `secret` expires within `REFRESH_SKEW_SECS`, refresh it first and save it;
/// 2. run `call`; if the provider answers `Auth` (the token was revoked or expired early),
///    refresh once more, save, and run `call` again. A second `Auth` is returned as it is.
///
/// `refresh` and `call` each get their own copy of the secret.
///
/// Returns what `call` produced together with the secret that is now current, which the caller
/// hands back so the next refresh starts from it. `wrap` puts the refreshed secret into the
/// provider's `ProviderSecret` variant for saving.
pub(crate) async fn with_fresh_secret<'c, T>(
    account: &Account,
    secret: OAuthSecret,
    wrap: fn(OAuthSecret) -> ProviderSecret,
    refresh: impl Fn(OAuthSecret) -> SecretFuture<'c, OAuthSecret>,
    call: impl Fn(OAuthSecret) -> SecretFuture<'c, T>,
) -> Result<(T, OAuthSecret), ProviderError> {
    with_fresh_secret_saving(
        secret,
        |fresh| save_refreshed(&account.id, wrap(fresh.clone())),
        refresh,
        call,
    )
    .await
}

/// `with_fresh_secret` with the saving injectable, so tests need no credential store.
async fn with_fresh_secret_saving<'c, T>(
    mut secret: OAuthSecret,
    save: impl Fn(&OAuthSecret) -> Result<(), ProviderError>,
    refresh: impl Fn(OAuthSecret) -> SecretFuture<'c, OAuthSecret>,
    call: impl Fn(OAuthSecret) -> SecretFuture<'c, T>,
) -> Result<(T, OAuthSecret), ProviderError> {
    if secret.expires_within(REFRESH_SKEW_SECS) {
        secret = refresh(secret.clone()).await?;
        save(&secret)?;
    }
    let result = match call(secret.clone()).await {
        Err(ProviderError::Auth) => {
            secret = refresh(secret.clone()).await?;
            save(&secret)?;
            call(secret.clone()).await?
        }
        result => result?,
    };
    Ok((result, secret))
}

/// What an HTTP 403 means for a provider. It differs on purpose: Anthropic's edge answers 403 for
/// bot challenges and regional blocks, so treating it as rejected credentials would suspend the
/// account until the user signs in again (see `anthropic::usage_status_error`), while Google's
/// APIs answer 403 for a token that no longer works.
pub(crate) enum Forbidden<'a> {
    /// The credentials are rejected.
    Auth,
    /// A transient failure with this user-facing message; the cached usage is kept.
    Transient(&'a str),
}

/// How one provider's failing HTTP statuses map to errors.
pub(crate) struct StatusPolicy<'a> {
    pub forbidden: Forbidden<'a>,
    /// Whether a 429 becomes `ProviderError::RateLimited` (with the provider's `Retry-After`).
    /// Providers that never did stay on the generic failure, so their backoff is unchanged.
    pub rate_limits: bool,
    /// The message for any other failing status.
    pub other: Box<dyn Fn(StatusCode) -> String + 'a>,
}

impl<'a> StatusPolicy<'a> {
    /// The policy of a usage endpoint: 429 is rate limiting, and any other failure says
    /// "<provider> usage request returned <status>."
    pub(crate) fn usage(provider: &'a str, forbidden: Forbidden<'a>) -> Self {
        Self {
            forbidden,
            rate_limits: true,
            other: Box::new(move |status| format!("{provider} usage request returned {status}.")),
        }
    }
}

/// Maps a non-success HTTP status to a provider error: 401 always means the credentials are
/// rejected; 403, 429 and everything else follow `policy`. `None` for a success status.
pub(crate) fn classify_status(
    provider: &str,
    status: StatusCode,
    retry_after: Option<&str>,
    policy: &StatusPolicy<'_>,
) -> Option<ProviderError> {
    if status.is_success() {
        return None;
    }
    Some(match status {
        StatusCode::UNAUTHORIZED => ProviderError::Auth,
        StatusCode::FORBIDDEN => match policy.forbidden {
            Forbidden::Auth => ProviderError::Auth,
            Forbidden::Transient(message) => ProviderError::Transient(message.to_string()),
        },
        StatusCode::TOO_MANY_REQUESTS if policy.rate_limits => rate_limited(provider, retry_after),
        other => ProviderError::Transient((policy.other)(other)),
    })
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

    mod fresh_secret {
        use super::super::*;
        use std::sync::atomic::{AtomicUsize, Ordering};

        fn secret(access: &str, expires_in_secs: i64) -> OAuthSecret {
            OAuthSecret {
                access_token: access.into(),
                refresh_token: "refresh".into(),
                id_token: None,
                expires_at: chrono::Utc::now().timestamp_millis() + expires_in_secs * 1000,
            }
        }

        /// Counts refreshes (each yields a token named "fresh-N", valid for an hour), saves and
        /// calls, and answers each call with the next entry of `answers`.
        struct Run {
            refreshes: AtomicUsize,
            saves: AtomicUsize,
            calls: AtomicUsize,
            seen_tokens: parking_lot::Mutex<Vec<String>>,
        }

        impl Run {
            fn new() -> Self {
                Self {
                    refreshes: AtomicUsize::new(0),
                    saves: AtomicUsize::new(0),
                    calls: AtomicUsize::new(0),
                    seen_tokens: parking_lot::Mutex::new(Vec::new()),
                }
            }

            async fn go(
                &self,
                start: OAuthSecret,
                answers: Vec<Result<&'static str, ProviderError>>,
                save_fails: bool,
            ) -> Result<(&'static str, OAuthSecret), ProviderError> {
                let answers = parking_lot::Mutex::new(answers.into_iter());
                with_fresh_secret_saving(
                    start,
                    |_| {
                        self.saves.fetch_add(1, Ordering::SeqCst);
                        if save_fails {
                            Err(ProviderError::Transient(
                                "Unable to save refreshed credentials.".into(),
                            ))
                        } else {
                            Ok(())
                        }
                    },
                    |_| {
                        let n = self.refreshes.fetch_add(1, Ordering::SeqCst) + 1;
                        Box::pin(async move { Ok(secret(&format!("fresh-{n}"), 3600)) })
                    },
                    |current| {
                        self.calls.fetch_add(1, Ordering::SeqCst);
                        self.seen_tokens.lock().push(current.access_token.clone());
                        let answer = answers.lock().next().expect("an answer per call");
                        Box::pin(async move { answer })
                    },
                )
                .await
            }
        }

        #[tokio::test]
        async fn a_valid_token_is_used_as_it_is() {
            let run = Run::new();
            let (value, current) = run
                .go(secret("old", 3600), vec![Ok("usage")], false)
                .await
                .unwrap();
            assert_eq!(value, "usage");
            assert_eq!(current.access_token, "old");
            assert_eq!(run.refreshes.load(Ordering::SeqCst), 0);
            assert_eq!(run.saves.load(Ordering::SeqCst), 0);
            assert_eq!(run.calls.load(Ordering::SeqCst), 1);
        }

        #[tokio::test]
        async fn a_token_about_to_expire_is_refreshed_and_saved_before_the_call() {
            let run = Run::new();
            let (_, current) = run
                .go(
                    secret("old", REFRESH_SKEW_SECS - 1),
                    vec![Ok("usage")],
                    false,
                )
                .await
                .unwrap();
            assert_eq!(current.access_token, "fresh-1");
            assert_eq!(run.refreshes.load(Ordering::SeqCst), 1);
            assert_eq!(run.saves.load(Ordering::SeqCst), 1);
            assert_eq!(*run.seen_tokens.lock(), ["fresh-1"]);
        }

        #[tokio::test]
        async fn an_auth_answer_refreshes_once_and_retries_with_the_new_token() {
            let run = Run::new();
            let (value, current) = run
                .go(
                    secret("old", 3600),
                    vec![Err(ProviderError::Auth), Ok("usage")],
                    false,
                )
                .await
                .unwrap();
            assert_eq!(value, "usage");
            assert_eq!(current.access_token, "fresh-1");
            assert_eq!(*run.seen_tokens.lock(), ["old", "fresh-1"]);
            assert_eq!(run.saves.load(Ordering::SeqCst), 1);
        }

        #[tokio::test]
        async fn a_second_auth_answer_is_returned_without_another_retry() {
            let run = Run::new();
            let result = run
                .go(
                    secret("old", 3600),
                    vec![Err(ProviderError::Auth), Err(ProviderError::Auth)],
                    false,
                )
                .await;
            assert!(matches!(result, Err(ProviderError::Auth)));
            assert_eq!(run.refreshes.load(Ordering::SeqCst), 1);
            assert_eq!(run.calls.load(Ordering::SeqCst), 2);
        }

        #[tokio::test]
        async fn other_errors_are_not_retried() {
            let run = Run::new();
            let result = run
                .go(
                    secret("old", 3600),
                    vec![Err(ProviderError::Transient("boom".into()))],
                    false,
                )
                .await;
            assert!(matches!(result, Err(ProviderError::Transient(ref m)) if m == "boom"));
            assert_eq!(run.refreshes.load(Ordering::SeqCst), 0);
            assert_eq!(run.calls.load(Ordering::SeqCst), 1);
        }

        #[tokio::test]
        async fn a_failed_save_stops_before_the_call() {
            let run = Run::new();
            let result = run.go(secret("old", 1), vec![Ok("usage")], true).await;
            assert!(
                matches!(result, Err(ProviderError::Transient(ref m)) if m.contains("save refreshed"))
            );
            assert_eq!(run.calls.load(Ordering::SeqCst), 0);
        }
    }

    mod status_classes {
        use super::super::*;

        fn usage(forbidden: Forbidden<'static>) -> StatusPolicy<'static> {
            StatusPolicy::usage("Acme", forbidden)
        }

        #[test]
        fn success_is_not_an_error() {
            for status in [StatusCode::OK, StatusCode::NO_CONTENT] {
                assert!(classify_status("Acme", status, None, &usage(Forbidden::Auth)).is_none());
            }
        }

        #[test]
        fn a_401_always_rejects_the_credentials() {
            for forbidden in [Forbidden::Auth, Forbidden::Transient("denied")] {
                assert!(matches!(
                    classify_status("Acme", StatusCode::UNAUTHORIZED, None, &usage(forbidden)),
                    Some(ProviderError::Auth)
                ));
            }
        }

        #[test]
        fn a_403_follows_the_providers_rule() {
            assert!(matches!(
                classify_status("Acme", StatusCode::FORBIDDEN, None, &usage(Forbidden::Auth)),
                Some(ProviderError::Auth)
            ));
            let transient = classify_status(
                "Acme",
                StatusCode::FORBIDDEN,
                None,
                &usage(Forbidden::Transient("Acme denied the usage request.")),
            );
            assert!(matches!(
                transient,
                Some(ProviderError::Transient(ref m)) if m == "Acme denied the usage request."
            ));
        }

        #[test]
        fn a_429_is_rate_limiting_only_where_the_policy_says_so() {
            let limited = classify_status(
                "Acme",
                StatusCode::TOO_MANY_REQUESTS,
                Some("30"),
                &usage(Forbidden::Auth),
            );
            assert!(matches!(
                limited,
                Some(ProviderError::RateLimited { retry_after: Some(d), .. }) if d == Duration::from_secs(30)
            ));

            let mut policy = usage(Forbidden::Auth);
            policy.rate_limits = false;
            let generic =
                classify_status("Acme", StatusCode::TOO_MANY_REQUESTS, Some("30"), &policy);
            assert!(matches!(
                generic,
                Some(ProviderError::Transient(ref m)) if m.contains("429")
            ));
        }

        #[test]
        fn other_failures_use_the_policys_message() {
            let error = classify_status(
                "Acme",
                StatusCode::BAD_GATEWAY,
                None,
                &usage(Forbidden::Auth),
            );
            assert!(matches!(
                error,
                Some(ProviderError::Transient(ref m)) if m == "Acme usage request returned 502 Bad Gateway."
            ));
        }
    }
}

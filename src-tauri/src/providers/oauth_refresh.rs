//! Exchanging a refresh token for a new access token, shared by the OAuth providers (OpenAI,
//! Anthropic, Antigravity, Google AI Studio's Cloud connection).
//!
//! They all follow the same steps and fail the same ways; they differ in a few small, deliberate
//! details, which are spelled out as options on [`RefreshRequest`] rather than hidden.
//!
//! Errors never carry text from the provider's response: a failed refresh says only which
//! provider and which HTTP status, so a token echoed in an error body cannot reach a message.

use super::ProviderError;
use crate::model::OAuthSecret;
use chrono::Utc;
use reqwest::StatusCode;
use serde::Deserialize;

/// How the refresh token is sent.
pub(crate) enum RefreshBody<'a> {
    /// `application/x-www-form-urlencoded` fields.
    Form(&'a [(&'a str, &'a str)]),
    Json(serde_json::Value),
}

/// When a provider's reply means "sign in again" rather than "try again later".
#[derive(Clone, Copy)]
pub(crate) enum InvalidGrant {
    /// `invalid_grant` anywhere in a failed reply, whatever the status.
    AnyStatus,
    /// Only a 400 that says `invalid_grant` (OpenAI); the same text on a 5xx is a server fault.
    BadRequestOnly,
}

/// Whether a reply must say how long the new token lives.
#[derive(Clone, Copy)]
pub(crate) enum Lifetime {
    /// A reply without `expires_in` is malformed.
    Required,
    /// A reply without `expires_in` is valid and the token is assumed to last an hour.
    DefaultsToOneHour,
}

/// Which `id_token` the refreshed secret keeps.
#[derive(Clone, Copy)]
pub(crate) enum IdToken {
    /// Always the one already stored.
    KeepCurrent,
    /// The one in the reply when there is one, otherwise the one already stored.
    PreferNew,
}

pub(crate) struct RefreshRequest<'a> {
    pub client: &'a reqwest::Client,
    /// Named in error messages, e.g. "OpenAI".
    pub provider: &'a str,
    pub url: &'a str,
    pub body: RefreshBody<'a>,
    pub invalid_grant: InvalidGrant,
    pub lifetime: Lifetime,
    pub id_token: IdToken,
}

#[derive(Deserialize)]
struct TokenReply {
    access_token: String,
    refresh_token: Option<String>,
    id_token: Option<String>,
    expires_in: Option<i64>,
}

const DEFAULT_LIFETIME_SECS: i64 = 3600;

fn needs_new_sign_in(status: StatusCode, body: &str, rule: InvalidGrant) -> bool {
    if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN {
        return true;
    }
    let says_invalid_grant = body.to_ascii_lowercase().contains("invalid_grant");
    match rule {
        InvalidGrant::AnyStatus => says_invalid_grant,
        InvalidGrant::BadRequestOnly => status == StatusCode::BAD_REQUEST && says_invalid_grant,
    }
}

/// Sends the refresh request and returns the secret to store (the current one is left untouched): the reply's access token and
/// lifetime, and a rotated refresh token when the provider sent one (otherwise the current one).
pub(crate) async fn refresh_oauth_secret(
    request: RefreshRequest<'_>,
    secret: &OAuthSecret,
) -> Result<OAuthSecret, ProviderError> {
    let provider = request.provider;
    let builder = request.client.post(request.url);
    let builder = match &request.body {
        RefreshBody::Form(fields) => builder.form(fields),
        RefreshBody::Json(value) => builder.json(value),
    };
    let response = builder
        .send()
        .await
        .map_err(|_| ProviderError::Transient(format!("{provider} token refresh failed.")))?;
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if !status.is_success() {
        if needs_new_sign_in(status, &body, request.invalid_grant) {
            return Err(ProviderError::Auth);
        }
        return Err(ProviderError::Transient(format!(
            "{provider} token refresh returned {status}."
        )));
    }
    let invalid =
        || ProviderError::Transient(format!("Invalid {provider} token refresh response."));
    let reply: TokenReply = serde_json::from_str(&body).map_err(|_| invalid())?;
    let lifetime_secs = match (reply.expires_in, request.lifetime) {
        (Some(seconds), _) => seconds,
        (None, Lifetime::DefaultsToOneHour) => DEFAULT_LIFETIME_SECS,
        (None, Lifetime::Required) => return Err(invalid()),
    };
    let id_token = match request.id_token {
        IdToken::KeepCurrent => secret.id_token.clone(),
        IdToken::PreferNew => reply.id_token.or_else(|| secret.id_token.clone()),
    };
    Ok(OAuthSecret {
        access_token: reply.access_token,
        refresh_token: reply
            .refresh_token
            .unwrap_or_else(|| secret.refresh_token.clone()),
        id_token,
        expires_at: Utc::now().timestamp_millis() + lifetime_secs * 1000,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };

    /// Answers one request with `status` and `body`, and returns what it received.
    async fn serve_once(
        status: u16,
        body: &'static str,
    ) -> (String, tokio::task::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/token", listener.local_addr().unwrap());
        let handle = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut received = Vec::new();
            let mut buffer = [0u8; 4096];
            loop {
                let read = socket.read(&mut buffer).await.unwrap();
                received.extend_from_slice(&buffer[..read]);
                let text = String::from_utf8_lossy(&received);
                if let Some(split) = text.find("\r\n\r\n") {
                    let length = text[..split]
                        .lines()
                        .find_map(|line| {
                            line.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .map(|v| v.trim().parse::<usize>().unwrap())
                        })
                        .unwrap_or(0);
                    if received.len() >= split + 4 + length {
                        break;
                    }
                }
                if read == 0 {
                    break;
                }
            }
            let reply = format!(
                "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            socket.write_all(reply.as_bytes()).await.unwrap();
            String::from_utf8_lossy(&received).to_string()
        });
        (url, handle)
    }

    fn secret() -> OAuthSecret {
        OAuthSecret {
            access_token: "old-access".into(),
            refresh_token: "old-refresh".into(),
            id_token: Some("old-id".into()),
            expires_at: 0,
        }
    }

    const FORM: &[(&str, &str)] = &[
        ("grant_type", "refresh_token"),
        ("refresh_token", "old-refresh"),
    ];

    async fn run(
        status: u16,
        body: &'static str,
        invalid_grant: InvalidGrant,
        lifetime: Lifetime,
        id_token: IdToken,
    ) -> Result<OAuthSecret, ProviderError> {
        let (url, _server) = serve_once(status, body).await;
        let client = reqwest::Client::new();
        refresh_oauth_secret(
            RefreshRequest {
                client: &client,
                provider: "Acme",
                url: &url,
                body: RefreshBody::Form(FORM),
                invalid_grant,
                lifetime,
                id_token,
            },
            &secret(),
        )
        .await
    }

    async fn ok(body: &'static str, lifetime: Lifetime, id_token: IdToken) -> OAuthSecret {
        run(200, body, InvalidGrant::AnyStatus, lifetime, id_token)
            .await
            .unwrap()
    }

    fn message(error: ProviderError) -> String {
        match error {
            ProviderError::Transient(text) => text,
            other => panic!("expected a transient error, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn a_good_reply_replaces_the_access_token_and_extends_the_lifetime() {
        let before = Utc::now().timestamp_millis();
        let secret = ok(
            r#"{"access_token":"new","expires_in":120}"#,
            Lifetime::Required,
            IdToken::KeepCurrent,
        )
        .await;
        assert_eq!(secret.access_token, "new");
        assert!(secret.expires_at >= before + 120_000 && secret.expires_at < before + 125_000);
    }

    #[tokio::test]
    async fn a_rotated_refresh_token_replaces_the_old_one_and_otherwise_it_is_kept() {
        let rotated = ok(
            r#"{"access_token":"a","refresh_token":"new-refresh","expires_in":1}"#,
            Lifetime::Required,
            IdToken::KeepCurrent,
        )
        .await;
        assert_eq!(rotated.refresh_token, "new-refresh");
        let kept = ok(
            r#"{"access_token":"a","expires_in":1}"#,
            Lifetime::Required,
            IdToken::KeepCurrent,
        )
        .await;
        assert_eq!(kept.refresh_token, "old-refresh");
    }

    #[tokio::test]
    async fn the_id_token_follows_the_chosen_policy() {
        let body = r#"{"access_token":"a","id_token":"new-id","expires_in":1}"#;
        assert_eq!(
            ok(body, Lifetime::Required, IdToken::KeepCurrent)
                .await
                .id_token
                .as_deref(),
            Some("old-id")
        );
        assert_eq!(
            ok(body, Lifetime::Required, IdToken::PreferNew)
                .await
                .id_token
                .as_deref(),
            Some("new-id")
        );
        let without = r#"{"access_token":"a","expires_in":1}"#;
        assert_eq!(
            ok(without, Lifetime::Required, IdToken::PreferNew)
                .await
                .id_token
                .as_deref(),
            Some("old-id")
        );
    }

    #[tokio::test]
    async fn a_missing_lifetime_is_an_error_or_an_hour_depending_on_the_provider() {
        let body = r#"{"access_token":"a"}"#;
        let required = run(
            200,
            body,
            InvalidGrant::AnyStatus,
            Lifetime::Required,
            IdToken::KeepCurrent,
        )
        .await;
        assert_eq!(
            message(required.unwrap_err()),
            "Invalid Acme token refresh response."
        );
        let before = Utc::now().timestamp_millis();
        let defaulted = ok(body, Lifetime::DefaultsToOneHour, IdToken::KeepCurrent).await;
        assert!(
            defaulted.expires_at >= before + 3_600_000 && defaulted.expires_at < before + 3_605_000
        );
    }

    #[tokio::test]
    async fn unauthorized_and_forbidden_always_mean_sign_in_again() {
        for status in [401, 403] {
            for rule in [InvalidGrant::AnyStatus, InvalidGrant::BadRequestOnly] {
                let result =
                    run(status, "{}", rule, Lifetime::Required, IdToken::KeepCurrent).await;
                assert!(matches!(result, Err(ProviderError::Auth)), "{status}");
            }
        }
    }

    #[tokio::test]
    async fn invalid_grant_on_a_bad_request_means_sign_in_again_for_both_rules() {
        let body = r#"{"error":"invalid_grant"}"#;
        for rule in [InvalidGrant::AnyStatus, InvalidGrant::BadRequestOnly] {
            let result = run(400, body, rule, Lifetime::Required, IdToken::KeepCurrent).await;
            assert!(matches!(result, Err(ProviderError::Auth)));
        }
    }

    #[tokio::test]
    async fn invalid_grant_on_a_server_error_only_counts_when_the_provider_says_so() {
        let body = r#"{"error":"INVALID_GRANT"}"#;
        let any = run(
            500,
            body,
            InvalidGrant::AnyStatus,
            Lifetime::Required,
            IdToken::KeepCurrent,
        )
        .await;
        assert!(matches!(any, Err(ProviderError::Auth)));
        let strict = run(
            500,
            body,
            InvalidGrant::BadRequestOnly,
            Lifetime::Required,
            IdToken::KeepCurrent,
        )
        .await;
        assert!(message(strict.unwrap_err()).starts_with("Acme token refresh returned 500"));
    }

    #[tokio::test]
    async fn other_failures_name_the_provider_and_status_only() {
        let result = run(
            503,
            r#"{"access_token":"leaked-secret-value"}"#,
            InvalidGrant::AnyStatus,
            Lifetime::Required,
            IdToken::KeepCurrent,
        )
        .await;
        let text = message(result.unwrap_err());
        assert_eq!(text, "Acme token refresh returned 503 Service Unavailable.");
        assert!(!text.contains("leaked"));
    }

    #[tokio::test]
    async fn an_unreadable_success_reply_is_reported_without_its_contents() {
        let result = run(
            200,
            "not json with secret-xyz",
            InvalidGrant::AnyStatus,
            Lifetime::Required,
            IdToken::KeepCurrent,
        )
        .await;
        let text = message(result.unwrap_err());
        assert_eq!(text, "Invalid Acme token refresh response.");
        assert!(!text.contains("secret-xyz"));
    }

    #[tokio::test]
    async fn an_unreachable_provider_is_a_transient_failure() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/token", listener.local_addr().unwrap());
        drop(listener);
        let client = reqwest::Client::new();
        let result = refresh_oauth_secret(
            RefreshRequest {
                client: &client,
                provider: "Acme",
                url: &url,
                body: RefreshBody::Form(FORM),
                invalid_grant: InvalidGrant::AnyStatus,
                lifetime: Lifetime::Required,
                id_token: IdToken::KeepCurrent,
            },
            &secret(),
        )
        .await;
        assert_eq!(message(result.unwrap_err()), "Acme token refresh failed.");
    }

    #[tokio::test]
    async fn the_form_and_json_bodies_are_sent_as_given() {
        let (url, server) = serve_once(200, r#"{"access_token":"a","expires_in":1}"#).await;
        let client = reqwest::Client::new();
        refresh_oauth_secret(
            RefreshRequest {
                client: &client,
                provider: "Acme",
                url: &url,
                body: RefreshBody::Form(FORM),
                invalid_grant: InvalidGrant::AnyStatus,
                lifetime: Lifetime::Required,
                id_token: IdToken::KeepCurrent,
            },
            &secret(),
        )
        .await
        .unwrap();
        let sent = server.await.unwrap();
        assert!(sent.contains("grant_type=refresh_token&refresh_token=old-refresh"));
        assert!(sent
            .to_ascii_lowercase()
            .contains("application/x-www-form-urlencoded"));

        let (url, server) = serve_once(200, r#"{"access_token":"a","expires_in":1}"#).await;
        refresh_oauth_secret(
            RefreshRequest {
                client: &client,
                provider: "Acme",
                url: &url,
                body: RefreshBody::Json(serde_json::json!({"grant_type": "refresh_token", "refresh_token": "old-refresh"})),
                invalid_grant: InvalidGrant::AnyStatus,
                lifetime: Lifetime::Required,
                id_token: IdToken::KeepCurrent,
            },
            &secret(),
        )
        .await
        .unwrap();
        let sent = server.await.unwrap();
        assert!(sent.to_ascii_lowercase().contains("application/json"));
        assert!(sent.contains(r#""refresh_token":"old-refresh""#));
    }
}

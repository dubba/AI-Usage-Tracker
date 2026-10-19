use super::*;

/// Why an authorization code could not be exchanged for tokens.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum ExchangeError {
    /// The provider could not be reached, or did not answer in time. The same code is still good,
    /// so the exchange is worth retrying.
    Unreachable(String),
    /// The provider refused or answered badly, or something local failed. Retrying cannot help.
    Failed(String),
}

pub(super) type ExchangeResult<T> = Result<T, ExchangeError>;

impl From<String> for ExchangeError {
    fn from(message: String) -> Self {
        Self::Failed(message)
    }
}

impl From<&str> for ExchangeError {
    fn from(message: &str) -> Self {
        Self::Failed(message.to_string())
    }
}

impl ExchangeError {
    pub(super) fn message(&self) -> &str {
        match self {
            Self::Unreachable(message) | Self::Failed(message) => message,
        }
    }

    pub(super) fn into_message(self) -> String {
        match self {
            Self::Unreachable(message) | Self::Failed(message) => message,
        }
    }

    pub(super) fn is_retryable(&self) -> bool {
        matches!(self, Self::Unreachable(_))
    }

    /// A request that never got an answer. The message names the whole cause chain, so a failure
    /// can be told apart from the user's side (no network, DNS, a firewall).
    pub(super) fn from_send(prefix: &str, error: &reqwest::Error) -> Self {
        use std::error::Error;
        let mut message = format!("{prefix}: {error}");
        let mut current: Option<&(dyn Error + 'static)> = error.source();
        while let Some(source) = current {
            message.push_str(&format!(" -> {source}"));
            current = source.source();
        }
        if error.is_connect() || error.is_timeout() || looks_unreachable(&message) {
            Self::Unreachable(message)
        } else {
            Self::Failed(message)
        }
    }

    /// The provider answered with a non-success status. Only a gateway or request timeout (408,
    /// 504) says the answer may simply be late.
    pub(super) fn from_status(message: String, status: reqwest::StatusCode) -> Self {
        if matches!(status.as_u16(), 408 | 504) {
            Self::Unreachable(message)
        } else {
            Self::Failed(message)
        }
    }
}

/// Wording the network stack uses for "could not get through" that reqwest does not flag itself
/// (for example a connection reset partway through the request).
pub(super) fn looks_unreachable(message: &str) -> bool {
    let lower = message.to_lowercase();
    [
        "dns error",
        "connect",
        "no address associated",
        "network is unreachable",
        "timed out",
        "timeout",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
}

/// Picks the stored account a finished sign-in should update.
pub(super) fn find_account_to_update(
    context: &LoginContext,
    identity: &ProviderIdentity,
) -> Option<Account> {
    context.app.store.account_to_update(
        &context.provider,
        context.reconnect_account_id.as_deref(),
        identity.account_id.as_deref(),
        identity.email.as_deref(),
    )
}

pub(super) async fn complete_exchange(
    context: &LoginContext,
    code: &str,
) -> ExchangeResult<Account> {
    let mut last_error: Option<ExchangeError> = None;
    let mut exchanged = None;
    for attempt in 0..5 {
        if !context.app.login_is_waiting(&context.attempt_id) {
            return Err("The login attempt was canceled.".into());
        }
        match exchange_tokens(context, code).await {
            Ok(res) => {
                exchanged = Some(res);
                break;
            }
            Err(err) => {
                let retry = attempt < 4 && err.is_retryable();
                last_error = Some(err);
                if retry {
                    tokio::time::sleep(std::time::Duration::from_millis(600)).await;
                } else {
                    break;
                }
            }
        }
    }
    let (secret, identity) = match (exchanged, last_error) {
        (Some(res), _) => res,
        (None, Some(error)) => return Err(error),
        (None, None) => return Err("The token exchange did not run.".into()),
    };
    if !context.app.login_is_waiting(&context.attempt_id) {
        return Err("The login attempt was canceled.".into());
    }
    let duplicate = find_account_to_update(context, &identity);
    let label = if context.label.trim().is_empty() {
        identity
            .email
            .clone()
            .unwrap_or_else(|| context.provider.display_name().to_string())
    } else {
        context.label.trim().to_string()
    };
    let provider_account_id = identity.account_id.clone().or_else(|| {
        duplicate
            .as_ref()
            .and_then(|account| account.provider_account_id.clone())
    });
    let chatgpt_account_id = if context.provider == Provider::Openai {
        provider_account_id.clone().or_else(|| {
            duplicate
                .as_ref()
                .and_then(|account| account.chatgpt_account_id.clone())
        })
    } else {
        None
    };
    let account = merge_into_existing(
        duplicate.as_ref(),
        ConnectedFields {
            label,
            provider: context.provider.clone(),
            email: identity
                .email
                .or_else(|| duplicate.as_ref().and_then(|account| account.email.clone())),
            provider_account_id,
            chatgpt_account_id,
            plan: identity
                .plan
                .or_else(|| duplicate.as_ref().and_then(|account| account.plan.clone())),
        },
    );
    if !context.app.login_is_waiting(&context.attempt_id) {
        return Err("The login attempt was canceled.".into());
    }
    let account = context
        .app
        .persist_connected_account(account, &secret)
        .await
        .map_err(|error| error.to_string())?;
    let mut pending = context.app.pending_login.write();
    if pending
        .as_ref()
        .is_some_and(|login| login.attempt_id == context.attempt_id)
    {
        *pending = Some(LoginStatus::complete(
            context.attempt_id.clone(),
            account.clone(),
        ));
    }
    let refresh_app = context.app.clone();
    let refresh_account_id = account.id.clone();
    let refresh_attempt_id = context.attempt_id.clone();
    tauri::async_runtime::spawn(async move {
        if let Ok(refreshed) =
            crate::usage::refresh_account(refresh_app.clone(), &refresh_account_id).await
        {
            refresh_app.update_login_account(&refresh_attempt_id, refreshed);
        }
    });
    Ok(account)
}

pub(super) async fn exchange_tokens(
    context: &LoginContext,
    code: &str,
) -> ExchangeResult<(ProviderSecret, ProviderIdentity)> {
    match context.provider {
        Provider::Openai => exchange_openai(context, code).await,
        Provider::Anthropic => exchange_anthropic(context, code).await,
        Provider::Antigravity => exchange_antigravity(context, code).await,
        Provider::GoogleAiStudio => {
            Err("Google AI Studio usage uses its dedicated Google Cloud authorization flow.".into())
        }
        Provider::Grok => Err("Grok uses the official Grok Build CLI login flow.".into()),
        Provider::OpencodeGo => Err("OpenCode Go does not use OAuth.".into()),
    }
}

pub(super) async fn exchange_openai(
    context: &LoginContext,
    code: &str,
) -> ExchangeResult<(ProviderSecret, ProviderIdentity)> {
    let response = context
        .app
        .client
        .post(OPENAI_TOKEN_URL)
        .form(&[
            ("grant_type", "authorization_code"),
            ("client_id", OPENAI_CLIENT_ID),
            ("code", code),
            ("code_verifier", context.verifier.as_str()),
            ("redirect_uri", context.redirect_uri.as_str()),
        ])
        .send()
        .await
        .map_err(|error| ExchangeError::from_send("OpenAI token exchange failed", &error))?;
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(ExchangeError::from_status(
            format!("OpenAI token exchange failed ({status})."),
            status,
        ));
    }
    let tokens: OAuthTokenResponse =
        serde_json::from_str(&body).map_err(|_| String::from("Invalid OpenAI token response."))?;
    // Unlike the other providers, OpenAI always reports a lifetime; a response without one is malformed.
    let expires_in = tokens
        .expires_in
        .ok_or_else(|| "Invalid OpenAI token response: missing field `expires_in`".to_string())?;
    let refresh_token = tokens
        .refresh_token
        .clone()
        .ok_or_else(|| "OpenAI did not return a refresh token.".to_string())?;
    let userinfo = fetch_json(
        &context.app,
        &format!("{OPENAI_ISSUER}/userinfo"),
        &tokens.access_token,
    )
    .await
    .unwrap_or(Value::Null);
    let mut identity = identity_from_userinfo(&userinfo);
    if let Some(claims) = tokens.id_token.as_deref().and_then(decode_claims) {
        identity.email = identity.email.or(claims.email);
        identity.account_id = identity.account_id.or(claims.account_id);
        identity.plan = identity.plan.or(claims.plan);
    }
    Ok((
        ProviderSecret::Openai(OAuthSecret {
            access_token: tokens.access_token,
            refresh_token,
            id_token: tokens.id_token,
            expires_at: Utc::now().timestamp_millis() + expires_in * 1000,
        }),
        identity,
    ))
}

pub(super) async fn exchange_anthropic(
    context: &LoginContext,
    code: &str,
) -> ExchangeResult<(ProviderSecret, ProviderIdentity)> {
    let response = context
        .app
        .client
        .post(ANTHROPIC_TOKEN_URL)
        .json(&json!({
            "grant_type": "authorization_code",
            "client_id": ANTHROPIC_CLIENT_ID,
            "code": code,
            "state": context.expected_state.clone(),
            "redirect_uri": context.redirect_uri.clone(),
            "code_verifier": context.verifier.clone(),
        }))
        .send()
        .await
        .map_err(|error| ExchangeError::from_send("Anthropic token exchange failed", &error))?;
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(ExchangeError::from_status(
            format!("Anthropic token exchange failed ({status})."),
            status,
        ));
    }
    let token_json: Value = serde_json::from_str(&body)
        .map_err(|_| String::from("Invalid Anthropic token response."))?;
    let tokens: OAuthTokenResponse = serde_json::from_value(token_json.clone())
        .map_err(|_| String::from("Invalid Anthropic token response."))?;
    let refresh_token = tokens
        .refresh_token
        .clone()
        .ok_or_else(|| "Anthropic did not return a refresh token.".to_string())?;
    let profile = fetch_anthropic_profile(&context.app, &tokens.access_token)
        .await
        .unwrap_or(Value::Null);
    let identity = anthropic_identity(&profile, &token_json);
    Ok((
        ProviderSecret::Anthropic(OAuthSecret {
            access_token: tokens.access_token,
            refresh_token,
            id_token: tokens.id_token,
            expires_at: Utc::now().timestamp_millis() + tokens.expires_in.unwrap_or(3600) * 1000,
        }),
        identity,
    ))
}

pub(super) async fn exchange_antigravity(
    context: &LoginContext,
    code: &str,
) -> ExchangeResult<(ProviderSecret, ProviderIdentity)> {
    let client_secret = client_secret();
    let response = context
        .app
        .client
        .post(GOOGLE_TOKEN_URL)
        .form(&[
            ("client_id", CLIENT_ID),
            ("client_secret", client_secret.as_str()),
            ("code", code),
            ("redirect_uri", context.redirect_uri.as_str()),
            ("grant_type", "authorization_code"),
            ("code_verifier", context.verifier.as_str()),
        ])
        .send()
        .await
        .map_err(|error| ExchangeError::from_send("Google token exchange failed", &error))?;
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(ExchangeError::from_status(
            format!("Google token exchange failed ({status})."),
            status,
        ));
    }
    let tokens: OAuthTokenResponse =
        serde_json::from_str(&body).map_err(|_| String::from("Invalid Google token response."))?;
    let refresh_token = tokens.refresh_token.clone().ok_or_else(|| {
        "Google did not return a refresh token. Revoke access and try again.".to_string()
    })?;
    let profile = fetch_json(
        &context.app,
        "https://www.googleapis.com/oauth2/v2/userinfo",
        &tokens.access_token,
    )
    .await
    .unwrap_or(Value::Null);
    // Identity comes from Google's userinfo API (TLS + bearer token), never
    // from decoded-but-unverified ID-token claims.
    let identity = identity_from_google_userinfo(&profile);
    Ok((
        ProviderSecret::Antigravity(OAuthSecret {
            access_token: tokens.access_token,
            refresh_token,
            id_token: tokens.id_token,
            expires_at: Utc::now().timestamp_millis() + tokens.expires_in.unwrap_or(3600) * 1000,
        }),
        identity,
    ))
}

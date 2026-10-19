// Grok billing integration is adapted from the MIT-licensed CodexBar Grok
// provider and the MIT-licensed Grok Rate Limit Display userscript. The live
// path uses the same grok.com billing request as Grok's own Usage page. The
// tracker never reads the Grok Build CLI's ~/.grok/auth.json credentials.
// No message or token allowance is estimated.

use super::{ProviderError, ProviderUsage};
use crate::{
    model::{Account, GrokSecret, ProviderSecret, UsageWindow},
    state::AppState,
    store::save_provider_secret,
};
use base64::{
    engine::general_purpose::{URL_SAFE, URL_SAFE_NO_PAD},
    Engine,
};
use chrono::{DateTime, TimeZone, Utc};
use futures_util::{SinkExt, StreamExt};
use reqwest::{header, StatusCode};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::time::Duration;
use tokio_tungstenite::tungstenite::{
    client::IntoClientRequest,
    http::{header as ws_header, HeaderValue},
    protocol::WebSocketConfig,
    Message,
};

mod billing;
mod bot;

use billing::*;
pub(crate) use bot::*;

const MAX_COOKIE_HEADER_BYTES: usize = 32 * 1024;
pub(crate) const GROK_COOKIE_URLS: &[&str] = &[
    "https://grok.com/",
    "https://grok.com/?_s=usage",
    "https://accounts.x.ai/",
];

fn percent_decode(input: &str) -> String {
    let mut bytes = Vec::with_capacity(input.len());
    let mut chars = input.bytes();
    while let Some(b) = chars.next() {
        if b == b'%' {
            let h1 = chars.next();
            let h2 = chars.next();
            if let (Some(h1), Some(h2)) = (h1, h2) {
                let hex_str = [h1, h2];
                if let Ok(hex_str) = std::str::from_utf8(&hex_str) {
                    if let Ok(val) = u8::from_str_radix(hex_str, 16) {
                        bytes.push(val);
                        continue;
                    }
                }
            }
        }
        bytes.push(b);
    }
    String::from_utf8_lossy(&bytes).into_owned()
}

pub(crate) fn extract_identity_from_jwt(token: &str) -> Option<String> {
    let segment = token.split('.').nth(1)?;
    let decoded = URL_SAFE_NO_PAD
        .decode(segment)
        .or_else(|_| URL_SAFE.decode(segment))
        .or_else(|_| {
            let padded = match segment.len() % 4 {
                2 => format!("{segment}=="),
                3 => format!("{segment}="),
                _ => segment.to_string(),
            };
            URL_SAFE_NO_PAD
                .decode(padded.as_bytes())
                .or_else(|_| URL_SAFE.decode(padded.as_bytes()))
        })
        .ok()?;
    let value: Value = serde_json::from_slice(&decoded).ok()?;
    find_identity_in_json(&value)
}

pub(crate) fn find_identity_in_json(value: &Value) -> Option<String> {
    // 1. Email addresses (highest priority)
    for key in &["email", "email_address", "user_email", "mail"] {
        if let Some(s) = value.get(*key).and_then(Value::as_str) {
            let s = s.trim();
            if !s.is_empty() && s.contains('@') {
                return Some(s.to_string());
            }
        }
    }
    // 2. User handles / usernames / names
    for key in &["preferred_username", "username", "screen_name", "handle"] {
        if let Some(s) = value.get(*key).and_then(Value::as_str) {
            let s = s.trim();
            if !s.is_empty()
                && !s.eq_ignore_ascii_case("grok")
                && !s.eq_ignore_ascii_case("user")
                && !s.eq_ignore_ascii_case("supergrok")
            {
                if s.contains('@') {
                    return Some(s.to_string());
                }
                return Some(if s.starts_with('@') {
                    s.to_string()
                } else {
                    format!("@{s}")
                });
            }
        }
    }
    // 3. Search nested objects
    for obj_key in &[
        "user", "data", "profile", "account", "session", "claims", "identity",
    ] {
        if let Some(obj) = value.get(*obj_key) {
            if let Some(identity) = find_identity_in_json(obj) {
                return Some(identity);
            }
        }
    }
    None
}

pub(crate) fn extract_identity_from_cookies(cookie_header: &str) -> Option<String> {
    for part in cookie_header.split(';') {
        let trimmed = part.trim();
        let Some((key, val)) = trimmed.split_once('=') else {
            continue;
        };
        let key = key.trim();
        let val = val.trim();
        let decoded = percent_decode(val);

        if (key.eq_ignore_ascii_case("email") || key.eq_ignore_ascii_case("user_email"))
            && (val.contains('@') || decoded.contains('@'))
        {
            if decoded.contains('@') {
                return Some(decoded.trim().to_string());
            }
            return Some(val.to_string());
        }

        if val.contains('.') || decoded.contains('.') {
            if let Some(identity) =
                extract_identity_from_jwt(val).or_else(|| extract_identity_from_jwt(&decoded))
            {
                return Some(identity);
            }
        }

        if (key.eq_ignore_ascii_case("username") || key.eq_ignore_ascii_case("screen_name"))
            && !decoded.is_empty()
            && !decoded.eq_ignore_ascii_case("grok")
        {
            return Some(if decoded.starts_with('@') {
                decoded
            } else {
                format!("@{decoded}")
            });
        }
    }
    None
}

pub(crate) async fn fetch_grok_user_email(app: &AppState, cookie_header: &str) -> Option<String> {
    if let Some(identity) = extract_identity_from_cookies(cookie_header) {
        return Some(identity);
    }

    let endpoints = [
        "https://grok.com/rest/app-chat/users/me",
        "https://accounts.x.ai/api/auth/session",
        "https://grok.com/api/auth/session",
        "https://grok.com/api/users/me",
    ];

    for endpoint in endpoints {
        if let Ok(response) = app
            .client
            .get(endpoint)
            .header(header::COOKIE, cookie_header)
            .header(header::ACCEPT, "application/json")
            .header(header::ORIGIN, "https://grok.com")
            .header(header::REFERER, "https://grok.com/")
            .send()
            .await
        {
            if response.status().is_success() {
                if let Ok(body) = response.json::<Value>().await {
                    if let Some(identity) = find_identity_in_json(&body) {
                        return Some(identity);
                    }
                }
            }
        }
    }

    None
}

#[derive(Debug)]
enum GrokFetchError {
    Auth,
    TeamUnavailable,
    Unavailable,
}

impl GrokFetchError {
    fn into_provider_error(self) -> ProviderError {
        match self {
            Self::Auth => ProviderError::Auth,
            Self::TeamUnavailable => ProviderError::Transient(
                "Grok team usage is unavailable from the current billing surface.".into(),
            ),
            Self::Unavailable => {
                ProviderError::Transient("Grok did not provide current billing usage.".into())
            }
        }
    }
}

pub async fn refresh(
    app: &AppState,
    account: &Account,
    secret: &GrokSecret,
) -> Result<(ProviderUsage, GrokSecret), ProviderError> {
    let secret = recapture_stored_cookies(&account.id, secret)?;

    let Some(cookie_header) = secret
        .cookie_header
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    else {
        return Err(ProviderError::Auth);
    };

    let discovered_email = if account.email.is_none() {
        fetch_grok_user_email(app, cookie_header).await
    } else {
        None
    };

    // Grok Bot usage is optional: it runs beside the billing request so it adds
    // no latency, and any failure leaves the SuperGrok window untouched.
    let (billing, bot) = tokio::join!(
        fetch_web_billing(app, cookie_header),
        fetch_bot_usage(cookie_header)
    );
    match billing {
        Ok(snapshot) => {
            let mut usage = usage_from_snapshot(account, snapshot, bot);
            if usage.email.is_none() {
                usage.email = discovered_email.or_else(|| account.email.clone());
            }
            Ok((usage, secret))
        }
        Err(error) => Err(error.into_provider_error()),
    }
}

pub async fn probe_cookie(
    app: &AppState,
    cookie_header: &str,
) -> Result<ProviderUsage, ProviderError> {
    let cookie_header = normalize_cookie_header(cookie_header).map_err(ProviderError::Transient)?;
    let (billing, bot) = tokio::join!(
        fetch_web_billing(app, &cookie_header),
        fetch_bot_usage(&cookie_header)
    );
    let snapshot = match billing {
        Ok(snapshot) => snapshot,
        Err(error) => return Err(error.into_provider_error()),
    };
    let discovered_email = fetch_grok_user_email(app, &cookie_header).await;
    let mut usage = usage_from_snapshot(
        &Account {
            id: String::new(),
            label: "Grok".into(),
            provider: crate::model::Provider::Grok,
            email: discovered_email.clone(),
            provider_account_id: Some("grok-browser-session".into()),
            chatgpt_account_id: None,
            plan: Some("Grok".into()),
            created_at: String::new(),
            updated_at: String::new(),
            last_usage: None,
            last_error: None,
            auth_required: false,
        },
        snapshot,
        bot,
    );
    if usage.email.is_none() {
        usage.email = discovered_email;
    }
    Ok(usage)
}

pub(crate) fn is_allowed_cookie_host(host: &str) -> bool {
    let host = host.trim().trim_end_matches('.').to_ascii_lowercase();
    host == "grok.com" || host.ends_with(".grok.com") || host == "accounts.x.ai"
}

pub(crate) fn has_grok_session_cookie(header: &str) -> bool {
    header.split(';').any(|part| {
        part.split_once('=')
            .is_some_and(|(name, value)| !value.trim().is_empty() && is_session_cookie_name(name))
    })
}

fn recapture_stored_cookies(
    account_id: &str,
    secret: &GrokSecret,
) -> Result<GrokSecret, ProviderError> {
    let Some(raw) = secret
        .cookie_header
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok(secret.clone());
    };

    let next = match normalize_cookie_header(raw) {
        Ok(cookie_header) => GrokSecret {
            cookie_header: Some(cookie_header),
        },
        Err(_) => GrokSecret {
            cookie_header: None,
        },
    };

    if &next != secret {
        let _ = save_provider_secret(account_id, &ProviderSecret::Grok(next.clone()));
    }
    if next.cookie_header.is_none() {
        return Err(ProviderError::Auth);
    }
    Ok(next)
}

fn is_session_cookie_name(name: &str) -> bool {
    let name = canonical_cookie_name(name);
    matches!(
        name.as_str(),
        "sso" | "sso-token" | "sso_token" | "auth_token" | "jwt" | "session"
    ) || name.starts_with("sso-")
        || name.starts_with("sso_")
}

fn is_allowed_grok_cookie_name(name: &str) -> bool {
    is_session_cookie_name(name)
}

fn canonical_cookie_name(name: &str) -> String {
    let trimmed = name.trim();
    let without_prefix = trimmed
        .strip_prefix("__Host-")
        .or_else(|| trimmed.strip_prefix("__Secure-"))
        .or_else(|| trimmed.strip_prefix("__host-"))
        .or_else(|| trimmed.strip_prefix("__secure-"))
        .unwrap_or(trimmed);
    without_prefix.to_ascii_lowercase()
}

pub(crate) fn normalize_cookie_header(value: &str) -> Result<String, String> {
    if value.contains(['\r', '\n']) {
        return Err("The Grok browser session contains invalid header characters.".into());
    }
    let value = value.trim().strip_prefix("Cookie:").unwrap_or(value.trim());
    let mut pairs = BTreeMap::new();
    for part in value.split(';') {
        let Some((name, cookie_value)) = part.split_once('=') else {
            continue;
        };
        let name = name.trim();
        let cookie_value = cookie_value.trim();
        if name.is_empty() || cookie_value.is_empty() || !is_allowed_grok_cookie_name(name) {
            continue;
        }
        pairs.insert(name.to_string(), cookie_value.to_string());
    }
    if pairs.is_empty() {
        return Err("No Grok browser session cookies were found.".into());
    }
    let normalized = pairs
        .into_iter()
        .map(|(name, value)| format!("{name}={value}"))
        .collect::<Vec<_>>()
        .join("; ");
    if normalized.len() > MAX_COOKIE_HEADER_BYTES {
        return Err("The Grok browser session is unexpectedly large. Sign out of Grok, sign in again, and retry.".into());
    }
    Ok(normalized)
}

#[cfg(test)]
mod tests;

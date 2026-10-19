use super::*;

#[derive(Clone, Debug, Default)]
pub(super) struct ProviderIdentity {
    pub(super) email: Option<String>,
    pub(super) account_id: Option<String>,
    pub(super) plan: Option<String>,
}

pub(super) async fn fetch_json(
    app: &AppState,
    url: &str,
    access_token: &str,
) -> Result<Value, String> {
    fetch_json_with_headers(app, url, access_token, &[]).await
}

pub(super) async fn fetch_json_with_headers(
    app: &AppState,
    url: &str,
    access_token: &str,
    headers: &[(&str, &str)],
) -> Result<Value, String> {
    let mut request = app.client.get(url).bearer_auth(access_token);
    for (name, value) in headers {
        request = request.header(*name, *value);
    }
    let response = request
        .send()
        .await
        .map_err(|error| format!("Profile request failed: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("Profile request returned {}.", response.status()));
    }
    response
        .json()
        .await
        .map_err(|_| String::from("Invalid profile response."))
}

/// Decodes the payload segment of a JWT without verifying the signature.
/// Claims from this helper are informational only and must not be used as
/// authentication identity.
#[cfg(test)]
pub(super) fn decode_jwt_payload(token: &str) -> Option<Value> {
    let segment = token.split('.').nth(1)?;
    let decoded = URL_SAFE_NO_PAD.decode(segment).ok()?;
    serde_json::from_slice(&decoded).ok()
}

pub(super) fn identity_from_google_userinfo(profile: &Value) -> ProviderIdentity {
    ProviderIdentity {
        email: profile
            .get("email")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .map(str::to_string),
        account_id: profile
            .get("id")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .map(str::to_string),
        plan: Some("Antigravity".into()),
    }
}

pub(super) async fn fetch_anthropic_profile(
    app: &AppState,
    access_token: &str,
) -> Result<Value, String> {
    const PROFILE_URL: &str = "https://api.anthropic.com/api/oauth/profile";
    const LEGACY_PROFILE_URL: &str = "https://api.anthropic.com/api/auth/oauth/profile";
    const HEADERS: &[(&str, &str)] = &[("anthropic-beta", "oauth-2025-04-20")];
    match fetch_json_with_headers(app, PROFILE_URL, access_token, HEADERS).await {
        Ok(profile) => Ok(profile),
        Err(_) => fetch_json_with_headers(app, LEGACY_PROFILE_URL, access_token, HEADERS).await,
    }
}

pub(super) fn anthropic_identity(profile: &Value, token: &Value) -> ProviderIdentity {
    ProviderIdentity {
        email: crate::providers::anthropic::email_from_profile(profile)
            .or_else(|| crate::providers::anthropic::email_from_profile(token)),
        account_id: crate::providers::anthropic::account_id_from_profile(profile)
            .or_else(|| crate::providers::anthropic::account_id_from_profile(token)),
        plan: crate::providers::anthropic::plan_from_profile(profile),
    }
}

pub(super) fn identity_from_userinfo(value: &Value) -> ProviderIdentity {
    ProviderIdentity {
        email: find_string(value, &["email", "email_address"]),
        account_id: find_string(value, &["chatgpt_account_id", "account_id", "sub"]),
        plan: find_string(value, &["chatgpt_plan_type", "plan_type", "plan"]),
    }
}

pub(super) fn decode_claims(token: &str) -> Option<TokenClaims> {
    let segment = token.split('.').nth(1)?;
    let decoded = URL_SAFE_NO_PAD.decode(segment).ok()?;
    let value: Value = serde_json::from_slice(&decoded).ok()?;
    let auth = value.get("https://api.openai.com/auth");
    let email =
        string_at(&value, "email").or_else(|| auth.and_then(|value| string_at(value, "email")));
    let account_id = auth
        .and_then(|value| string_at(value, "chatgpt_account_id"))
        .or_else(|| string_at(&value, "chatgpt_account_id"));
    let plan = auth
        .and_then(|value| string_at(value, "chatgpt_plan_type"))
        .or_else(|| string_at(&value, "chatgpt_plan_type"));
    Some(TokenClaims {
        email,
        account_id,
        plan,
    })
}

pub(super) fn find_string(value: &Value, keys: &[&str]) -> Option<String> {
    match value {
        Value::Object(object) => {
            for key in keys {
                if let Some(value) = object.get(*key).and_then(Value::as_str) {
                    if !value.trim().is_empty() {
                        return Some(value.to_string());
                    }
                }
            }
            object.values().find_map(|value| find_string(value, keys))
        }
        Value::Array(values) => values.iter().find_map(|value| find_string(value, keys)),
        _ => None,
    }
}

pub(super) fn string_at(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_string)
}

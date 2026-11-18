//! Keeps credentials out of account metadata (ledger L-78).
//!
//! Providers answer with free text that the app stores as non-secret metadata:
//! plan names, emails, account ids, window labels, limit-reset text. If a
//! provider echoed a token into one of those fields (a provider bug or a
//! tampered response), the token would land in `accounts.json`, the app's IPC
//! responses, the diagnostics report, and `/v1/paseo-usage`. Before any of that
//! text is stored, it is compared with every credential the account holds.
//!
//! The check matches any run of `ECHO_WINDOW_BYTES` characters from a
//! credential, so a whole token, one JWT segment, a cookie value inside the
//! cookie header, or a cut-off token all count. It keeps no copy of a
//! credential: it stores keyed hashes of those runs, made with a key chosen
//! for this check alone.

use crate::{
    model::{Account, LimitReset, OAuthSecret, ProviderSecret, UsageSnapshot, UsageWindow},
    providers::ProviderUsage,
};
use std::{
    collections::HashSet,
    hash::{BuildHasher, RandomState},
};

/// Shortest run of a credential that counts as an echo. Every real credential
/// (OAuth token, API key, session cookie) is much longer, and ordinary text
/// shares no 16-character run with a random token. A credential shorter than
/// this is not checked.
const ECHO_WINDOW_BYTES: usize = 16;

/// Stored as the account's error when a refresh is rejected for an echo.
/// Fixed text: it must never quote the field or the credential.
pub(crate) const USAGE_ECHO_MESSAGE: &str =
    "The provider sent account details that contain part of a credential, so they were not saved. Cached usage is being kept.";

/// Returned when a sign-in, reconnect, or import would store an echo.
pub(crate) const ACCOUNT_ECHO_MESSAGE: &str =
    "the account details contain part of a credential, so the account was not saved";

pub(crate) struct SecretEcho {
    hasher: RandomState,
    windows: HashSet<u64>,
}

impl SecretEcho {
    /// Every credential string in `secrets`, ready to compare text against.
    pub(crate) fn new(secrets: &[&ProviderSecret]) -> Self {
        let hasher = RandomState::new();
        let mut windows = HashSet::new();
        for secret in secrets {
            for credential in credential_strings(secret) {
                for window in credential.as_bytes().windows(ECHO_WINDOW_BYTES) {
                    windows.insert(hasher.hash_one(window));
                }
            }
        }
        Self { hasher, windows }
    }

    /// True when `text` contains any `ECHO_WINDOW_BYTES` run of a credential.
    pub(crate) fn matches(&self, text: &str) -> bool {
        !self.windows.is_empty()
            && text
                .as_bytes()
                .windows(ECHO_WINDOW_BYTES)
                .any(|window| self.windows.contains(&self.hasher.hash_one(window)))
    }

    /// True when any free-text field of a provider's usage answer contains a credential.
    pub(crate) fn usage_echoes(&self, usage: &ProviderUsage) -> bool {
        let mut fields = vec![usage.source.as_str()];
        fields.extend(usage.plan.as_deref());
        fields.extend(usage.email.as_deref());
        fields.extend(usage.provider_account_id.as_deref());
        push_windows(&mut fields, &usage.windows);
        push_limit_resets(&mut fields, &usage.limit_resets);
        fields.into_iter().any(|field| self.matches(field))
    }

    /// True when any text field of an account about to be saved contains a
    /// credential. The id is left out: the app makes it, not the provider.
    pub(crate) fn account_echoes(&self, account: &Account) -> bool {
        let mut fields = vec![account.label.as_str()];
        fields.extend(account.email.as_deref());
        fields.extend(account.provider_account_id.as_deref());
        fields.extend(account.chatgpt_account_id.as_deref());
        fields.extend(account.plan.as_deref());
        fields.extend(account.last_error.as_deref());
        if let Some(usage) = &account.last_usage {
            push_snapshot(&mut fields, usage);
        }
        fields.into_iter().any(|field| self.matches(field))
    }
}

/// Every credential a secret holds. The match is exhaustive on purpose: a new
/// provider must say here which of its fields are credentials. Ids that are
/// not credentials (OpenCode workspace, Google project, selected models) are
/// left out, because the app stores some of them as metadata on purpose.
fn credential_strings(secret: &ProviderSecret) -> Vec<&str> {
    match secret {
        ProviderSecret::Openai(oauth)
        | ProviderSecret::Anthropic(oauth)
        | ProviderSecret::Antigravity(oauth) => oauth_strings(oauth),
        ProviderSecret::OpencodeGo(secret) => vec![secret.auth_cookie.as_str()],
        ProviderSecret::GoogleAiStudio(secret) => {
            let mut strings = vec![secret.api_key.as_str()];
            if let Some(oauth) = &secret.cloud_oauth {
                strings.extend(oauth_strings(oauth));
            }
            strings
        }
        ProviderSecret::Grok(secret) => secret.cookie_header.as_deref().into_iter().collect(),
    }
}

fn oauth_strings(oauth: &OAuthSecret) -> Vec<&str> {
    let mut strings = vec![oauth.access_token.as_str(), oauth.refresh_token.as_str()];
    strings.extend(oauth.id_token.as_deref());
    strings
}

fn push_snapshot<'a>(fields: &mut Vec<&'a str>, usage: &'a UsageSnapshot) {
    fields.push(usage.source.as_str());
    fields.push(usage.fetched_at.as_str());
    fields.extend(usage.plan.as_deref());
    fields.extend(usage.email.as_deref());
    push_windows(fields, &usage.windows);
    push_limit_resets(fields, &usage.limit_resets);
}

fn push_windows<'a>(fields: &mut Vec<&'a str>, windows: &'a [UsageWindow]) {
    for window in windows {
        fields.push(window.id.as_str());
        fields.push(window.label.as_str());
        fields.extend(window.resets_at.as_deref());
    }
}

fn push_limit_resets<'a>(fields: &mut Vec<&'a str>, grants: &'a [LimitReset]) {
    for grant in grants {
        fields.push(grant.id.as_str());
        fields.push(grant.label.as_str());
        fields.push(grant.detail.as_str());
        fields.extend(grant.expires_at.as_deref());
    }
}

#[cfg(test)]
mod tests;

//! Rewrites values that older versions stored and the app no longer writes, so the frontend can
//! show stored text as it is. The app runs [`normalize_account`] on every start (`migrations.rs`),
//! on accounts that arrive by pairing (the sender may run an older version), and on a rename.

use crate::model::{Account, Provider};

/// Default labels older versions gave new accounts, by provider. A label that is one of these, or
/// one of these followed by a number ("Codex/GPT 2"), was never chosen by the person.
fn legacy_default_labels(provider: &Provider) -> &'static [&'static str] {
    match provider {
        Provider::Antigravity => &["Google Antigravity"],
        Provider::Grok => &["Grok / SuperGrok", "Grok/Cursor"],
        Provider::Openai => &["OpenAI Codex", "Codex/GPT", "GPT/Codex"],
        Provider::Anthropic => &["Anthropic Claude"],
        Provider::GoogleAiStudio => &["Google AI Studio"],
        Provider::OpencodeGo => &[],
    }
}

/// The error older versions stored when a provider refused the saved sign-in.
const LEGACY_AUTH_ERROR: &str = "authentication is required";
/// What the app writes for it now (`ProviderError::AuthRequired`).
pub const AUTH_ERROR: &str = "Re-authentication required";

/// `label` with a legacy default name replaced by the provider's current one, keeping a trailing
/// number. Any other label is returned as it is.
pub fn current_label(provider: &Provider, label: &str) -> String {
    let current = provider.display_name();
    for old in legacy_default_labels(provider) {
        if label == *old {
            return current.to_string();
        }
        let number = label
            .strip_prefix(old)
            .and_then(|rest| rest.strip_prefix(' '))
            .filter(|rest| !rest.is_empty() && rest.bytes().all(|byte| byte.is_ascii_digit()));
        if let Some(number) = number {
            return format!("{current} {number}");
        }
    }
    label.to_string()
}

/// Brings an account's stored text up to date: a legacy default label, the legacy sign-in error,
/// and a blank error (which older frontends showed as no error at all). Returns whether anything
/// changed. Running it again changes nothing.
pub fn normalize_account(account: &mut Account) -> bool {
    let mut changed = false;
    let label = current_label(&account.provider, &account.label);
    if label != account.label {
        account.label = label;
        changed = true;
    }
    let error = account.last_error.as_deref().map(str::trim);
    if error.is_some_and(str::is_empty) {
        account.last_error = None;
        changed = true;
    } else if error.is_some_and(|error| error.eq_ignore_ascii_case(LEGACY_AUTH_ERROR)) {
        account.last_error = Some(AUTH_ERROR.into());
        changed = true;
    }
    changed
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::now_rfc3339;

    fn account(provider: Provider, label: &str, error: Option<&str>) -> Account {
        Account {
            id: "account".into(),
            label: label.into(),
            provider,
            created_at: now_rfc3339(),
            updated_at: now_rfc3339(),
            last_error: error.map(Into::into),
            ..Account::for_test()
        }
    }

    #[test]
    fn legacy_default_labels_become_the_current_provider_name() {
        let cases = [
            (Provider::Antigravity, "Google Antigravity", "Antigravity"),
            (Provider::Openai, "Codex/GPT 2", "ChatGPT 2"),
            (Provider::Openai, "OpenAI Codex", "ChatGPT"),
            (Provider::Openai, "GPT/Codex 12", "ChatGPT 12"),
            (Provider::Grok, "Grok / SuperGrok", "Grok"),
            (Provider::Grok, "Grok/Cursor 2", "Grok 2"),
            (Provider::Anthropic, "Anthropic Claude", "Claude"),
            (
                Provider::GoogleAiStudio,
                "Google AI Studio 3",
                "AI Studio 3",
            ),
        ];
        for (provider, label, expected) in cases {
            assert_eq!(current_label(&provider, label), expected, "{label}");
        }
    }

    #[test]
    fn other_labels_are_left_alone() {
        let cases = [
            (Provider::Openai, "My ChatGPT"),
            (Provider::Openai, "Codex/GPT beta"),
            (Provider::Openai, "Codex/GPT 2b"),
            (Provider::Openai, "Codex/GPT "),
            (Provider::Openai, "Codex/GPT  2"),
            (Provider::Openai, "codex/gpt"),
            // Another provider's legacy name is that account's own choice.
            (Provider::Anthropic, "OpenAI Codex"),
            (Provider::OpencodeGo, "OpenCode Go"),
        ];
        for (provider, label) in cases {
            assert_eq!(current_label(&provider, label), label);
        }
    }

    #[test]
    fn the_legacy_sign_in_error_and_blank_errors_are_rewritten() {
        let cases = [
            (Some("authentication is required"), Some(AUTH_ERROR)),
            (Some("  authentication is required  "), Some(AUTH_ERROR)),
            (Some("Authentication Is Required"), Some(AUTH_ERROR)),
            (Some(""), None),
            (Some("   "), None),
        ];
        for (stored, expected) in cases {
            let mut account = account(Provider::Openai, "Work", stored);
            assert!(normalize_account(&mut account), "{stored:?}");
            assert_eq!(account.last_error.as_deref(), expected);
        }
        for kept in [
            "Re-authentication required",
            "Rate limit exceeded. Try again later.",
            "authentication is required.",
        ] {
            let mut account = account(Provider::Openai, "Work", Some(kept));
            assert!(!normalize_account(&mut account));
            assert_eq!(account.last_error.as_deref(), Some(kept));
        }
    }

    #[test]
    fn normalizing_twice_changes_nothing_the_second_time() {
        let mut account = account(
            Provider::Grok,
            "Grok/Cursor 2",
            Some("authentication is required"),
        );
        assert!(normalize_account(&mut account));
        assert_eq!(
            (account.label.as_str(), account.last_error.as_deref()),
            ("Grok 2", Some(AUTH_ERROR))
        );
        assert!(!normalize_account(&mut account));
    }
}

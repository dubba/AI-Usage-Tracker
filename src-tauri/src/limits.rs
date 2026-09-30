//! Size and shape limits for data that comes from outside the backend: a
//! pairing peer, an imported air-gap payload, or the frontend. Local data is
//! always produced within these bounds, so enforcing them at the boundary
//! never rejects anything the app itself created.

use crate::model::{Account, UsageSnapshot, UsageWindow};

pub const MAX_LABEL_CHARS: usize = 80;
pub const MAX_BUCKETS: usize = 64;
pub const MAX_BUCKET_NAME_CHARS: usize = 80;
/// Longest email address (RFC 5321).
pub const MAX_EMAIL_CHARS: usize = 254;
/// Plans, provider account ids, and other short identity strings.
pub const MAX_IDENTITY_CHARS: usize = 256;
pub const MAX_TIMESTAMP_CHARS: usize = 64;
pub const MAX_STATUS_MESSAGE_CHARS: usize = 500;
pub const MAX_USAGE_WINDOWS: usize = 32;
pub const MAX_WINDOW_TEXT_CHARS: usize = 128;
/// Serialized size of the UI state the frontend hands over for pairing.
pub const MAX_UI_STATE_BYTES: usize = 64 * 1024;
pub const MAX_UI_LIST_ENTRIES: usize = 256;
pub const MAX_UI_TEXT_CHARS: usize = 128;
pub const MAX_UI_PAGES: usize = 128;
pub const MAX_SIDEBAR_WIDTH: u32 = 4000;
/// Air-gap payloads never need more frames than this (see `airgap`).
pub const MAX_AIRGAP_FRAMES_SUBMITTED: usize = 1000;
/// A single air-gap frame URI is about 500 characters.
pub const MAX_AIRGAP_FRAME_URI_CHARS: usize = 4096;
/// Pairing QR / deep-link URIs carry a key and nonce, well under 1 KiB.
pub const MAX_PAIRING_URI_CHARS: usize = 2048;
/// Raw cookie text pasted by the user, before it is filtered down.
pub const MAX_RAW_COOKIE_INPUT_BYTES: usize = 256 * 1024;

/// Cuts `value` to at most `max` characters (never in the middle of one).
pub fn clamp_chars(value: &mut String, max: usize) {
    if let Some((index, _)) = value.char_indices().nth(max) {
        value.truncate(index);
    }
}

fn clamp_option(value: &mut Option<String>, max: usize) {
    if let Some(text) = value.as_mut() {
        clamp_chars(text, max);
    }
}

fn finite_or_none(value: &mut Option<f64>) {
    if value.is_some_and(|number| !number.is_finite()) {
        *value = None;
    }
}

fn sanitize_window(window: &mut UsageWindow) {
    clamp_chars(&mut window.id, MAX_WINDOW_TEXT_CHARS);
    clamp_chars(&mut window.label, MAX_WINDOW_TEXT_CHARS);
    clamp_option(&mut window.resets_at, MAX_TIMESTAMP_CHARS);
    finite_or_none(&mut window.used_percent);
    finite_or_none(&mut window.remaining_percent);
}

fn sanitize_usage(usage: &mut UsageSnapshot) {
    clamp_option(&mut usage.plan, MAX_IDENTITY_CHARS);
    clamp_option(&mut usage.email, MAX_EMAIL_CHARS);
    clamp_chars(&mut usage.fetched_at, MAX_TIMESTAMP_CHARS);
    clamp_chars(&mut usage.source, MAX_IDENTITY_CHARS);
    finite_or_none(&mut usage.credits_usd);
    usage.windows.truncate(MAX_USAGE_WINDOWS);
    usage.windows.iter_mut().for_each(sanitize_window);
}

/// Rejects UI state (handed over by the frontend for pairing) that is larger
/// than any real dashboard layout.
pub fn check_ui_state_size(value: &serde_json::Value) -> Result<(), String> {
    let size = serde_json::to_vec(value)
        .map_err(|error| format!("Invalid UI state: {error}"))?
        .len();
    if size > MAX_UI_STATE_BYTES {
        return Err("The layout settings to transfer are too large.".into());
    }
    Ok(())
}

/// Trims an optional email typed into the app. Blank means "not provided".
pub fn normalize_optional_email(email: Option<String>) -> Result<Option<String>, String> {
    let Some(email) = email else {
        return Ok(None);
    };
    let email = email.trim();
    if email.is_empty() {
        return Ok(None);
    }
    if email.chars().count() > MAX_EMAIL_CHARS {
        return Err(format!(
            "Email address must be {MAX_EMAIL_CHARS} characters or fewer."
        ));
    }
    Ok(Some(email.to_string()))
}

/// Brings an account received from a pairing peer within the same bounds the
/// app enforces on accounts the user creates. The id is handled separately
/// (it becomes a credential name), see `store::is_valid_account_id`.
pub fn sanitize_imported_account(account: &mut Account) {
    let label = account.label.trim();
    account.label = if label.is_empty() {
        account.provider.display_name().to_string()
    } else {
        label.to_string()
    };
    clamp_chars(&mut account.label, MAX_LABEL_CHARS);
    clamp_option(&mut account.email, MAX_EMAIL_CHARS);
    clamp_option(&mut account.provider_account_id, MAX_IDENTITY_CHARS);
    clamp_option(&mut account.chatgpt_account_id, MAX_IDENTITY_CHARS);
    clamp_option(&mut account.plan, MAX_IDENTITY_CHARS);
    clamp_chars(&mut account.created_at, MAX_TIMESTAMP_CHARS);
    clamp_chars(&mut account.updated_at, MAX_TIMESTAMP_CHARS);
    clamp_option(&mut account.last_error, MAX_STATUS_MESSAGE_CHARS);
    if let Some(usage) = account.last_usage.as_mut() {
        sanitize_usage(usage);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{now_rfc3339, Provider, UsageFreshness};

    #[test]
    fn clamp_chars_counts_characters_not_bytes() {
        let mut ascii = "abcdef".to_string();
        clamp_chars(&mut ascii, 3);
        assert_eq!(ascii, "abc");

        let mut emoji = "😀😀😀😀".to_string();
        clamp_chars(&mut emoji, 2);
        assert_eq!(emoji, "😀😀");

        let mut short = "hi".to_string();
        clamp_chars(&mut short, 10);
        assert_eq!(short, "hi");
    }

    fn oversized_account() -> Account {
        let now = now_rfc3339();
        Account {
            id: "id".into(),
            label: format!("  {}  ", "L".repeat(500)),
            provider: Provider::Anthropic,
            email: Some("e".repeat(1000)),
            provider_account_id: Some("p".repeat(1000)),
            chatgpt_account_id: Some("c".repeat(1000)),
            plan: Some("x".repeat(1000)),
            created_at: "t".repeat(1000),
            updated_at: now.clone(),
            last_usage: Some(UsageSnapshot {
                plan: Some("x".repeat(1000)),
                email: None,
                windows: (0..500)
                    .map(|index| UsageWindow {
                        id: format!("w{index}").repeat(100),
                        label: "l".repeat(1000),
                        used_percent: Some(f64::NAN),
                        remaining_percent: Some(40.0),
                        resets_at: Some("r".repeat(1000)),
                        window_seconds: Some(1),
                    })
                    .collect(),
                credits_usd: Some(f64::INFINITY),
                unlimited_credits: false,
                fetched_at: now,
                freshness: UsageFreshness::Live,
                source: "s".repeat(1000),
            }),
            last_error: Some("!".repeat(5000)),
            auth_required: false,
        }
    }

    #[test]
    fn imported_accounts_are_brought_within_bounds() {
        let mut account = oversized_account();
        sanitize_imported_account(&mut account);

        assert_eq!(account.label.chars().count(), MAX_LABEL_CHARS);
        assert!(!account.label.starts_with(' '));
        assert_eq!(
            account.email.as_ref().unwrap().chars().count(),
            MAX_EMAIL_CHARS
        );
        assert_eq!(
            account
                .provider_account_id
                .as_ref()
                .unwrap()
                .chars()
                .count(),
            MAX_IDENTITY_CHARS
        );
        assert_eq!(account.created_at.chars().count(), MAX_TIMESTAMP_CHARS);
        assert_eq!(
            account.last_error.as_ref().unwrap().chars().count(),
            MAX_STATUS_MESSAGE_CHARS
        );

        let usage = account.last_usage.as_ref().unwrap();
        assert_eq!(usage.windows.len(), MAX_USAGE_WINDOWS);
        assert!(usage.windows.iter().all(|window| {
            window.id.chars().count() <= MAX_WINDOW_TEXT_CHARS
                && window.label.chars().count() <= MAX_WINDOW_TEXT_CHARS
                && window.used_percent.is_none()
                && window.remaining_percent == Some(40.0)
        }));
        assert!(usage.credits_usd.is_none());
        assert_eq!(usage.source.chars().count(), MAX_IDENTITY_CHARS);
    }

    #[test]
    fn ui_state_size_is_capped() {
        assert!(check_ui_state_size(&serde_json::json!({"sidebarWidth": 320})).is_ok());
        let huge = serde_json::json!({ "collapsedAccountIds": vec!["x".repeat(1000); 200] });
        assert!(check_ui_state_size(&huge).is_err());
    }

    #[test]
    fn optional_email_is_trimmed_and_bounded() {
        assert_eq!(normalize_optional_email(None).unwrap(), None);
        assert_eq!(normalize_optional_email(Some("  ".into())).unwrap(), None);
        assert_eq!(
            normalize_optional_email(Some(" me@example.com ".into())).unwrap(),
            Some("me@example.com".into())
        );
        assert!(normalize_optional_email(Some("a".repeat(MAX_EMAIL_CHARS + 1))).is_err());
    }

    #[test]
    fn blank_imported_labels_fall_back_to_the_provider_name() {
        let mut account = oversized_account();
        account.label = "   ".into();
        sanitize_imported_account(&mut account);
        assert_eq!(account.label, "Claude");
    }

    #[test]
    fn ordinary_accounts_are_left_alone() {
        let now = now_rfc3339();
        let original = Account {
            id: "id".into(),
            label: "Work".into(),
            provider: Provider::Openai,
            email: Some("me@example.com".into()),
            provider_account_id: Some("acct_123".into()),
            chatgpt_account_id: None,
            plan: Some("plus".into()),
            created_at: now.clone(),
            updated_at: now,
            last_usage: None,
            last_error: Some("OpenAI rate-limited the usage request.".into()),
            auth_required: false,
        };
        let mut cleaned = original.clone();
        sanitize_imported_account(&mut cleaned);
        assert_eq!(cleaned.label, original.label);
        assert_eq!(cleaned.email, original.email);
        assert_eq!(cleaned.plan, original.plan);
        assert_eq!(cleaned.last_error, original.last_error);
        assert_eq!(cleaned.updated_at, original.updated_at);
    }
}

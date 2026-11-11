//! Saved limit resets a provider sometimes grants, separate from the weekly
//! reset time. The list is display data. Spending one is a different call.

use crate::model::LimitReset;
use chrono::{DateTime, SecondsFormat, TimeZone, Utc};
use serde_json::Value;

pub const MAX_GRANTS: usize = 8;
const MAX_GRANT_ID_CHARS: usize = 128;
const MAX_LABEL_CHARS: usize = 80;
const MAX_DETAIL_CHARS: usize = 160;

pub const DETAIL_FALLBACK: &str = "Restores that limit.";
pub const DETAIL_FULL: &str = "Clears the 5-hour and weekly limits";
pub const DETAIL_FABLE_FIVE: &str = "Clears weekly Fable usage and refills the 5-hour limit";
pub const DETAIL_FABLE: &str = "Clears weekly Fable usage";
pub const DETAIL_FIVE: &str = "Clears the 5-hour limit";
pub const DETAIL_WEEK: &str = "Clears the weekly limit";
pub const DETAIL_RATE: &str = "Restores that rate limit.";

const LABEL_FABLE: &str = "Fable reset";
const LABEL_FULL: &str = "Full reset";
const LABEL_GENERIC: &str = "Limit reset";

/// The provider answered, and the grant was spent or had already been spent.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RedeemOutcome {
    Spent,
    /// Nothing was spent. The text is a fixed sentence.
    Rejected(&'static str),
    /// The request may have been spent. Do not try it again automatically.
    Unconfirmed,
}

pub const UNCONFIRMED: &str =
    "The limit reset may have been used. Refresh the account before trying again.";

pub fn is_valid_grant_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_GRANT_ID_CHARS
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

pub fn is_org_uuid(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    bytes.iter().enumerate().all(|(index, byte)| match index {
        8 | 13 | 18 | 23 => *byte == b'-',
        _ => byte.is_ascii_hexdigit(),
    })
}

/// A new id for one redemption. Reuse it only to retry that same attempt.
pub fn new_request_id() -> String {
    let mut bytes = [0u8; 16];
    rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(36);
    for (index, byte) in bytes.iter().enumerate() {
        if matches!(index, 4 | 6 | 8 | 10) {
            out.push('-');
        }
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}

/// `true` when the usage payload says at least one ChatGPT reset credit is available.
pub fn should_fetch_chatgpt_resets(value: Option<&Value>) -> bool {
    value
        .and_then(|value| value.get("available_count"))
        .and_then(json_count)
        .is_some_and(|count| count > 0)
}

/// Grants from a Claude `cedar_ember` block. A missing or odd block is no grants.
pub fn from_cedar_ember(value: Option<&Value>, now: DateTime<Utc>) -> Vec<LimitReset> {
    let Some(grants) = value
        .and_then(|value| value.get("grants"))
        .and_then(Value::as_array)
    else {
        return Vec::new();
    };
    let mut parsed = Vec::new();
    for grant in grants {
        if let Some(grant) = claude_grant(grant, now) {
            if parsed.iter().any(|kept: &LimitReset| kept.id == grant.id) {
                continue;
            }
            parsed.push(grant);
        }
    }
    finish(parsed)
}

/// Grants from `GET /backend-api/wham/rate-limit-reset-credits`. A wrong shape is no grants.
pub fn from_chatgpt_credits(value: &Value, now: DateTime<Utc>) -> Vec<LimitReset> {
    let Some(credits) = value.get("credits").and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut parsed = Vec::new();
    for credit in credits {
        if let Some(grant) = chatgpt_grant(credit, now) {
            if parsed.iter().any(|kept: &LimitReset| kept.id == grant.id) {
                continue;
            }
            parsed.push(grant);
        }
    }
    finish(parsed)
}

/// Drops anything an imported snapshot is not allowed to keep.
pub fn sanitize_stored(grants: &mut Vec<LimitReset>) {
    grants.retain_mut(|grant| {
        if !is_valid_grant_id(&grant.id) {
            return false;
        }
        grant.label = sanitize_label(&grant.label);
        if grant.label.is_empty() {
            return false;
        }
        grant.detail = sanitize_detail(&grant.detail);
        if grant.detail.is_empty() {
            grant.detail = DETAIL_FALLBACK.to_string();
        }
        grant.expires_at = grant.expires_at.as_deref().and_then(clean_expiry);
        true
    });
    sort_and_cap(grants);
}

/// Grok lists reset tokens without a spend id. Each row is display-only.
/// An expiry in the past is dropped. A token with no expiry is kept.
pub fn from_grok_expiries(
    expiries: Vec<Option<DateTime<Utc>>>,
    now: DateTime<Utc>,
) -> Vec<LimitReset> {
    let mut grants = Vec::new();
    for expiry in expiries {
        let expires_at = match expiry {
            Some(when) if when > now => Some(when.to_rfc3339_opts(SecondsFormat::Secs, true)),
            Some(_) => continue,
            None => None,
        };
        grants.push(LimitReset {
            id: "shown".into(),
            label: LABEL_GENERIC.to_string(),
            detail: DETAIL_WEEK.to_string(),
            expires_at,
            usable: false,
        });
    }
    let mut grants = finish(grants);
    for (index, grant) in grants.iter_mut().enumerate() {
        grant.id = format!("shown-{}", index + 1);
    }
    grants
}

fn finish(mut grants: Vec<LimitReset>) -> Vec<LimitReset> {
    sort_and_cap(&mut grants);
    grants
}

fn sort_and_cap(grants: &mut Vec<LimitReset>) {
    grants.sort_by(|left, right| match (&left.expires_at, &right.expires_at) {
        (Some(left), Some(right)) => left.cmp(right),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => std::cmp::Ordering::Equal,
    });
    grants.truncate(MAX_GRANTS);
}

fn claude_grant(value: &Value, now: DateTime<Utc>) -> Option<LimitReset> {
    if !value.is_object() {
        return None;
    }
    let id = value.get("id").and_then(Value::as_str)?;
    if !is_valid_grant_id(id) {
        return None;
    }
    if !count_available(value.get("resets_left")) || !window_open(value, now) {
        return None;
    }
    let clears = clear_tokens(value.get("clears"));
    let label = sanitize_label(value.get("label").and_then(Value::as_str).unwrap_or(""));
    let label = if label.is_empty() {
        claude_label(&clears).to_string()
    } else {
        label
    };
    Some(LimitReset {
        id: id.to_string(),
        label,
        detail: claude_detail(&clears).to_string(),
        expires_at: expiry_text(value.get("ends_at"), now),
        usable: true,
    })
}

fn chatgpt_grant(value: &Value, now: DateTime<Utc>) -> Option<LimitReset> {
    if !value.is_object() {
        return None;
    }
    let status = value.get("status").and_then(Value::as_str)?;
    if !status.eq_ignore_ascii_case("available") {
        return None;
    }
    let id = value.get("id").and_then(Value::as_str)?;
    if !is_valid_grant_id(id) || !window_open(value, now) {
        return None;
    }
    let title = value.get("title").and_then(Value::as_str).unwrap_or("");
    let label = sanitize_label(title);
    let label = if label.is_empty() {
        LABEL_GENERIC.to_string()
    } else {
        label
    };
    Some(LimitReset {
        id: id.to_string(),
        label,
        detail: chatgpt_detail(title).to_string(),
        expires_at: expiry_text(value.get("expires_at"), now),
        usable: true,
    })
}

/// `resets_left` may be absent. Zero or a non-number means the grant is spent.
fn count_available(value: Option<&Value>) -> bool {
    match value {
        None => true,
        Some(value) => json_count(value).is_some_and(|count| count > 0),
    }
}

fn window_open(value: &Value, now: DateTime<Utc>) -> bool {
    if flag_refuses(value.get("usable_now"), false) || flag_refuses(value.get("paused"), true) {
        return false;
    }
    if let Some(start) = value.get("starts_at") {
        if !start.is_null() && !timestamp(start).is_some_and(|start| start <= now) {
            return false;
        }
    }
    if let Some(end) = value.get("ends_at").or_else(|| value.get("expires_at")) {
        if !end.is_null() && !timestamp(end).is_some_and(|end| end > now) {
            return false;
        }
    }
    true
}

/// A missing flag does not refuse. `refuses_when` is the boolean that means "not usable".
fn flag_refuses(value: Option<&Value>, refuses_when: bool) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag == refuses_when,
        Some(_) => true,
    }
}

fn clear_tokens(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|tokens| {
            tokens
                .iter()
                .filter_map(Value::as_str)
                .map(|token| token.trim().to_ascii_lowercase())
                .filter(|token| !token.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

fn is_fable(token: &str) -> bool {
    matches!(token, "fable" | "fable_only" | "seven_day_fable")
}

fn claude_label(clears: &[String]) -> &'static str {
    let fable = clears.iter().any(|token| is_fable(token));
    let five = clears.iter().any(|token| token == "five_hour");
    let week = clears
        .iter()
        .any(|token| token == "seven_day" || token == "seven_day_overage_included");
    if fable && !five && !week {
        LABEL_FABLE
    } else if five && week {
        LABEL_FULL
    } else if fable {
        LABEL_FABLE
    } else {
        LABEL_GENERIC
    }
}

fn claude_detail(clears: &[String]) -> &'static str {
    let fable = clears.iter().any(|token| is_fable(token));
    let five = clears.iter().any(|token| token == "five_hour");
    let week = clears
        .iter()
        .any(|token| token == "seven_day" || token == "seven_day_overage_included");
    if fable && five && !week {
        DETAIL_FABLE_FIVE
    } else if five && week {
        DETAIL_FULL
    } else if fable {
        DETAIL_FABLE
    } else if five {
        DETAIL_FIVE
    } else if week {
        DETAIL_WEEK
    } else {
        DETAIL_FALLBACK
    }
}

fn chatgpt_detail(title: &str) -> &'static str {
    let lower = title.to_ascii_lowercase();
    if lower.contains("weekly") && title.contains('5') {
        DETAIL_FULL
    } else {
        DETAIL_RATE
    }
}

fn expiry_text(value: Option<&Value>, now: DateTime<Utc>) -> Option<String> {
    let value = value.filter(|value| !value.is_null())?;
    let when = timestamp(value)?;
    (when > now).then(|| when.to_rfc3339_opts(SecondsFormat::Secs, true))
}

fn timestamp(value: &Value) -> Option<DateTime<Utc>> {
    match value {
        Value::String(text) => DateTime::parse_from_rfc3339(text.trim())
            .ok()
            .map(|when| when.with_timezone(&Utc)),
        Value::Number(number) => {
            let number = number.as_i64()?;
            let seconds = if number.abs() > 10_000_000_000 {
                number / 1000
            } else {
                number
            };
            Utc.timestamp_opt(seconds, 0).single()
        }
        _ => None,
    }
}

fn json_count(value: &Value) -> Option<u64> {
    value.as_u64().or_else(|| {
        let number = value.as_f64()?;
        (number.is_finite() && number > 0.0).then_some(number as u64)
    })
}

fn sanitize_label(value: &str) -> String {
    keep_chars(value, MAX_LABEL_CHARS, false)
}

fn sanitize_detail(value: &str) -> String {
    keep_chars(value, MAX_DETAIL_CHARS, true)
}

fn keep_chars(value: &str, max: usize, sentence: bool) -> String {
    let mut out = String::new();
    let mut space = false;
    for ch in value.chars() {
        if ch.is_control() {
            continue;
        }
        let kept = if ch.is_whitespace() {
            ' '
        } else if ch.is_alphanumeric()
            || matches!(ch, '(' | ')' | '+' | '-' | '·' | '\'')
            || (sentence && matches!(ch, '.' | ',' | '!' | '?'))
        {
            ch
        } else {
            continue;
        };
        if kept == ' ' {
            if space || out.is_empty() {
                continue;
            }
            space = true;
        } else {
            space = false;
        }
        out.push(kept);
        if out.chars().count() >= max {
            break;
        }
    }
    out.trim().to_string()
}

fn clean_expiry(value: &str) -> Option<String> {
    if value.chars().count() > 64 || value.chars().any(char::is_control) {
        return None;
    }
    DateTime::parse_from_rfc3339(value.trim()).ok().map(|when| {
        when.with_timezone(&Utc)
            .to_rfc3339_opts(SecondsFormat::Secs, true)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn now() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 11, 10, 15, 0, 0).unwrap()
    }

    fn claude(grant: Value) -> Vec<LimitReset> {
        from_cedar_ember(Some(&serde_json::json!({ "grants": [grant] })), now())
    }

    #[test]
    fn claude_keeps_a_usable_grant_and_describes_known_windows() {
        let grants = claude(serde_json::json!({
            "id": "full-reset",
            "label": "Full reset",
            "resets_left": 1,
            "ends_at": "2026-12-10T16:00:00Z",
            "clears": ["five_hour", "seven_day", "seven_day_overage_included", "unknown_window"],
            "usable_now": true,
            "paused": false
        }));
        assert_eq!(grants.len(), 1);
        assert_eq!(grants[0].label, "Full reset");
        assert_eq!(grants[0].detail, DETAIL_FULL);
        assert_eq!(
            grants[0].expires_at.as_deref(),
            Some("2026-12-10T16:00:00Z")
        );
    }

    #[test]
    fn claude_describes_a_fable_grant_from_its_windows() {
        let grants = claude(serde_json::json!({
            "id": "fable-reset",
            "resets_left": 1,
            "ends_at": "2026-11-17T16:00:00Z",
            "clears": ["fable", "five_hour"]
        }));
        assert_eq!(grants[0].label, LABEL_FABLE);
        assert_eq!(grants[0].detail, DETAIL_FABLE_FIVE);
    }

    #[test]
    fn claude_drops_grants_that_cannot_be_used() {
        let block = serde_json::json!({
            "grants": [
                {"id": "paused", "resets_left": 1, "paused": true, "ends_at": "2026-12-01T00:00:00Z"},
                {"id": "spent", "resets_left": 0, "ends_at": "2026-12-01T00:00:00Z"},
                {"id": "later", "resets_left": 1, "starts_at": "2026-12-01T00:00:00Z", "ends_at": "2026-12-20T00:00:00Z"},
                {"id": "expired", "resets_left": 1, "ends_at": "2026-11-01T00:00:00Z"},
                {"id": "blocked", "resets_left": 1, "usable_now": false, "ends_at": "2026-12-01T00:00:00Z"},
                {"id": "bad id", "resets_left": 1, "ends_at": "2026-12-01T00:00:00Z"},
                {"id": "kept", "resets_left": 1, "ends_at": "2026-12-01T00:00:00Z", "clears": ["five_hour"]}
            ]
        });
        let grants = from_cedar_ember(Some(&block), now());
        assert_eq!(grants.len(), 1);
        assert_eq!(grants[0].id, "kept");
        assert_eq!(grants[0].detail, DETAIL_FIVE);
    }

    #[test]
    fn a_weird_cedar_ember_shape_is_no_grants() {
        assert!(from_cedar_ember(Some(&Value::String("nope".into())), now()).is_empty());
        assert!(from_cedar_ember(None, now()).is_empty());
        assert!(from_cedar_ember(Some(&serde_json::json!({"grants": {}})), now()).is_empty());
    }

    #[test]
    fn grants_are_capped_and_soonest_expiry_comes_first() {
        let grants: Vec<_> = (0..10)
            .map(|index| {
                serde_json::json!({
                    "id": format!("grant-{index}"),
                    "resets_left": 1,
                    "ends_at": format!("2026-12-{:02}T00:00:00Z", 20 - index)
                })
            })
            .collect();
        let mut with_open = grants;
        with_open.push(serde_json::json!({"id": "open", "resets_left": 1}));
        let parsed = from_cedar_ember(Some(&serde_json::json!({ "grants": with_open })), now());
        assert_eq!(parsed.len(), MAX_GRANTS);
        let expiries: Vec<_> = parsed
            .iter()
            .map(|grant| grant.expires_at.clone())
            .collect();
        let mut sorted = expiries.clone();
        sorted.sort();
        assert_eq!(expiries, sorted);
        assert_eq!(parsed[0].id, "grant-9");
        assert!(parsed.iter().all(|grant| grant.id != "open"));
    }

    #[test]
    fn chatgpt_uses_the_title_and_ignores_the_description() {
        let grants = from_chatgpt_credits(
            &serde_json::json!({
                "credits": [
                    {
                        "id": "Credit_1",
                        "status": "available",
                        "title": "Weekly and 5-hour reset",
                        "description": "SECRET TOKEN do not show",
                        "expires_at": "2026-12-10T00:00:00Z"
                    },
                    {"id": "used", "status": "redeemed", "title": "Gone", "expires_at": "2026-12-10T00:00:00Z"}
                ]
            }),
            now(),
        );
        assert_eq!(grants.len(), 1);
        assert_eq!(grants[0].id, "Credit_1");
        assert_eq!(grants[0].detail, DETAIL_FULL);
        assert!(!grants[0].detail.contains("SECRET"));
        assert!(!grants[0].label.contains("SECRET"));
    }

    #[test]
    fn chatgpt_without_a_weekly_title_gets_the_generic_sentence() {
        let grants = from_chatgpt_credits(
            &serde_json::json!({
                "credits": [{"id": "one", "status": "Available", "title": "A free reset"}]
            }),
            now(),
        );
        assert_eq!(grants[0].detail, DETAIL_RATE);
        assert_eq!(grants[0].label, "A free reset");
    }

    #[test]
    fn a_chatgpt_list_is_fetched_only_when_the_count_is_positive() {
        assert!(!should_fetch_chatgpt_resets(None));
        assert!(!should_fetch_chatgpt_resets(Some(
            &serde_json::json!({"available_count": 0})
        )));
        assert!(should_fetch_chatgpt_resets(Some(
            &serde_json::json!({"available_count": 2})
        )));
        assert!(!should_fetch_chatgpt_resets(Some(&Value::String(
            "2".into()
        ))));
    }

    #[test]
    fn stored_grants_drop_bad_ids_and_clamp_text() {
        let mut grants = vec![
            LimitReset {
                id: "../secret".into(),
                label: "Bad".into(),
                detail: "No".into(),
                expires_at: None,
                usable: true,
            },
            LimitReset {
                id: "a".repeat(200),
                label: "Too long".into(),
                detail: "No".into(),
                expires_at: None,
                usable: true,
            },
            LimitReset {
                id: "ok".into(),
                label: format!("Full\nreset <{}>", "L".repeat(200)),
                detail: format!("Clears it. {}", "D".repeat(400)),
                expires_at: Some("2026-12-10T00:00:00Z\nbearer".into()),
                usable: true,
            },
            LimitReset {
                id: "marks".into(),
                label: "!!!".into(),
                detail: "Gone".into(),
                expires_at: None,
                usable: true,
            },
        ];
        for index in 0..10 {
            grants.push(LimitReset {
                id: format!("extra-{index}"),
                label: "Limit reset".into(),
                detail: DETAIL_FALLBACK.into(),
                expires_at: None,
                usable: true,
            });
        }
        sanitize_stored(&mut grants);
        assert!(grants.len() <= MAX_GRANTS);
        assert!(grants.iter().all(|grant| is_valid_grant_id(&grant.id)));
        assert!(grants
            .iter()
            .all(|grant| grant.label.chars().count() <= MAX_LABEL_CHARS));
        assert!(grants
            .iter()
            .all(|grant| grant.detail.chars().count() <= MAX_DETAIL_CHARS));
        assert!(grants
            .iter()
            .all(|grant| !grant.label.contains('\n') && !grant.label.contains('<')));
        let kept = grants.iter().find(|grant| grant.id == "ok").unwrap();
        assert!(kept.expires_at.is_none());
        assert!(grants.iter().all(|grant| grant.id != "marks"));
    }

    #[test]
    fn grok_rows_are_display_only_and_soonest_first() {
        let soon = Utc.with_ymd_and_hms(2026, 11, 17, 0, 0, 0).unwrap();
        let later = Utc.with_ymd_and_hms(2026, 12, 10, 0, 0, 0).unwrap();
        let past = Utc.with_ymd_and_hms(2026, 11, 1, 0, 0, 0).unwrap();
        let grants = from_grok_expiries(vec![Some(later), None, Some(past), Some(soon)], now());
        assert_eq!(grants.len(), 3);
        assert_eq!(grants[0].id, "shown-1");
        assert_eq!(
            grants[0].expires_at.as_deref(),
            Some(soon.to_rfc3339_opts(SecondsFormat::Secs, true).as_str())
        );
        assert_eq!(grants[1].id, "shown-2");
        assert_eq!(
            grants[1].expires_at.as_deref(),
            Some(later.to_rfc3339_opts(SecondsFormat::Secs, true).as_str())
        );
        assert_eq!(grants[2].id, "shown-3");
        assert!(grants[2].expires_at.is_none());
        assert!(grants.iter().all(|grant| {
            !grant.usable && grant.label == LABEL_GENERIC && grant.detail == DETAIL_WEEK
        }));
        assert!(!format!("{grants:?}").contains("spend"));
    }

    #[test]
    fn grok_rows_keep_at_most_eight() {
        let expiries: Vec<_> = (1..=9)
            .map(|day| Some(now() + chrono::Duration::days(day)))
            .collect();
        let grants = from_grok_expiries(expiries, now());
        assert_eq!(grants.len(), MAX_GRANTS);
        assert_eq!(grants[0].id, "shown-1");
        assert_eq!(grants[7].id, "shown-8");
        assert!(grants.iter().all(|grant| !grant.usable));
    }

    #[test]
    fn request_ids_are_uuid_v4() {
        let id = new_request_id();
        assert_eq!(id.len(), 36);
        assert_eq!(&id[14..15], "4");
        assert!(matches!(&id[19..20], "8" | "9" | "a" | "b"));
        assert!(is_valid_grant_id(&id.replace('-', "")));
    }

    #[test]
    fn organization_ids_must_be_uuids_before_they_enter_a_url() {
        assert!(is_org_uuid("550e8400-e29b-41d4-a716-446655440000"));
        assert!(!is_org_uuid("org-9"));
        assert!(!is_org_uuid("../reset"));
        assert!(!is_org_uuid("550e8400-e29b-41d4-a716-446655440000/extra"));
    }
}

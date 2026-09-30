//! Support diagnostics: a small rotating log file and a copyable report.
//!
//! Everything that reaches the log file or the report goes through [`redact`]
//! first, so a user can paste the report into a bug report without exposing
//! tokens, cookies, email addresses, or their account name. The call sites
//! never log raw provider responses, so redaction is a second line of defense,
//! not the only one.

use crate::state::AppState;
use parking_lot::Mutex;
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::OnceLock,
};

const LOG_DIR_NAME: &str = "logs";
const LOG_FILE: &str = "app.log";
const ROTATED_LOG_FILE: &str = "app.log.1";
/// The log rotates once it reaches this size, so two files hold at most twice.
const MAX_LOG_BYTES: u64 = 256 * 1024;
const MAX_LINE_CHARS: usize = 1000;
/// How many recent log lines the report includes.
const REPORT_LOG_LINES: usize = 200;
const REDACTED: &str = "[redacted]";

static LOG_DIR: OnceLock<PathBuf> = OnceLock::new();
static WRITE_LOCK: Mutex<()> = Mutex::new(());

/// Starts writing the log file under `data_dir`. Until this runs (or if the
/// folder cannot be created) messages still go to stderr.
pub fn init(data_dir: &Path) {
    let dir = data_dir.join(LOG_DIR_NAME);
    if crate::fs_util::ensure_private_dir(&dir).is_ok() {
        let _ = LOG_DIR.set(dir);
    }
}

// Only the desktop updater logs at this level today.
#[cfg_attr(target_os = "android", allow(dead_code))]
pub fn info(message: &str) {
    log("INFO", message);
}

pub fn warn(message: &str) {
    log("WARN", message);
}

pub fn error(message: &str) {
    log("ERROR", message);
}

fn log(level: &str, message: &str) {
    let timestamp = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    let line = format_line(level, message, &timestamp);
    eprintln!("{line}");
    if let Some(dir) = LOG_DIR.get() {
        append_line(dir, &line, MAX_LOG_BYTES);
    }
}

/// One redacted, single-line, length-bounded log entry.
fn format_line(level: &str, message: &str, timestamp: &str) -> String {
    let mut message = redact(message).replace(['\r', '\n'], " ");
    if let Some((index, _)) = message.char_indices().nth(MAX_LINE_CHARS) {
        message.truncate(index);
        message.push('…');
    }
    format!("{timestamp} {level} {message}")
}

fn append_line(dir: &Path, line: &str, max_bytes: u64) {
    let _guard = WRITE_LOCK.lock();
    let path = dir.join(LOG_FILE);
    if fs::metadata(&path).is_ok_and(|meta| meta.len() >= max_bytes) {
        // Replaces any previous rotated file.
        let _ = fs::rename(&path, dir.join(ROTATED_LOG_FILE));
    }
    if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(file, "{line}");
    }
}

/// The last `count` log lines, oldest first, across the rotated file and the
/// current one.
fn recent_lines(dir: &Path, count: usize) -> Vec<String> {
    let mut lines = Vec::new();
    for name in [ROTATED_LOG_FILE, LOG_FILE] {
        if let Ok(text) = fs::read_to_string(dir.join(name)) {
            lines.extend(text.lines().map(str::to_string));
        }
    }
    let skip = lines.len().saturating_sub(count);
    lines.split_off(skip)
}

/// A plain-text report for a bug report. Contains no tokens, emails, or
/// account names: only versions, settings, and per-account status.
pub fn build_report(
    app_version: &str,
    state: Option<&AppState>,
    startup_issue: Option<&str>,
) -> String {
    let mut report = String::new();
    let mut line = |text: String| {
        report.push_str(&text);
        report.push('\n');
    };
    line("AI Usage Tracker diagnostics".into());
    line(format!(
        "Generated: {}",
        chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
    ));
    line(format!(
        "Version: {app_version} ({} {})",
        std::env::consts::OS,
        std::env::consts::ARCH
    ));
    line(format!(
        "Startup: {}",
        startup_issue.unwrap_or("started normally")
    ));

    match state {
        None => line("The app state is not available.".into()),
        Some(state) => {
            let settings = state.settings.get();
            line(format!(
                "Settings: refresh every {} min, automatic updates {}, beta releases {}, start at login {}",
                settings.account_refresh_minutes,
                on_off(settings.automatic_updates_enabled),
                on_off(settings.include_beta_updates),
                on_off(settings.autostart_enabled),
            ));
            let runtime = state.api_runtime.read().clone();
            line(format!(
                "Local API: {}, {}{}",
                if settings.paseo_bridge_enabled {
                    "enabled"
                } else {
                    "disabled"
                },
                if runtime.running {
                    "running"
                } else {
                    "not running"
                },
                runtime
                    .error
                    .map(|error| format!(" ({error})"))
                    .unwrap_or_default(),
            ));
            let accounts = state.store.list();
            line(format!("Accounts: {}", accounts.len()));
            for account in accounts {
                let usage = account.last_usage.as_ref();
                line(format!(
                    "- {} {} | sign-in needed: {} | data: {} | fetched: {} | plan: {} | error: {}",
                    account.provider,
                    account.id,
                    if account.auth_required { "yes" } else { "no" },
                    usage.map_or("none".to_string(), |usage| format!("{:?}", usage.freshness)),
                    usage.map_or("never", |usage| usage.fetched_at.as_str()),
                    account.plan.as_deref().unwrap_or("unknown"),
                    account.last_error.as_deref().unwrap_or("none"),
                ));
            }
        }
    }

    line(format!("Recent log (up to {REPORT_LOG_LINES} lines):"));
    match LOG_DIR.get() {
        Some(dir) => {
            let lines = recent_lines(dir, REPORT_LOG_LINES);
            if lines.is_empty() {
                line("(empty)".into());
            }
            for entry in lines {
                line(entry);
            }
        }
        None => line("(logging has not started)".into()),
    }
    redact(&report)
}

fn on_off(value: bool) -> &'static str {
    if value {
        "on"
    } else {
        "off"
    }
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

/// Field names whose values are secrets. Matched case-insensitively, at a word
/// boundary, followed by `=` or `:` (plain, or as a JSON key).
const SENSITIVE_KEYS: &[&str] = &[
    "access_token",
    "refresh_token",
    "id_token",
    "client_secret",
    "code_verifier",
    "authorization",
    "set-cookie",
    "cookie",
    "password",
    "api_key",
    "api-key",
    "apikey",
    "secret",
    "token",
];

/// Keys whose value is the rest of the line (headers with spaces and `;`).
const LINE_VALUED_KEYS: &[&str] = &["authorization", "set-cookie", "cookie"];

/// Removes anything that could identify the user or unlock an account from a
/// piece of text: secret fields, bearer tokens, JWTs and other long opaque
/// strings, email addresses, and the user's home folder name.
pub fn redact(text: &str) -> String {
    let text = redact_home_folders(text);
    let text = redact_secret_fields(&text);
    let text = redact_bearer_tokens(&text);
    redact_tokens(&text)
}

fn is_word_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}

/// Where the value of a sensitive field starts and ends, if `from` (just after
/// the key) is followed by a separator and a non-empty value.
fn secret_value_span(text: &str, from: usize, to_end_of_line: bool) -> Option<(usize, usize)> {
    let bytes = text.as_bytes();
    let len = bytes.len();
    let mut index = from;
    // A JSON key's closing quote.
    if index < len && (bytes[index] == b'"' || bytes[index] == b'\'') {
        index += 1;
    }
    while index < len && bytes[index] == b' ' {
        index += 1;
    }
    if index >= len || (bytes[index] != b'=' && bytes[index] != b':') {
        return None;
    }
    index += 1;
    while index < len && bytes[index] == b' ' {
        index += 1;
    }
    if index >= len {
        return None;
    }
    let quote = match bytes[index] {
        q @ (b'"' | b'\'') => {
            index += 1;
            Some(q)
        }
        _ => None,
    };
    let start = index;
    let end = if let Some(quote) = quote {
        bytes[start..]
            .iter()
            .position(|&byte| byte == quote)
            .map_or(len, |offset| start + offset)
    } else if to_end_of_line {
        bytes[start..]
            .iter()
            .position(|&byte| byte == b'\n')
            .map_or(len, |offset| start + offset)
    } else {
        bytes[start..]
            .iter()
            .position(|&byte| {
                byte.is_ascii_whitespace()
                    || matches!(byte, b'&' | b',' | b';' | b')' | b'}' | b']' | b'"' | b'\'')
            })
            .map_or(len, |offset| start + offset)
    };
    (end > start).then_some((start, end))
}

fn redact_secret_fields(text: &str) -> String {
    // ASCII lowercasing keeps every byte offset, so positions carry over.
    let lower = text.to_ascii_lowercase();
    let mut out = String::with_capacity(text.len());
    let mut index = 0;
    'scan: while index < text.len() {
        let at_word_start = index == 0 || !is_word_byte(lower.as_bytes()[index - 1]);
        if at_word_start {
            for key in SENSITIVE_KEYS {
                if lower[index..].starts_with(key) {
                    let to_end_of_line = LINE_VALUED_KEYS.contains(key);
                    if let Some((start, end)) =
                        secret_value_span(text, index + key.len(), to_end_of_line)
                    {
                        out.push_str(&text[index..start]);
                        out.push_str(REDACTED);
                        // Already redacted (a second pass): step over the
                        // marker as a whole instead of cutting it at `]`.
                        index = if text[start..].starts_with(REDACTED) {
                            start + REDACTED.len()
                        } else {
                            end
                        };
                        continue 'scan;
                    }
                }
            }
        }
        let ch = text[index..]
            .chars()
            .next()
            .expect("index is on a boundary");
        out.push(ch);
        index += ch.len_utf8();
    }
    out
}

fn redact_bearer_tokens(text: &str) -> String {
    const MARKER: &str = "bearer ";
    let lower = text.to_ascii_lowercase();
    let mut out = String::with_capacity(text.len());
    let mut index = 0;
    while let Some(found) = lower[index..].find(MARKER) {
        let start = index + found;
        let value_start = start + MARKER.len();
        let value_end = text[value_start..]
            .find(char::is_whitespace)
            .map_or(text.len(), |offset| value_start + offset);
        out.push_str(&text[index..value_start]);
        if value_end > value_start && &text[value_start..value_end] != REDACTED {
            out.push_str(REDACTED);
        } else {
            out.push_str(&text[value_start..value_end]);
        }
        index = value_end;
    }
    out.push_str(&text[index..]);
    out
}

fn redact_tokens(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut token = String::new();
    for ch in text.chars() {
        if ch.is_whitespace() {
            out.push_str(&redact_token(&token));
            token.clear();
            out.push(ch);
        } else {
            token.push(ch);
        }
    }
    out.push_str(&redact_token(&token));
    out
}

fn redact_token(token: &str) -> String {
    let core = token.trim_matches(|c: char| {
        matches!(
            c,
            '"' | '\'' | '(' | ')' | '[' | ']' | '{' | '}' | '<' | '>' | ',' | ';' | ':' | '.'
        )
    });
    if core.is_empty() || core == REDACTED {
        return token.to_string();
    }
    let replacement = if let Some(masked) = mask_email(core) {
        masked
    } else if is_jwt(core) || is_opaque_secret(core) {
        REDACTED.to_string()
    } else {
        return token.to_string();
    };
    token.replacen(core, &replacement, 1)
}

/// `someone@example.com` becomes `s***@example.com`: enough to tell accounts
/// apart in a report without naming the person.
fn mask_email(value: &str) -> Option<String> {
    let (local, domain) = value.split_once('@')?;
    let first = local.chars().next()?;
    if domain.contains('@') || !domain.contains('.') || domain.starts_with('.') {
        return None;
    }
    Some(format!("{first}***@{domain}"))
}

fn is_jwt(value: &str) -> bool {
    value.starts_with("eyJ") && value.matches('.').count() >= 2
}

fn is_uuid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => byte == b'-',
            _ => byte.is_ascii_hexdigit(),
        })
}

/// A long run of token characters with digits or mixed case: an API key,
/// session id, or base64 secret. Account ids (UUIDs), URLs, and file paths
/// are deliberately left alone: they are useful in a report and not secret.
fn is_opaque_secret(value: &str) -> bool {
    value.len() >= 32
        && !value.starts_with('/')
        && !is_uuid(value)
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'+' | b'/' | b'=' | b'.')
        })
        && (value.bytes().any(|byte| byte.is_ascii_digit())
            || (value.bytes().any(|byte| byte.is_ascii_uppercase())
                && value.bytes().any(|byte| byte.is_ascii_lowercase())))
}

/// Replaces the user name in home-folder paths (`/Users/name/...`,
/// `/home/name/...`, `C:\Users\name\...`) with `~`.
fn redact_home_folders(text: &str) -> String {
    let mut text = text.to_string();
    for marker in ["/Users/", "/home/", "\\Users\\"] {
        text = replace_folder_after(&text, marker);
    }
    for variable in ["HOME", "USERPROFILE"] {
        if let Ok(home) = std::env::var(variable) {
            // Skip trivial values such as "/" that would mangle everything.
            if home.len() > 3 {
                text = text.replace(&home, "~");
            }
        }
    }
    text
}

fn replace_folder_after(text: &str, marker: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(found) = rest.find(marker) {
        out.push_str(&rest[..found]);
        let after = &rest[found + marker.len()..];
        let name_end = after
            .find(|c: char| matches!(c, '/' | '\\' | ' ' | '"' | '\'') || c.is_whitespace())
            .unwrap_or(after.len());
        if name_end == 0 {
            // "/Users/" with nothing after it: keep it as written.
            out.push_str(marker);
        } else {
            out.push('~');
        }
        rest = &after[name_end..];
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn bearer_tokens_and_authorization_headers_are_removed() {
        let out = redact("request failed: Authorization: Bearer abc123def456ghi789 (status 401)");
        assert!(!out.contains("abc123"), "{out}");
        assert!(out.contains(REDACTED));

        let out = redact("sent bearer sk-ant-oat01-secretsecretsecret and retried");
        assert!(!out.contains("secretsecret"), "{out}");
        assert!(out.ends_with("and retried"));
    }

    #[test]
    fn secret_fields_are_removed_in_query_string_and_json_forms() {
        let out = redact(
            "POST /token?grant_type=refresh_token&refresh_token=rt_ABC.def-123&client_id=public",
        );
        assert!(!out.contains("rt_ABC"), "{out}");
        assert!(out.contains("client_id=public"), "{out}");

        let out = redact(r#"{"access_token":"at_secret_value","expires_in":3600}"#);
        assert!(!out.contains("at_secret_value"), "{out}");
        assert!(out.contains("3600"), "{out}");

        let out = redact("password=hunter2 next=ok");
        assert!(!out.contains("hunter2"), "{out}");
        assert!(out.contains("next=ok"));
    }

    #[test]
    fn cookie_headers_are_removed_to_the_end_of_the_line() {
        let out = redact("Cookie: session=abc; theme=dark; sso=xyz\nnext line kept");
        assert!(!out.contains("abc") && !out.contains("xyz"), "{out}");
        assert!(out.contains("next line kept"), "{out}");
        assert!(!redact("Set-Cookie: a=b; Path=/").contains("Path=/"));
    }

    #[test]
    fn jwts_and_long_opaque_strings_are_removed() {
        let jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
        assert!(!redact(&format!("id token was {jwt} here")).contains("eyJhbGci"));

        let key = "AIzaSyD-9tSrke72PouQMnMX-a7eZSW0jkFMBWY";
        let out = redact(&format!("key {key} rejected"));
        assert!(!out.contains("AIzaSy"), "{out}");
        assert!(out.contains("rejected"));
    }

    #[test]
    fn useful_identifiers_survive() {
        let id = "4f0e8a3c-2b7d-4c1e-9a55-0d3f6b1e7c22";
        let text = format!(
            "account {id} at https://api.anthropic.com/api/oauth/usage returned 429 Retry after 30"
        );
        assert_eq!(redact(&text), text);
        // Long file paths are not secrets.
        let path = "/data/user/0/com.yajinni.paseousagebridge/files/credentials/accounts.json";
        assert_eq!(redact(path), path);
        assert_eq!(
            redact("OpenAI rate-limited the usage request."),
            "OpenAI rate-limited the usage request."
        );
    }

    #[test]
    fn emails_are_masked_not_dropped() {
        assert_eq!(
            redact("signed in as someone.private@example.com."),
            "signed in as s***@example.com."
        );
        // Idempotent: a masked address stays masked.
        let once = redact("a@b.co");
        assert_eq!(redact(&once), once);
    }

    #[test]
    fn home_folder_names_are_removed() {
        assert_eq!(
            redact("/Users/momo/Library/Application Support/app/accounts.json"),
            "~/Library/Application Support/app/accounts.json"
        );
        assert_eq!(
            redact("read /home/alice/.config/x failed"),
            "read ~/.config/x failed"
        );
        assert_eq!(
            redact(r"C:\Users\Bob\AppData\Roaming\app"),
            r"C:~\AppData\Roaming\app"
        );
        assert_eq!(redact("no user folder here"), "no user folder here");
        assert_eq!(redact("/Users/ alone"), "/Users/ alone");
    }

    #[test]
    fn redaction_handles_multibyte_text_and_is_repeatable() {
        let text = "错误 token=abc界 完成 — done";
        let once = redact(text);
        assert!(!once.contains("abc界"), "{once}");
        assert!(once.contains("完成"));
        assert_eq!(redact(&once), once);
    }

    #[test]
    fn log_lines_are_single_line_redacted_and_bounded() {
        let line = format_line(
            "WARN",
            "refresh failed\nrefresh_token=abcdef\r\n and more",
            "2026-09-30T00:00:00Z",
        );
        assert!(line.starts_with("2026-09-30T00:00:00Z WARN "));
        assert!(!line.contains('\n') && !line.contains('\r'));
        assert!(!line.contains("abcdef"));

        let long = format_line("INFO", &"x ".repeat(2000), "t");
        assert!(long.chars().count() < MAX_LINE_CHARS + 20);
        assert!(long.ends_with('…'));
    }

    #[test]
    fn the_log_rotates_and_recent_lines_span_both_files() {
        let dir = tempdir().unwrap();
        for index in 0..10 {
            append_line(dir.path(), &format!("line {index}"), 30);
        }
        assert!(dir.path().join(ROTATED_LOG_FILE).exists());
        let lines = recent_lines(dir.path(), 4);
        assert_eq!(lines, ["line 6", "line 7", "line 8", "line 9"]);
        // Asking for more than exists returns what there is, in order.
        let all = recent_lines(dir.path(), 1000);
        assert_eq!(all.first().unwrap(), "line 0");
        assert_eq!(all.last().unwrap(), "line 9");
        assert_eq!(all.len(), 10);
    }

    #[test]
    fn the_report_lists_status_without_identity_or_secrets() {
        use crate::model::{now_rfc3339, Account, OAuthSecret, Provider, ProviderSecret};

        let dir = tempdir().unwrap();
        let state = AppState::new(dir.path().to_path_buf(), "test-token".into()).unwrap();
        let now = now_rfc3339();
        state
            .store
            .persist_account(
                Account {
                    id: "report-account-1".into(),
                    label: "Private Label".into(),
                    provider: Provider::Anthropic,
                    email: Some("someone@example.com".into()),
                    provider_account_id: None,
                    chatgpt_account_id: None,
                    plan: Some("Pro".into()),
                    created_at: now.clone(),
                    updated_at: now,
                    last_usage: None,
                    last_error: Some("Anthropic returned 429 for someone@example.com".into()),
                    auth_required: false,
                },
                &ProviderSecret::Anthropic(OAuthSecret {
                    access_token: "secret-access".into(),
                    refresh_token: "secret-refresh".into(),
                    id_token: None,
                    expires_at: 1,
                }),
            )
            .unwrap();

        let report = build_report("9.9.9", Some(&state), None);
        assert!(report.contains("Version: 9.9.9"));
        assert!(report.contains("Accounts: 1"));
        assert!(report.contains("anthropic report-account-1"));
        assert!(report.contains("plan: Pro"));
        assert!(report.contains("s***@example.com"));
        for leaked in [
            "Private Label",
            "someone@example.com",
            "secret-access",
            "secret-refresh",
        ] {
            assert!(!report.contains(leaked), "report leaked {leaked}");
        }

        let failed = build_report("9.9.9", None, Some("Couldn't load saved data: disk full"));
        assert!(failed.contains("Startup: Couldn't load saved data: disk full"));
        assert!(failed.contains("The app state is not available."));
    }
}

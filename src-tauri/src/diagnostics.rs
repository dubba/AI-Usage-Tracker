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
    if crate::platform::fs_util::ensure_private_dir(&dir).is_ok() {
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
/// One entry per usage bar: its id, the remaining percentage and whether the
/// provider sent a reset time (never the time itself). Shows why a card reads
/// "Starts on first use" or has no countdown.
fn describe_windows(windows: &[crate::model::UsageWindow]) -> String {
    if windows.is_empty() {
        return "none".into();
    }
    windows
        .iter()
        .map(|window| {
            format!(
                "{} {} reset={}",
                window.id,
                window
                    .remaining_percent
                    .map_or("n/a".to_string(), |value| format!("{}%", value.round())),
                if window.resets_at.is_some() {
                    "yes"
                } else {
                    "no"
                },
            )
        })
        .collect::<Vec<_>>()
        .join(", ")
}

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
                if let Some(usage) = usage {
                    line(format!("  windows: {}", describe_windows(&usage.windows)));
                }
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

/// Query parameters that carry an OAuth authorization code or state. Redacted
/// only in query-string form (`?code=…`, `&state=…`), so prose such as "status
/// code: 404" or "state: waiting" is left alone.
const QUERY_SENSITIVE_KEYS: &[&str] = &["code", "state"];

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

/// Error text for a command's `Err`, which the page shows to the user. Tauri and
/// IO errors routinely include absolute paths (with the user's home folder name)
/// and other detail the page does not need, so the text goes through [`redact`]
/// and is capped in length.
pub fn command_error(error: impl std::fmt::Display) -> String {
    const MAX_CHARS: usize = 300;
    let text = redact(&error.to_string());
    match text.char_indices().nth(MAX_CHARS) {
        Some((cut, _)) => format!("{}…", &text[..cut]),
        None => text,
    }
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
            let in_query = index > 0 && matches!(lower.as_bytes()[index - 1], b'?' | b'&');
            let query_keys = QUERY_SENSITIVE_KEYS
                .iter()
                .filter(|key| in_query && lower.as_bytes().get(index + key.len()) == Some(&b'='));
            for key in SENSITIVE_KEYS.iter().chain(query_keys) {
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
mod tests;

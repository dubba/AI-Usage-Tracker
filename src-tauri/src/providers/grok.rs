// Grok billing integration is adapted from the MIT-licensed CodexBar Grok
// provider and the MIT-licensed Grok Rate Limit Display userscript. The live
// path uses the same grok.com billing request as Grok's own Usage page. The
// Grok Build CLI RPC remains a best-effort fallback for versions that expose it.
// No message or token allowance is estimated.

use super::{ProviderError, ProviderUsage};
use crate::{
    model::{Account, GrokSecret, UsageWindow},
    state::AppState,
};
use chrono::{DateTime, TimeZone, Utc};
use reqwest::{header, StatusCode};
use serde_json::Value;
use std::{
    collections::HashMap,
    env, fs,
    path::{Path, PathBuf},
};

const OIDC_SCOPE_PREFIX: &str = "https://auth.x.ai::";
const LEGACY_SCOPE: &str = "https://accounts.x.ai/sign-in";
const WEB_BILLING_ENDPOINT: &str =
    "https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig";
const MAX_COOKIE_HEADER_BYTES: usize = 32 * 1024;

#[derive(Clone, Debug)]
#[allow(dead_code)]
pub(crate) struct GrokCredentials {
    pub access_token: String,
    pub email: Option<String>,
    pub user_id: Option<String>,
    pub team_id: Option<String>,
    pub principal_type: Option<String>,
    pub auth_mode: Option<String>,
    pub expires_at: Option<DateTime<Utc>>,
}

impl GrokCredentials {
    pub(crate) fn is_expired(&self) -> bool {
        self.expires_at
            .is_some_and(|expires_at| expires_at <= Utc::now())
    }

    pub(crate) fn account_id(&self) -> Option<String> {
        self.user_id.clone().or_else(|| self.team_id.clone())
    }

    pub(crate) fn plan(&self) -> String {
        if self
            .principal_type
            .as_deref()
            .is_some_and(|value| value.eq_ignore_ascii_case("team"))
        {
            "Grok Team".into()
        } else if self
            .auth_mode
            .as_deref()
            .is_some_and(|value| value.eq_ignore_ascii_case("oidc"))
        {
            "SuperGrok".into()
        } else {
            "Grok / SuperGrok".into()
        }
    }
}

#[derive(Clone, Debug)]
struct BillingSnapshot {
    used_percent: f64,
    resets_at: Option<DateTime<Utc>>,
    period_start: Option<DateTime<Utc>>,
    source: &'static str,
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
) -> Result<ProviderUsage, ProviderError> {
    let credentials = load_optional_credentials(secret);

    let Some(cookie_header) = secret
        .cookie_header
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    else {
        return Err(ProviderError::Auth);
    };

    match fetch_web_billing(app, cookie_header).await {
        Ok(snapshot) => Ok(usage_from_snapshot(account, credentials.as_ref(), snapshot)),
        Err(error) => Err(error.into_provider_error()),
    }
}

pub async fn probe_cookie(
    app: &AppState,
    cookie_header: &str,
) -> Result<ProviderUsage, ProviderError> {
    let cookie_header = normalize_cookie_header(cookie_header).map_err(ProviderError::Transient)?;
    let snapshot = match fetch_web_billing(app, &cookie_header).await {
        Ok(snapshot) => snapshot,
        Err(error) => return Err(error.into_provider_error()),
    };
    Ok(usage_from_snapshot(
        &Account {
            id: String::new(),
            label: "Grok / SuperGrok".into(),
            provider: crate::model::Provider::Grok,
            email: None,
            provider_account_id: Some("grok-browser-session".into()),
            chatgpt_account_id: None,
            plan: Some("Grok / SuperGrok".into()),
            created_at: String::new(),
            updated_at: String::new(),
            last_usage: None,
            last_error: None,
            auth_required: false,
        },
        None,
        snapshot,
    ))
}

fn usage_from_snapshot(
    account: &Account,
    credentials: Option<&GrokCredentials>,
    snapshot: BillingSnapshot,
) -> ProviderUsage {
    let used = snapshot.used_percent.clamp(0.0, 100.0);
    let (id, label, window_seconds) = classify_period(
        snapshot.period_start,
        snapshot.resets_at,
        snapshot.source == "grok_web_billing",
    );
    ProviderUsage {
        plan: Some(
            credentials
                .map(GrokCredentials::plan)
                .or_else(|| account.plan.clone())
                .unwrap_or_else(|| "Grok / SuperGrok".into()),
        ),
        email: credentials
            .and_then(|value| value.email.clone())
            .or_else(|| account.email.clone()),
        provider_account_id: credentials
            .and_then(GrokCredentials::account_id)
            .or_else(|| account.provider_account_id.clone())
            .or_else(|| Some("grok-browser-session".into())),
        windows: vec![UsageWindow {
            id: id.into(),
            label: label.into(),
            used_percent: Some(used),
            remaining_percent: Some((100.0 - used).max(0.0)),
            resets_at: snapshot.resets_at.map(|value| value.to_rfc3339()),
            window_seconds,
        }],
        credits_usd: None,
        unlimited_credits: false,
        source: snapshot.source.into(),
    }
}

fn load_optional_credentials(secret: &GrokSecret) -> Option<GrokCredentials> {
    let configured = secret
        .auth_file
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from);
    let path = configured.or_else(|| {
        let path = default_auth_file()?;
        path.is_file().then_some(path)
    })?;
    load_credentials(&path).ok()
}

pub(crate) fn default_auth_file() -> Option<PathBuf> {
    grok_home().map(|dir| dir.join("auth.json"))
}

fn grok_home() -> Option<PathBuf> {
    if let Some(path) = env::var_os("GROK_HOME").filter(|value| !value.is_empty()) {
        return Some(PathBuf::from(path));
    }
    env::var_os("HOME")
        .or_else(|| env::var_os("USERPROFILE"))
        .filter(|value| !value.is_empty())
        .map(|home| PathBuf::from(home).join(".grok"))
}

pub(crate) fn load_credentials(path: &Path) -> Result<GrokCredentials, String> {
    let payload = fs::read_to_string(path)
        .map_err(|error| format!("Unable to read {}: {error}", path.display()))?;
    parse_credentials(&payload)
}

fn parse_credentials(payload: &str) -> Result<GrokCredentials, String> {
    let root: Value = serde_json::from_str(payload)
        .map_err(|error| format!("Invalid Grok auth.json: {error}"))?;
    let root = root
        .as_object()
        .ok_or_else(|| "Invalid Grok auth.json root.".to_string())?;

    let mut oidc = None;
    let mut legacy = None;
    for (scope, value) in root {
        let Some(entry) = value.as_object() else {
            continue;
        };
        let Some(token) = entry.get("key").and_then(Value::as_str) else {
            continue;
        };
        if token.trim().is_empty() {
            continue;
        }
        if scope.starts_with(OIDC_SCOPE_PREFIX) {
            oidc = Some(entry);
        } else if scope == LEGACY_SCOPE || scope.contains("/sign-in") {
            legacy = Some(entry);
        }
    }
    let entry = oidc
        .or(legacy)
        .ok_or_else(|| "Grok auth.json contains no usable access token.".to_string())?;

    Ok(GrokCredentials {
        access_token: string_field(entry, "key")
            .ok_or_else(|| "Grok auth.json is missing its access token.".to_string())?,
        email: string_field(entry, "email"),
        user_id: string_field(entry, "user_id"),
        team_id: string_field(entry, "team_id"),
        principal_type: string_field(entry, "principal_type"),
        auth_mode: string_field(entry, "auth_mode"),
        expires_at: entry.get("expires_at").and_then(parse_date_value),
    })
}

fn string_field(entry: &serde_json::Map<String, Value>, key: &str) -> Option<String> {
    entry
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn parse_date_value(value: &Value) -> Option<DateTime<Utc>> {
    if let Some(raw) = value.as_str() {
        if let Ok(parsed) = DateTime::parse_from_rfc3339(raw) {
            return Some(parsed.with_timezone(&Utc));
        }
        if let Ok(timestamp) = raw.parse::<i64>() {
            return timestamp_to_datetime(timestamp);
        }
    }
    value.as_i64().and_then(timestamp_to_datetime)
}

fn timestamp_to_datetime(timestamp: i64) -> Option<DateTime<Utc>> {
    let seconds = if timestamp > 10_000_000_000 {
        timestamp / 1000
    } else {
        timestamp
    };
    Utc.timestamp_opt(seconds, 0).single()
}

pub(crate) fn normalize_cookie_header(value: &str) -> Result<String, String> {
    if value.contains(['\r', '\n']) {
        return Err("The Grok browser session contains invalid header characters.".into());
    }
    let value = value.trim().strip_prefix("Cookie:").unwrap_or(value.trim());
    let normalized = value
        .split(';')
        .map(str::trim)
        .filter(|part| !part.is_empty() && part.contains('='))
        .collect::<Vec<_>>()
        .join("; ");
    if normalized.is_empty() {
        return Err("No Grok browser session cookies were found.".into());
    }
    if normalized.len() > MAX_COOKIE_HEADER_BYTES {
        return Err("The Grok browser session is unexpectedly large. Sign out of Grok, sign in again, and retry.".into());
    }
    Ok(normalized)
}

async fn fetch_web_billing(
    app: &AppState,
    cookie_header: &str,
) -> Result<BillingSnapshot, GrokFetchError> {
    let cookie_header = normalize_cookie_header(cookie_header)
        .map_err(|_| GrokFetchError::Unavailable)?;
    let response = app
        .client
        .post(WEB_BILLING_ENDPOINT)
        .header(header::COOKIE, cookie_header)
        .header(header::ORIGIN, "https://grok.com")
        .header(header::REFERER, "https://grok.com/?_s=usage")
        .header(header::ACCEPT, "*/*")
        .header(header::CONTENT_TYPE, "application/grpc-web+proto")
        .header("connect-protocol-version", "1")
        .header("x-grpc-web", "1")
        .body(vec![0u8; 5])
        .send()
        .await
        .map_err(|_| GrokFetchError::Unavailable)?;
    let status = response.status();
    let headers = response.headers().clone();
    let body = response
        .bytes()
        .await
        .map_err(|_| GrokFetchError::Unavailable)?;

    if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN {
        return Err(GrokFetchError::Auth);
    }
    if !status.is_success() {
        return Err(GrokFetchError::Unavailable);
    }
    validate_grpc_status(
        headers
            .get("grpc-status")
            .and_then(|value| value.to_str().ok()),
        headers
            .get("grpc-message")
            .and_then(|value| value.to_str().ok()),
    )?;
    let trailers = grpc_trailer_fields(&body);
    validate_grpc_status(
        trailers.get("grpc-status").map(String::as_str),
        trailers.get("grpc-message").map(String::as_str),
    )?;

    let (used_percent, period_start, resets_at) = parse_web_billing_response(&body)?;
    Ok(BillingSnapshot {
        used_percent,
        resets_at,
        period_start,
        source: "grok_web_billing",
    })
}

fn validate_grpc_status(
    raw_status: Option<&str>,
    message: Option<&str>,
) -> Result<(), GrokFetchError> {
    let Some(status) = raw_status.and_then(|value| value.parse::<i32>().ok()) else {
        return Ok(());
    };
    if status == 0 {
        return Ok(());
    }
    let message = message.unwrap_or("Unknown Grok billing RPC error");
    let lower = message.to_ascii_lowercase();
    if status == 16
        || lower.contains("bad-credentials")
        || lower.contains("unauthenticated")
        || lower.contains("session")
    {
        return Err(GrokFetchError::Auth);
    }
    if status == 9 && lower.trim_end_matches('.') == "no personal team" {
        return Err(GrokFetchError::TeamUnavailable);
    }
    Err(GrokFetchError::Unavailable)
}

fn grpc_trailer_fields(data: &[u8]) -> HashMap<String, String> {
    let mut fields = HashMap::new();
    let mut index = 0usize;
    while index + 5 <= data.len() {
        let flags = data[index];
        let length = u32::from_be_bytes([
            data[index + 1],
            data[index + 2],
            data[index + 3],
            data[index + 4],
        ]) as usize;
        let start = index + 5;
        let Some(end) = start.checked_add(length) else {
            break;
        };
        if end > data.len() {
            break;
        }
        if flags & 0x80 != 0 {
            if let Ok(text) = std::str::from_utf8(&data[start..end]) {
                for line in text.lines() {
                    if let Some((key, value)) = line.split_once(':') {
                        fields.insert(
                            key.trim().to_ascii_lowercase(),
                            value.trim().to_string(),
                        );
                    }
                }
            }
        }
        index = end;
    }
    fields
}

#[derive(Default)]
struct ProtobufScan {
    fixed32: Vec<Fixed32Field>,
    varints: Vec<VarintField>,
}

struct Fixed32Field {
    path: Vec<u64>,
    value: f32,
    order: usize,
}

struct VarintField {
    path: Vec<u64>,
    value: u64,
}

impl ProtobufScan {
    fn merge(&mut self, mut other: Self) {
        self.fixed32.append(&mut other.fixed32);
        self.varints.append(&mut other.varints);
    }
}

fn parse_web_billing_response(
    data: &[u8],
) -> Result<(f64, Option<DateTime<Utc>>, Option<DateTime<Utc>>), GrokFetchError> {
    let mut payloads = grpc_data_frames(data);
    if payloads.is_empty() && looks_like_protobuf(data) {
        payloads.push(data.to_vec());
    }
    if payloads.is_empty() {
        return Err(GrokFetchError::Unavailable);
    }

    let mut scan = ProtobufScan::default();
    for payload in payloads {
        let (nested, _) = scan_protobuf(&payload, 0, Vec::new(), 0);
        scan.merge(nested);
    }
    let percent = scan
        .fixed32
        .iter()
        .filter(|field| {
            field.path.last() == Some(&1)
                && !field.path.contains(&7)
                && field.value.is_finite()
                && (0.0..=100.0).contains(&field.value)
        })
        .min_by_key(|field| (field.path.len(), field.order))
        .map(|field| field.value as f64)
        .or_else(|| {
            scan.fixed32
                .iter()
                .filter(|field| field.value.is_finite() && (0.0..=100.0).contains(&field.value))
                .min_by_key(|field| (field.path.len(), field.order))
                .map(|field| field.value as f64)
        });

    let now = Utc::now();
    let timestamp_fields = scan
        .varints
        .iter()
        .filter_map(|field| {
            if !(1_700_000_000..=4_102_444_800).contains(&field.value) {
                return None;
            }
            let date = Utc.timestamp_opt(field.value as i64, 0).single()?;
            Some((field.path.as_slice(), date))
        })
        .collect::<Vec<_>>();
    let period_start = timestamp_fields
        .iter()
        .find(|(path, _)| path.ends_with(&[8, 2, 1]))
        .map(|(_, date)| date.to_owned())
        .or_else(|| {
            timestamp_fields
                .iter()
                .filter(|(_, date)| *date <= now)
                .map(|(_, date)| date.to_owned())
                .max()
        });
    let resets_at = timestamp_fields
        .iter()
        .find(|(path, date)| path.ends_with(&[8, 3, 1]) && *date > now)
        .map(|(_, date)| date.to_owned())
        .or_else(|| {
            timestamp_fields
                .iter()
                .filter(|(_, date)| *date > now)
                .map(|(_, date)| date.to_owned())
                .min()
        });

    let used_percent = percent
        .or_else(|| resets_at.is_some().then_some(0.0))
        .ok_or_else(|| {
            GrokFetchError::Unavailable
        })?;
    Ok((used_percent, period_start, resets_at))
}

fn grpc_data_frames(data: &[u8]) -> Vec<Vec<u8>> {
    let mut frames = Vec::new();
    let mut index = 0usize;
    while index < data.len() {
        if index + 5 > data.len() {
            return Vec::new();
        }
        let flags = data[index];
        let length = u32::from_be_bytes([
            data[index + 1],
            data[index + 2],
            data[index + 3],
            data[index + 4],
        ]) as usize;
        let start = index + 5;
        let Some(end) = start.checked_add(length) else {
            return Vec::new();
        };
        if end > data.len() {
            return Vec::new();
        }
        if flags & 0x80 == 0 {
            frames.push(data[start..end].to_vec());
        }
        index = end;
    }
    frames
}

fn looks_like_protobuf(data: &[u8]) -> bool {
    data.first().is_some_and(|first| {
        let field = first >> 3;
        let wire = first & 0x07;
        field > 0 && matches!(wire, 0 | 1 | 2 | 5)
    })
}

fn scan_protobuf(
    data: &[u8],
    depth: usize,
    path: Vec<u64>,
    order: usize,
) -> (ProtobufScan, usize) {
    let mut scan = ProtobufScan::default();
    let mut index = 0usize;
    let mut next_order = order;
    while index < data.len() {
        let field_start = index;
        let Some(key) = read_varint(data, &mut index).filter(|key| *key != 0) else {
            index = field_start + 1;
            continue;
        };
        let field_number = key >> 3;
        let wire_type = key & 0x07;
        let mut field_path = path.clone();
        field_path.push(field_number);
        match wire_type {
            0 => {
                if let Some(value) = read_varint(data, &mut index) {
                    scan.varints.push(VarintField {
                        path: field_path,
                        value,
                    });
                } else {
                    index = field_start + 1;
                }
            }
            1 => {
                if index + 8 > data.len() {
                    break;
                }
                index += 8;
            }
            2 => {
                let Some(length) = read_varint(data, &mut index) else {
                    index = field_start + 1;
                    continue;
                };
                let Ok(length) = usize::try_from(length) else {
                    index = field_start + 1;
                    continue;
                };
                let Some(end) = index.checked_add(length) else {
                    index = field_start + 1;
                    continue;
                };
                if end > data.len() {
                    index = field_start + 1;
                    continue;
                }
                if depth < 6 {
                    let (nested, nested_order) = scan_protobuf(
                        &data[index..end],
                        depth + 1,
                        field_path,
                        next_order,
                    );
                    scan.merge(nested);
                    next_order = nested_order;
                }
                index = end;
            }
            5 => {
                if index + 4 > data.len() {
                    break;
                }
                let bits = u32::from_le_bytes([
                    data[index],
                    data[index + 1],
                    data[index + 2],
                    data[index + 3],
                ]);
                scan.fixed32.push(Fixed32Field {
                    path: field_path,
                    value: f32::from_bits(bits),
                    order: next_order,
                });
                next_order += 1;
                index += 4;
            }
            _ => index = field_start + 1,
        }
    }
    (scan, next_order)
}

fn read_varint(data: &[u8], index: &mut usize) -> Option<u64> {
    let mut value = 0u64;
    let mut shift = 0u32;
    while *index < data.len() && shift < 64 {
        let byte = data[*index];
        *index += 1;
        value |= u64::from(byte & 0x7f) << shift;
        if byte & 0x80 == 0 {
            return Some(value);
        }
        shift += 7;
    }
    None
}

fn classify_period(
    start: Option<DateTime<Utc>>,
    end: Option<DateTime<Utc>>,
    web_weekly: bool,
) -> (&'static str, &'static str, Option<u64>) {
    if let (Some(start), Some(end)) = (start, end) {
        let seconds = (end - start).num_seconds();
        if (5 * 86_400..=9 * 86_400).contains(&seconds) {
            return ("weekly", "Weekly", Some(seconds as u64));
        }
        if (25 * 86_400..=35 * 86_400).contains(&seconds) {
            return ("monthly", "Monthly", Some(seconds as u64));
        }
        if seconds > 0 {
            return ("credits", "Included usage", Some(seconds as u64));
        }
    }
    if web_weekly {
        ("weekly", "Weekly", Some(604_800))
    } else {
        ("credits", "Included usage", None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn encode_varint(mut value: u64, output: &mut Vec<u8>) {
        loop {
            let mut byte = (value & 0x7f) as u8;
            value >>= 7;
            if value != 0 {
                byte |= 0x80;
            }
            output.push(byte);
            if value == 0 {
                break;
            }
        }
    }

    fn length_field(field: u64, payload: &[u8], output: &mut Vec<u8>) {
        encode_varint((field << 3) | 2, output);
        encode_varint(payload.len() as u64, output);
        output.extend_from_slice(payload);
    }

    fn varint_field(field: u64, value: u64, output: &mut Vec<u8>) {
        encode_varint(field << 3, output);
        encode_varint(value, output);
    }

    fn fixed32_field(field: u64, value: f32, output: &mut Vec<u8>) {
        encode_varint((field << 3) | 5, output);
        output.extend_from_slice(&value.to_bits().to_le_bytes());
    }

    fn timestamp(seconds: u64) -> Vec<u8> {
        let mut message = Vec::new();
        varint_field(1, seconds, &mut message);
        message
    }

    fn fixture(percent: Option<f32>, start: u64, end: u64) -> Vec<u8> {
        let mut usage = Vec::new();
        if let Some(percent) = percent {
            fixed32_field(1, percent, &mut usage);
        }
        let mut period = Vec::new();
        length_field(2, &timestamp(start), &mut period);
        length_field(3, &timestamp(end), &mut period);
        length_field(8, &period, &mut usage);
        let mut root = Vec::new();
        length_field(1, &usage, &mut root);
        let mut framed = vec![0, 0, 0, 0, 0];
        let length = (root.len() as u32).to_be_bytes();
        framed[1..5].copy_from_slice(&length);
        framed.extend_from_slice(&root);
        framed
    }

    #[test]
    fn prefers_supergrok_oidc_credentials() {
        let parsed = parse_credentials(
            r#"{
              "https://accounts.x.ai/sign-in":{"key":"legacy","email":"old@example.com"},
              "https://auth.x.ai::client":{"key":"oidc","auth_mode":"oidc","email":"new@example.com","user_id":"u1","expires_at":"2099-01-01T00:00:00Z"}
            }"#,
        )
        .unwrap();
        assert_eq!(parsed.access_token, "oidc");
        assert_eq!(parsed.email.as_deref(), Some("new@example.com"));
        assert_eq!(parsed.plan(), "SuperGrok");
    }

    #[test]
    fn normalizes_cookie_headers_without_accepting_injection() {
        assert_eq!(
            normalize_cookie_header(" Cookie: session=abc; theme=dark ").unwrap(),
            "session=abc; theme=dark"
        );
        assert!(normalize_cookie_header("session=abc\r\nAuthorization: bad").is_err());
    }

    #[test]
    fn parses_provider_reported_percent_and_weekly_period() {
        let start = (Utc::now().timestamp() - 86_400) as u64;
        let end = start + 7 * 86_400;
        let (percent, parsed_start, parsed_end) =
            parse_web_billing_response(&fixture(Some(42.5), start, end)).unwrap();
        assert!((percent - 42.5).abs() < 0.01);
        assert_eq!(parsed_start.unwrap().timestamp(), start as i64);
        assert_eq!(parsed_end.unwrap().timestamp(), end as i64);
    }

    #[test]
    fn treats_omitted_proto3_percent_as_zero_for_active_period() {
        let start = (Utc::now().timestamp() - 86_400) as u64;
        let end = start + 7 * 86_400;
        let (percent, _, _) = parse_web_billing_response(&fixture(None, start, end)).unwrap();
        assert_eq!(percent, 0.0);
    }

    #[test]
    fn grok_rpc_errors_are_sanitized_for_the_ui() {
        let auth = validate_grpc_status(Some("16"), Some("bad-credentials: leaked session token"));
        assert!(matches!(auth, Err(GrokFetchError::Auth)));
        assert_eq!(
            GrokFetchError::Auth.into_provider_error().to_string(),
            "authentication is required"
        );

        let team = validate_grpc_status(Some("9"), Some("no personal team"));
        assert!(matches!(team, Err(GrokFetchError::TeamUnavailable)));
        assert_eq!(
            GrokFetchError::TeamUnavailable.into_provider_error().to_string(),
            "Grok team usage is unavailable from the current billing surface."
        );

        let leaked = validate_grpc_status(Some("13"), Some("internal: cookie=abc; Authorization: Bearer leaked"));
        assert!(matches!(leaked, Err(GrokFetchError::Unavailable)));
        let message = GrokFetchError::Unavailable.into_provider_error().to_string();
        assert_eq!(message, "Grok did not provide current billing usage.");
        assert!(!message.contains("cookie"));
        assert!(!message.contains("Bearer"));
        assert!(!message.contains("leaked"));
    }

    #[test]
    fn default_auth_file_resolves_properly() {
        if let Some(path) = default_auth_file() {
            assert!(path.ends_with(".grok/auth.json") || path.ends_with(".grok\\auth.json"));
            assert!(!path.starts_with("."));
        }
    }
}

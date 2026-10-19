use super::*;

pub(super) const WEB_BILLING_ENDPOINT: &str =
    "https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig";
#[derive(Clone, Debug)]
pub(super) struct BillingSnapshot {
    pub(super) used_percent: f64,
    pub(super) resets_at: Option<DateTime<Utc>>,
    pub(super) period_start: Option<DateTime<Utc>>,
    pub(super) source: &'static str,
}

pub(super) fn usage_from_snapshot(
    account: &Account,
    snapshot: BillingSnapshot,
    bot: Option<BotUsage>,
) -> ProviderUsage {
    let used = snapshot.used_percent.clamp(0.0, 100.0);
    let (id, label, window_seconds) = classify_period(
        snapshot.period_start,
        snapshot.resets_at,
        snapshot.source == "grok_web_billing",
    );
    // The SuperGrok window stays first: the sidebar and alerts take the first
    // weekly window as the account's headline limit.
    let mut windows = vec![UsageWindow {
        id: id.into(),
        label: label.into(),
        used_percent: Some(used),
        remaining_percent: Some((100.0 - used).max(0.0)),
        resets_at: snapshot.resets_at.map(|value| value.to_rfc3339()),
        window_seconds,
        kind: None,
    }];
    if let Some(bot) = bot {
        windows.push(bot_usage_window(&bot));
    }
    ProviderUsage {
        plan: Some(account.plan.clone().unwrap_or_else(|| "Grok".into())),
        email: account.email.clone(),
        provider_account_id: account
            .provider_account_id
            .clone()
            .or_else(|| Some("grok-browser-session".into())),
        windows,
        credits_usd: None,
        unlimited_credits: false,
        source: snapshot.source.into(),
    }
}

pub(super) async fn fetch_web_billing(
    app: &AppState,
    cookie_header: &str,
) -> Result<BillingSnapshot, GrokFetchError> {
    let cookie_header =
        normalize_cookie_header(cookie_header).map_err(|_| GrokFetchError::Unavailable)?;
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

pub(super) fn validate_grpc_status(
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

pub(super) fn grpc_trailer_fields(data: &[u8]) -> HashMap<String, String> {
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
                        fields.insert(key.trim().to_ascii_lowercase(), value.trim().to_string());
                    }
                }
            }
        }
        index = end;
    }
    fields
}

#[derive(Default)]
pub(super) struct ProtobufScan {
    pub(super) fixed32: Vec<Fixed32Field>,
    pub(super) varints: Vec<VarintField>,
}

pub(super) struct Fixed32Field {
    pub(super) path: Vec<u64>,
    pub(super) value: f32,
    pub(super) order: usize,
}

pub(super) struct VarintField {
    pub(super) path: Vec<u64>,
    pub(super) value: u64,
}

impl ProtobufScan {
    pub(super) fn merge(&mut self, mut other: Self) {
        self.fixed32.append(&mut other.fixed32);
        self.varints.append(&mut other.varints);
    }
}

/// Weekly percent used plus the optional window start and reset time.
pub(super) type WebBilling = (f64, Option<DateTime<Utc>>, Option<DateTime<Utc>>);

pub(super) fn parse_web_billing_response(data: &[u8]) -> Result<WebBilling, GrokFetchError> {
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
        .ok_or(GrokFetchError::Unavailable)?;
    Ok((used_percent, period_start, resets_at))
}

pub(super) fn grpc_data_frames(data: &[u8]) -> Vec<Vec<u8>> {
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

pub(super) fn looks_like_protobuf(data: &[u8]) -> bool {
    data.first().is_some_and(|first| {
        let field = first >> 3;
        let wire = first & 0x07;
        field > 0 && matches!(wire, 0 | 1 | 2 | 5)
    })
}

pub(super) fn scan_protobuf(
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
                    let (nested, nested_order) =
                        scan_protobuf(&data[index..end], depth + 1, field_path, next_order);
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

pub(super) fn read_varint(data: &[u8], index: &mut usize) -> Option<u64> {
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

pub(super) fn classify_period(
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
        (
            "weekly",
            "Weekly",
            Some(crate::model::WEEKLY_WINDOW_SECONDS),
        )
    } else {
        ("credits", "Included usage", None)
    }
}

//! Grok's usage page lists reset tokens beside billing. This reads that list
//! with the same cookie the billing request already sent. Field 10 of each
//! token is the handle that would spend it: those bytes are skipped and are
//! never turned into text, stored, or logged. Redeeming stays on grok.com.

use super::*;
use crate::providers::{read_capped_bytes, CappedBodyError, MAX_PROVIDER_BODY_BYTES};

pub(super) const RESETS_ENDPOINT: &str =
    "https://grok.com/prod_mc_billing.ConsumerUiSvc/GetRemainingResets";

const TOKEN: u64 = 10;
const SPEND_HANDLE: u64 = 10;
const VALIDITY_END: u64 = 30;
const TIMESTAMP_SECONDS: u64 = 1;

/// Expiry of each reset token, soonest not applied yet. `Err` is any failed
/// read, including a non-zero grpc status. An empty `Ok` is a real empty list.
pub(super) async fn fetch_remaining_resets(
    app: &AppState,
    cookie_header: &str,
) -> Result<Vec<Option<DateTime<Utc>>>, ()> {
    let cookie_header = normalize_cookie_header(cookie_header).map_err(|_| ())?;
    let response = app
        .client
        .post(RESETS_ENDPOINT)
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
        .map_err(|_| ())?;
    let status = response.status();
    let header_status = response
        .headers()
        .get("grpc-status")
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let body = match read_capped_bytes(response, MAX_PROVIDER_BODY_BYTES).await {
        Ok(body) => body,
        Err(CappedBodyError::TooLarge | CappedBodyError::Unreadable(_)) => return Err(()),
    };
    if !status.is_success() || grpc_status_failed(header_status.as_deref()) {
        return Err(());
    }
    parse_remaining_resets(&body)
}

/// Display rows after a successful billing read. A failed reset read warns
/// once and leaves the list empty, without failing the usage refresh.
pub(super) fn limit_resets_from(
    result: Result<Vec<Option<DateTime<Utc>>>, ()>,
) -> Vec<crate::model::LimitReset> {
    match result {
        Ok(expiries) => crate::providers::limit_resets::from_grok_expiries(expiries, Utc::now()),
        Err(()) => {
            crate::diagnostics::warn("Could not read Grok limit resets. Usage was still updated.");
            Vec::new()
        }
    }
}

pub(super) fn parse_remaining_resets(data: &[u8]) -> Result<Vec<Option<DateTime<Utc>>>, ()> {
    let mut expiries = Vec::new();
    let mut index = 0usize;
    while index < data.len() {
        if index + 5 > data.len() {
            return Err(());
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
            return Err(());
        };
        if end > data.len() {
            return Err(());
        }
        let frame = &data[start..end];
        if flags == 0 {
            parse_message(frame, &mut expiries)?;
        } else if flags == 0x80 {
            if trailer_failed(frame)? {
                return Err(());
            }
        } else {
            return Err(());
        }
        index = end;
    }
    Ok(expiries)
}

fn grpc_status_failed(raw: Option<&str>) -> bool {
    match raw.map(str::trim).filter(|value| !value.is_empty()) {
        None | Some("0") => false,
        Some(_) => true,
    }
}

fn trailer_failed(frame: &[u8]) -> Result<bool, ()> {
    let text = std::str::from_utf8(frame).map_err(|_| ())?;
    for line in text.lines() {
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        if key.trim().eq_ignore_ascii_case("grpc-status") {
            let status = value.trim().parse::<i32>().map_err(|_| ())?;
            return Ok(status != 0);
        }
    }
    Ok(false)
}

fn parse_message(data: &[u8], expiries: &mut Vec<Option<DateTime<Utc>>>) -> Result<(), ()> {
    let mut index = 0usize;
    while index < data.len() {
        let key = read_varint(data, &mut index)?;
        if key == 0 {
            return Err(());
        }
        let field = key >> 3;
        let wire = key & 0x07;
        if field == TOKEN && wire == 2 {
            let token = take_bytes(data, &mut index)?;
            expiries.push(parse_token(token)?);
            continue;
        }
        skip_field(data, &mut index, wire)?;
    }
    Ok(())
}

/// One token. The spend handle is skipped as raw bytes.
fn parse_token(data: &[u8]) -> Result<Option<DateTime<Utc>>, ()> {
    let mut index = 0usize;
    let mut expiry = None;
    while index < data.len() {
        let key = read_varint(data, &mut index)?;
        if key == 0 {
            return Err(());
        }
        let field = key >> 3;
        let wire = key & 0x07;
        if field == SPEND_HANDLE {
            if wire != 2 {
                return Err(());
            }
            let _ = take_bytes(data, &mut index)?;
            continue;
        }
        if field == VALIDITY_END && wire == 2 {
            let stamp = take_bytes(data, &mut index)?;
            expiry = timestamp_seconds(stamp)?;
            continue;
        }
        skip_field(data, &mut index, wire)?;
    }
    Ok(expiry)
}

fn timestamp_seconds(data: &[u8]) -> Result<Option<DateTime<Utc>>, ()> {
    let mut index = 0usize;
    let mut seconds = None;
    while index < data.len() {
        let key = read_varint(data, &mut index)?;
        if key == 0 {
            return Err(());
        }
        let field = key >> 3;
        let wire = key & 0x07;
        if field == TIMESTAMP_SECONDS && wire == 0 {
            let raw = read_varint(data, &mut index)?;
            seconds = i64::try_from(raw)
                .ok()
                .and_then(|value| DateTime::from_timestamp(value, 0));
            continue;
        }
        skip_field(data, &mut index, wire)?;
    }
    Ok(seconds)
}

fn take_bytes<'a>(data: &'a [u8], index: &mut usize) -> Result<&'a [u8], ()> {
    let length = usize::try_from(read_varint(data, index)?).map_err(|_| ())?;
    let end = index.checked_add(length).ok_or(())?;
    if end > data.len() {
        return Err(());
    }
    let bytes = &data[*index..end];
    *index = end;
    Ok(bytes)
}

fn skip_field(data: &[u8], index: &mut usize, wire: u64) -> Result<(), ()> {
    match wire {
        0 => {
            read_varint(data, index)?;
            Ok(())
        }
        1 => advance(index, 8, data.len()),
        2 => {
            let _ = take_bytes(data, index)?;
            Ok(())
        }
        5 => advance(index, 4, data.len()),
        _ => Err(()),
    }
}

fn advance(index: &mut usize, count: usize, len: usize) -> Result<(), ()> {
    let end = index.checked_add(count).ok_or(())?;
    if end > len {
        return Err(());
    }
    *index = end;
    Ok(())
}

fn read_varint(data: &[u8], index: &mut usize) -> Result<u64, ()> {
    super::billing::read_varint(data, index).ok_or(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SPEND_ID: &str = "spend-secret-id";

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

    fn timestamp(seconds: u64) -> Vec<u8> {
        let mut message = Vec::new();
        varint_field(1, seconds, &mut message);
        message
    }

    fn token(end: Option<u64>, extra: Option<&[u8]>) -> Vec<u8> {
        let mut message = Vec::new();
        length_field(SPEND_HANDLE, SPEND_ID.as_bytes(), &mut message);
        if let Some(extra) = extra {
            length_field(4, extra, &mut message);
        }
        if let Some(end) = end {
            length_field(VALIDITY_END, &timestamp(end), &mut message);
        }
        let mut wrapped = Vec::new();
        length_field(TOKEN, &message, &mut wrapped);
        wrapped
    }

    fn frame(flags: u8, payload: &[u8]) -> Vec<u8> {
        let mut framed = vec![flags];
        framed.extend_from_slice(&(payload.len() as u32).to_be_bytes());
        framed.extend_from_slice(payload);
        framed
    }

    #[test]
    fn two_expiries_are_kept_and_the_spend_id_never_appears() {
        let soon = 1_763_337_600u64;
        let later = 1_765_324_800u64;
        let mut payload = token(Some(later), None);
        payload.extend(token(Some(soon), Some(&[0xff, 0xfe])));
        let parsed = parse_remaining_resets(&frame(0, &payload)).unwrap();
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0], DateTime::from_timestamp(later as i64, 0));
        assert_eq!(parsed[1], DateTime::from_timestamp(soon as i64, 0));
        assert!(!format!("{parsed:?}").contains(SPEND_ID));
    }

    #[test]
    fn a_token_with_no_end_is_kept_undated() {
        let parsed = parse_remaining_resets(&frame(0, &token(None, None))).unwrap();
        assert_eq!(parsed, vec![None]);
        assert!(!format!("{parsed:?}").contains(SPEND_ID));
    }

    #[test]
    fn a_grpc_failure_is_not_an_empty_list() {
        let mut body = frame(0, &token(Some(1_763_337_600), None));
        body.extend(frame(
            0x80,
            b"grpc-status: 16\r\ngrpc-message: unauthenticated\r\n",
        ));
        assert!(parse_remaining_resets(&body).is_err());
        assert!(parse_remaining_resets(&frame(0x80, b"grpc-status: 0\r\n")).is_ok());
    }

    #[test]
    fn a_truncated_or_unknown_frame_is_rejected() {
        assert!(parse_remaining_resets(&[0, 0, 0, 0, 10, 1, 2, 3]).is_err());
        assert!(parse_remaining_resets(&[0x01, 0, 0, 0, 0]).is_err());
        let mut illegal = token(Some(1_763_337_600), None);
        illegal.push(0x0f);
        assert!(parse_remaining_resets(&frame(0, &illegal)).is_err());
    }

    #[test]
    fn an_empty_body_is_an_empty_list() {
        assert_eq!(parse_remaining_resets(&[]).unwrap(), Vec::new());
        assert_eq!(
            parse_remaining_resets(&frame(0, &[])).unwrap(),
            Vec::<Option<DateTime<Utc>>>::new()
        );
    }

    #[test]
    fn the_reader_uses_the_cookie_session_and_skips_the_spend_handle() {
        let source = include_str!("resets.rs");
        assert!(source.contains(RESETS_ENDPOINT));
        assert!(source.contains("read_capped_bytes"));
        assert!(source.contains("header::COOKIE"));
        assert!(!source.contains(concat!("token", "_id")));
        assert!(!source.contains(concat!("Redeem", "Reset")));
        assert!(!source.contains(concat!("auth", ".json")));
        assert!(!source.contains(concat!("Author", "ization")));
        assert!(!source.contains(concat!("Bear", "er")));
    }
}

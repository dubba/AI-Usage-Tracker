//! Grok's usage page lists reset tokens beside billing, and spends one with
//! `RedeemReset` on the same grok.com billing service (`ConsumerUiSvc`, the
//! service grok.com's own Usage page calls; xAI does not document it). Both
//! requests use the cookie the billing request already sends. Each token's id
//! (field 10) is what spends it: it is kept only when it is a plain id, sent
//! back only after the person confirms, and never logged.

use super::*;
use crate::providers::limit_resets::{is_valid_grant_id, RedeemOutcome};
use crate::providers::{read_capped_bytes, CappedBodyError, MAX_PROVIDER_BODY_BYTES};

pub(super) const RESETS_ENDPOINT: &str =
    "https://grok.com/prod_mc_billing.ConsumerUiSvc/GetRemainingResets";
pub(super) const REDEEM_ENDPOINT: &str =
    "https://grok.com/prod_mc_billing.ConsumerUiSvc/RedeemReset";

/// `tokens` in the list reply and `still_redeemable` in the redeem reply.
const TOKEN: u64 = 10;
/// `token_id` in a token and in the redeem request.
const TOKEN_ID: u64 = 10;
const VALIDITY_END: u64 = 30;
const TIMESTAMP_SECONDS: u64 = 1;

const SIGN_IN_AGAIN: &str = "Sign in to this account again before using a limit reset.";
const NO_LONGER_AVAILABLE: &str = "That limit reset is no longer available.";
const WAIT_BEFORE_RETRY: &str = "The provider asked to wait before trying that limit reset again.";

/// One reset token: the id that spends it, when it is a plain id, and when it expires.
pub(super) type ResetToken = (Option<String>, Option<DateTime<Utc>>);

/// The grpc-web POST both calls share: grok.com's own headers, and the session cookie.
fn grpc_request(
    app: &AppState,
    url: &str,
    cookie_header: String,
    body: Vec<u8>,
) -> reqwest::RequestBuilder {
    app.client
        .post(url)
        .header(header::COOKIE, cookie_header)
        .header(header::ORIGIN, "https://grok.com")
        .header(header::REFERER, "https://grok.com/?_s=usage")
        .header(header::ACCEPT, "*/*")
        .header(header::CONTENT_TYPE, "application/grpc-web+proto")
        .header("connect-protocol-version", "1")
        .header("x-grpc-web", "1")
        .body(body)
}

fn header_grpc_status(response: &reqwest::Response) -> Option<String> {
    response
        .headers()
        .get("grpc-status")
        .and_then(|value| value.to_str().ok())
        .map(str::to_string)
}

/// Every reset token, soonest not applied yet. `Err` is any failed read,
/// including a non-zero grpc status. An empty `Ok` is a real empty list.
pub(super) async fn fetch_remaining_resets(
    app: &AppState,
    cookie_header: &str,
) -> Result<Vec<ResetToken>, ()> {
    let cookie_header = normalize_cookie_header(cookie_header).map_err(|_| ())?;
    let response = grpc_request(app, RESETS_ENDPOINT, cookie_header, vec![0u8; 5])
        .send()
        .await
        .map_err(|_| ())?;
    let status = response.status();
    let header_status = header_grpc_status(&response);
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
    result: Result<Vec<ResetToken>, ()>,
) -> Vec<crate::model::LimitReset> {
    match result {
        Ok(tokens) => crate::providers::limit_resets::from_grok_tokens(tokens, Utc::now()),
        Err(()) => {
            crate::diagnostics::warn("Could not read Grok limit resets. Usage was still updated.");
            Vec::new()
        }
    }
}

/// Spends one reset token, once. A reply that cannot be read is `Unconfirmed`
/// and is never retried here: the caller refreshes the account instead.
pub(super) async fn redeem_reset(
    app: &AppState,
    cookie_header: &str,
    token_id: &str,
) -> RedeemOutcome {
    if !is_valid_grant_id(token_id) {
        return RedeemOutcome::Rejected(NO_LONGER_AVAILABLE);
    }
    let Ok(cookie_header) = normalize_cookie_header(cookie_header) else {
        return RedeemOutcome::Rejected(SIGN_IN_AGAIN);
    };
    let response = match grpc_request(app, REDEEM_ENDPOINT, cookie_header, redeem_body(token_id))
        .send()
        .await
    {
        Ok(response) => response,
        Err(_) => return RedeemOutcome::Unconfirmed,
    };
    let status = response.status();
    let header_status = header_grpc_status(&response);
    let body = read_capped_bytes(response, MAX_PROVIDER_BODY_BYTES)
        .await
        .ok();
    interpret_redeem(status, header_status.as_deref(), body.as_deref(), token_id)
}

/// `ConsumerRedeemResetReq { token_id = 10 }` in one grpc-web data frame.
fn redeem_body(token_id: &str) -> Vec<u8> {
    let mut message = Vec::new();
    write_varint((TOKEN_ID << 3) | 2, &mut message);
    write_varint(token_id.len() as u64, &mut message);
    message.extend_from_slice(token_id.as_bytes());
    let mut framed = vec![0u8];
    framed.extend_from_slice(&(message.len() as u32).to_be_bytes());
    framed.extend_from_slice(&message);
    framed
}

fn write_varint(mut value: u64, output: &mut Vec<u8>) {
    loop {
        let byte = (value & 0x7f) as u8;
        value >>= 7;
        if value == 0 {
            output.push(byte);
            return;
        }
        output.push(byte | 0x80);
    }
}

/// Spent only on an explicit grpc OK whose `still_redeemable` list no longer
/// has the token. The grpc codes that mean the call was refused are refusals;
/// anything else may have spent it.
pub(super) fn interpret_redeem(
    status: StatusCode,
    header_status: Option<&str>,
    body: Option<&[u8]>,
    token_id: &str,
) -> RedeemOutcome {
    if status == StatusCode::TOO_MANY_REQUESTS {
        return RedeemOutcome::Rejected(WAIT_BEFORE_RETRY);
    }
    if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN {
        return RedeemOutcome::Rejected(SIGN_IN_AGAIN);
    }
    if !status.is_success() {
        return RedeemOutcome::Unconfirmed;
    }
    let Some(body) = body else {
        return RedeemOutcome::Unconfirmed;
    };
    let Ok((tokens, trailer_status)) = parse_frames(body) else {
        return RedeemOutcome::Unconfirmed;
    };
    let header_status = header_status
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .and_then(|value| value.parse::<i32>().ok());
    match header_status.or(trailer_status) {
        Some(0) if tokens.iter().any(|(id, _)| id.as_deref() == Some(token_id)) => {
            RedeemOutcome::Unconfirmed
        }
        Some(0) => RedeemOutcome::Spent,
        // UNAUTHENTICATED, PERMISSION_DENIED
        Some(16 | 7) => RedeemOutcome::Rejected(SIGN_IN_AGAIN),
        // INVALID_ARGUMENT, NOT_FOUND, FAILED_PRECONDITION
        Some(3 | 5 | 9) => RedeemOutcome::Rejected(NO_LONGER_AVAILABLE),
        // RESOURCE_EXHAUSTED
        Some(8) => RedeemOutcome::Rejected(WAIT_BEFORE_RETRY),
        _ => RedeemOutcome::Unconfirmed,
    }
}

pub(super) fn parse_remaining_resets(data: &[u8]) -> Result<Vec<ResetToken>, ()> {
    let (tokens, trailer_status) = parse_frames(data)?;
    match trailer_status {
        None | Some(0) => Ok(tokens),
        Some(_) => Err(()),
    }
}

/// The tokens in a grpc-web body, and the status in its trailer frame if it has one.
fn parse_frames(data: &[u8]) -> Result<(Vec<ResetToken>, Option<i32>), ()> {
    let mut tokens = Vec::new();
    let mut trailer = None;
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
            parse_message(frame, &mut tokens)?;
        } else if flags == 0x80 {
            trailer = trailer_status(frame)?.or(trailer);
        } else {
            return Err(());
        }
        index = end;
    }
    Ok((tokens, trailer))
}

fn grpc_status_failed(raw: Option<&str>) -> bool {
    match raw.map(str::trim).filter(|value| !value.is_empty()) {
        None | Some("0") => false,
        Some(_) => true,
    }
}

fn trailer_status(frame: &[u8]) -> Result<Option<i32>, ()> {
    let text = std::str::from_utf8(frame).map_err(|_| ())?;
    for line in text.lines() {
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        if key.trim().eq_ignore_ascii_case("grpc-status") {
            return value.trim().parse::<i32>().map(Some).map_err(|_| ());
        }
    }
    Ok(None)
}

fn parse_message(data: &[u8], tokens: &mut Vec<ResetToken>) -> Result<(), ()> {
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
            tokens.push(parse_token(token)?);
            continue;
        }
        skip_field(data, &mut index, wire)?;
    }
    Ok(())
}

/// One token. An id that is not a plain id (letters, digits, `-`, `_`) is dropped as raw bytes,
/// so it is never turned into text, stored, or sent back.
fn parse_token(data: &[u8]) -> Result<ResetToken, ()> {
    let mut index = 0usize;
    let mut id = None;
    let mut expiry = None;
    while index < data.len() {
        let key = read_varint(data, &mut index)?;
        if key == 0 {
            return Err(());
        }
        let field = key >> 3;
        let wire = key & 0x07;
        if field == TOKEN_ID {
            if wire != 2 {
                return Err(());
            }
            let bytes = take_bytes(data, &mut index)?;
            id = std::str::from_utf8(bytes)
                .ok()
                .filter(|text| is_valid_grant_id(text))
                .map(str::to_string);
            continue;
        }
        if field == VALIDITY_END && wire == 2 {
            let stamp = take_bytes(data, &mut index)?;
            expiry = timestamp_seconds(stamp)?;
            continue;
        }
        skip_field(data, &mut index, wire)?;
    }
    Ok((id, expiry))
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

    const TOKEN_ID_TEXT: &str = "tok-7f3a_01";

    fn encode_varint(value: u64, output: &mut Vec<u8>) {
        write_varint(value, output);
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

    fn token_with(id: &[u8], end: Option<u64>, extra: Option<&[u8]>) -> Vec<u8> {
        let mut message = Vec::new();
        length_field(TOKEN_ID, id, &mut message);
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

    fn token(end: Option<u64>, extra: Option<&[u8]>) -> Vec<u8> {
        token_with(TOKEN_ID_TEXT.as_bytes(), end, extra)
    }

    fn frame(flags: u8, payload: &[u8]) -> Vec<u8> {
        let mut framed = vec![flags];
        framed.extend_from_slice(&(payload.len() as u32).to_be_bytes());
        framed.extend_from_slice(payload);
        framed
    }

    fn ok_reply(payload: &[u8]) -> Vec<u8> {
        let mut body = frame(0, payload);
        body.extend(frame(0x80, b"grpc-status: 0\r\n"));
        body
    }

    #[test]
    fn each_token_keeps_its_id_and_expiry() {
        let soon = 1_763_337_600u64;
        let later = 1_765_324_800u64;
        let mut payload = token_with(b"tok-later", Some(later), None);
        payload.extend(token_with(b"tok-soon", Some(soon), Some(&[0xff, 0xfe])));
        let parsed = parse_remaining_resets(&frame(0, &payload)).unwrap();
        assert_eq!(
            parsed,
            vec![
                (
                    Some("tok-later".into()),
                    DateTime::from_timestamp(later as i64, 0)
                ),
                (
                    Some("tok-soon".into()),
                    DateTime::from_timestamp(soon as i64, 0)
                ),
            ]
        );
    }

    #[test]
    fn an_id_that_is_not_a_plain_id_is_dropped_unread() {
        let odd = "a b/c=";
        let parsed =
            parse_remaining_resets(&frame(0, &token_with(odd.as_bytes(), None, None))).unwrap();
        assert_eq!(parsed, vec![(None, None)]);
        let binary =
            parse_remaining_resets(&frame(0, &token_with(&[0xff, 0x00], None, None))).unwrap();
        assert_eq!(binary, vec![(None, None)]);
        assert!(!format!("{parsed:?}").contains(odd));
    }

    #[test]
    fn a_token_with_no_end_is_kept_undated() {
        let parsed = parse_remaining_resets(&frame(0, &token(None, None))).unwrap();
        assert_eq!(parsed, vec![(Some(TOKEN_ID_TEXT.into()), None)]);
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
            Vec::<ResetToken>::new()
        );
    }

    #[test]
    fn the_redeem_request_is_one_frame_with_the_token_id_as_field_10() {
        let body = redeem_body(TOKEN_ID_TEXT);
        let mut expected = Vec::new();
        length_field(10, TOKEN_ID_TEXT.as_bytes(), &mut expected);
        assert_eq!(body, frame(0, &expected));
        assert_eq!(body[5], 0x52);

        // A 128-character id needs a two-byte length.
        let long = "a".repeat(128);
        let body = redeem_body(&long);
        assert_eq!(&body[5..8], &[0x52, 0x80, 0x01]);
        assert_eq!(body.len(), 5 + 3 + 128);
    }

    #[test]
    fn a_redeem_is_spent_only_on_grpc_ok_without_the_token_in_the_reply() {
        let ok = StatusCode::OK;
        let others = token_with(b"tok-other", Some(1_765_324_800), None);
        assert_eq!(
            interpret_redeem(ok, None, Some(&ok_reply(&others)), TOKEN_ID_TEXT),
            RedeemOutcome::Spent
        );
        assert_eq!(
            interpret_redeem(ok, None, Some(&ok_reply(&[])), TOKEN_ID_TEXT),
            RedeemOutcome::Spent
        );
        assert_eq!(
            interpret_redeem(ok, Some("0"), Some(&frame(0, &[])), TOKEN_ID_TEXT),
            RedeemOutcome::Spent
        );
        // Still listed, no status, unreadable, or no body: it may or may not have been spent.
        let still = token(Some(1_765_324_800), None);
        for body in [ok_reply(&still), frame(0, &[]), vec![0x01, 0, 0]] {
            assert_eq!(
                interpret_redeem(ok, None, Some(&body), TOKEN_ID_TEXT),
                RedeemOutcome::Unconfirmed
            );
        }
        assert_eq!(
            interpret_redeem(ok, None, None, TOKEN_ID_TEXT),
            RedeemOutcome::Unconfirmed
        );
    }

    #[test]
    fn a_refused_redeem_says_why_and_anything_else_is_unconfirmed() {
        let ok = StatusCode::OK;
        let status = |code: &str| {
            let mut body = frame(0, &[]);
            body.extend(frame(0x80, format!("grpc-status: {code}\r\n").as_bytes()));
            interpret_redeem(ok, None, Some(&body), TOKEN_ID_TEXT)
        };
        assert_eq!(status("16"), RedeemOutcome::Rejected(SIGN_IN_AGAIN));
        assert_eq!(status("7"), RedeemOutcome::Rejected(SIGN_IN_AGAIN));
        assert_eq!(status("5"), RedeemOutcome::Rejected(NO_LONGER_AVAILABLE));
        assert_eq!(status("9"), RedeemOutcome::Rejected(NO_LONGER_AVAILABLE));
        assert_eq!(status("3"), RedeemOutcome::Rejected(NO_LONGER_AVAILABLE));
        assert_eq!(status("8"), RedeemOutcome::Rejected(WAIT_BEFORE_RETRY));
        assert_eq!(status("13"), RedeemOutcome::Unconfirmed);
        assert_eq!(status("14"), RedeemOutcome::Unconfirmed);
        // A trailers-only reply carries its status in the headers.
        assert_eq!(
            interpret_redeem(ok, Some("5"), Some(&[]), TOKEN_ID_TEXT),
            RedeemOutcome::Rejected(NO_LONGER_AVAILABLE)
        );

        let empty = Some(&[][..]);
        assert_eq!(
            interpret_redeem(StatusCode::TOO_MANY_REQUESTS, None, empty, TOKEN_ID_TEXT),
            RedeemOutcome::Rejected(WAIT_BEFORE_RETRY)
        );
        assert_eq!(
            interpret_redeem(StatusCode::UNAUTHORIZED, None, empty, TOKEN_ID_TEXT),
            RedeemOutcome::Rejected(SIGN_IN_AGAIN)
        );
        assert_eq!(
            interpret_redeem(StatusCode::FORBIDDEN, None, empty, TOKEN_ID_TEXT),
            RedeemOutcome::Rejected(SIGN_IN_AGAIN)
        );
        assert_eq!(
            interpret_redeem(StatusCode::BAD_GATEWAY, None, empty, TOKEN_ID_TEXT),
            RedeemOutcome::Unconfirmed
        );
    }

    #[test]
    fn both_calls_use_the_cookie_session_and_the_redeem_never_logs_or_retries() {
        let source = include_str!("resets.rs");
        let source = &source[..source.find("#[cfg(test)]").unwrap()];
        assert!(source.contains(RESETS_ENDPOINT));
        assert!(source.contains(REDEEM_ENDPOINT));
        assert!(source.contains("read_capped_bytes"));
        assert!(source.contains("header::COOKIE"));
        // Never the Grok Build CLI's credentials.
        assert!(!source.contains(concat!("auth", ".json")));
        assert!(!source.contains(concat!("Author", "ization")));
        assert!(!source.contains(concat!("Bear", "er")));
        let redeem = source.find("pub(super) async fn redeem_reset").unwrap();
        let body = &source[redeem..redeem + source[redeem..].find("\n}\n").unwrap()];
        assert!(!body.contains("diagnostics"));
        assert_eq!(body.matches(".send()").count(), 1);
    }
}

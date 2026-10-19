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
fn normalizes_cookie_headers_without_accepting_injection() {
    assert_eq!(
        normalize_cookie_header(" Cookie: session=abc; theme=dark ").unwrap(),
        "session=abc"
    );
    assert!(normalize_cookie_header("session=abc\r\nAuthorization: bad").is_err());
    assert!(normalize_cookie_header("theme=dark; twid=u123").is_err());
}

#[test]
fn drops_unrelated_cookies_from_stored_headers() {
    let mega = "sso=grok-session; auth_token=maybe-grok; twid=u=123; ct0=twitter; theme=dark; guest_id=v1%3A1; __cf_bm=bot";
    assert_eq!(
        normalize_cookie_header(mega).unwrap(),
        "auth_token=maybe-grok; sso=grok-session"
    );
    assert!(has_grok_session_cookie(
        &normalize_cookie_header(mega).unwrap()
    ));
}

#[test]
fn allows_only_grok_and_accounts_xai_cookie_hosts() {
    assert!(is_allowed_cookie_host("grok.com"));
    assert!(is_allowed_cookie_host("www.grok.com"));
    assert!(is_allowed_cookie_host("accounts.x.ai"));
    assert!(!is_allowed_cookie_host("x.com"));
    assert!(!is_allowed_cookie_host("x.ai"));
    assert!(!is_allowed_cookie_host("auth.x.ai"));
    assert!(!is_allowed_cookie_host("api.x.ai"));
    assert!(!is_allowed_cookie_host("notgrok.com"));
    for target in GROK_COOKIE_URLS {
        let host = url::Url::parse(target)
            .unwrap()
            .host_str()
            .unwrap()
            .to_string();
        assert!(is_allowed_cookie_host(&host), "{target}");
    }
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
        GrokFetchError::TeamUnavailable
            .into_provider_error()
            .to_string(),
        "Grok team usage is unavailable from the current billing surface."
    );

    let leaked = validate_grpc_status(
        Some("13"),
        Some("internal: cookie=abc; Authorization: Bearer leaked"),
    );
    assert!(matches!(leaked, Err(GrokFetchError::Unavailable)));
    let message = GrokFetchError::Unavailable
        .into_provider_error()
        .to_string();
    assert_eq!(message, "Grok did not provide current billing usage.");
    assert!(!message.contains("cookie"));
    assert!(!message.contains("Bearer"));
    assert!(!message.contains("leaked"));
}

#[test]
fn extracts_email_from_jwt_and_cookie_header() {
    // Sample JWT payload with email: {"sub":"123","email":"test.user@example.com"}
    let jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMiLCJlbWFpbCI6InRlc3QudXNlckBleGFtcGxlLmNvbSJ9.signature";
    assert_eq!(
        extract_identity_from_jwt(jwt).as_deref(),
        Some("test.user@example.com")
    );

    let cookie_header = format!("sso-token={jwt}; theme=dark; session=active");
    assert_eq!(
        extract_identity_from_cookies(&cookie_header).as_deref(),
        Some("test.user@example.com")
    );

    let plain_cookie = "email=user%40example.com; path=/";
    assert_eq!(
        extract_identity_from_cookies(plain_cookie).as_deref(),
        Some("user@example.com")
    );
}

#[test]
fn parses_bot_usage_frames_and_reset_timestamp() {
    assert_eq!(
        classify_bot_frame(r#"{"connection_id":"conn-1","capabilities":["bot.usage"]}"#),
        BotFrame::HelloAck
    );
    assert_eq!(
        classify_bot_frame(r#"{"method":"ping","ts_ms":1792136773000}"#),
        BotFrame::Ping(Some(1_792_136_773_000))
    );

    let reply = r#"{
        "jsonrpc": "2.0",
        "id": "1",
        "result": {
            "usagePercent": 1.0,
            "currentPeriodStartMs": 1792093380000,
            "nextResetAtMs": 1792698180000,
            "hasAvailableUsage": true,
            "hasNonZeroIncludedLimit": true,
            "includedLimitZero": false,
            "trial": false,
            "isTeamSeat": false,
            "fundingPlan": "supergrok_heavy",
            "planLabel": "SuperGrok Heavy",
            "manageUrl": "https://grok.com/?_s=billing",
            "onDemandEligible": true,
            "onDemandEnabled": false
        }
    }"#;
    let BotFrame::Usage(Some(bot)) = classify_bot_frame(reply) else {
        panic!("expected parsed bot usage");
    };
    assert!((bot.used_percent - 1.0).abs() < f64::EPSILON);
    assert_eq!(
        bot.period_start.unwrap().timestamp_millis(),
        1_792_093_380_000
    );
    assert_eq!(bot.resets_at.unwrap().timestamp_millis(), 1_792_698_180_000);
}

#[test]
fn omits_bot_usage_when_plan_has_no_included_bot_limit() {
    let excluded = r#"{
        "jsonrpc": "2.0",
        "id": "1",
        "result": {
            "usagePercent": 0.0,
            "currentPeriodStartMs": 1792093380000,
            "hasAvailableUsage": false,
            "hasNonZeroIncludedLimit": false,
            "includedLimitZero": true
        }
    }"#;
    assert_eq!(classify_bot_frame(excluded), BotFrame::Usage(None));

    let rpc_error = r#"{
        "jsonrpc": "2.0",
        "id": "1",
        "error": {"code": -32000, "message": "no_plan", "data": {"cookie": "sso=secret"}}
    }"#;
    assert_eq!(classify_bot_frame(rpc_error), BotFrame::Usage(None));

    let other_id = r#"{"jsonrpc":"2.0","id":"99","result":{"currentPeriodStartMs":1792093380000,"usagePercent":5.0,"hasNonZeroIncludedLimit":true}}"#;
    assert_eq!(classify_bot_frame(other_id), BotFrame::Ignored);
    assert_eq!(classify_bot_frame("not-json"), BotFrame::Ignored);
}

#[test]
fn appends_grok_bot_window_after_supergrok_weekly_window() {
    let account = Account {
        id: "acc-1".into(),
        label: "Grok".into(),
        provider: crate::model::Provider::Grok,
        email: Some("user@example.com".into()),
        provider_account_id: Some("grok-browser-session".into()),
        chatgpt_account_id: None,
        plan: Some("SuperGrok Heavy".into()),
        created_at: String::new(),
        updated_at: String::new(),
        last_usage: None,
        last_error: None,
        auth_required: false,
    };
    let supergrok_reset = Utc.timestamp_opt(1_792_477_920, 0).single().unwrap();
    let bot_start = Utc.timestamp_opt(1_792_093_380, 0).single().unwrap();
    let bot_reset = Utc.timestamp_opt(1_792_698_180, 0).single().unwrap();
    let snapshot = BillingSnapshot {
        used_percent: 62.0,
        resets_at: Some(supergrok_reset),
        period_start: Some(supergrok_reset - chrono::Duration::days(7)),
        source: "grok_web_billing",
    };
    let bot = BotUsage {
        used_percent: 1.0,
        period_start: Some(bot_start),
        resets_at: Some(bot_reset),
    };

    let usage = usage_from_snapshot(&account, snapshot, Some(bot));
    assert_eq!(usage.windows.len(), 2);
    assert_eq!(usage.windows[0].id, "weekly");
    assert_eq!(usage.windows[0].label, "Weekly");
    assert_eq!(usage.windows[0].used_percent, Some(62.0));
    assert_eq!(usage.windows[0].remaining_percent, Some(38.0));
    assert_eq!(
        usage.windows[0].resets_at.as_deref(),
        Some(supergrok_reset.to_rfc3339().as_str())
    );

    assert_eq!(usage.windows[1].id, "grok_bot");
    assert_eq!(usage.windows[1].label, "Grok Bot weekly");
    assert_eq!(usage.windows[1].used_percent, Some(1.0));
    assert_eq!(usage.windows[1].remaining_percent, Some(99.0));
    assert_eq!(
        usage.windows[1].resets_at.as_deref(),
        Some(bot_reset.to_rfc3339().as_str())
    );
    assert_eq!(usage.windows[1].window_seconds, Some(604_800));
}

#[tokio::test]
async fn bot_usage_validates_relay_host_cookies_and_bounds() {
    let relay = url::Url::parse(BOT_RELAY_URL).unwrap();
    assert_eq!(relay.scheme(), "wss");
    assert!(is_allowed_cookie_host(relay.host_str().unwrap()));

    // Header injection or missing session cookies must fail closed before dialing.
    assert!(fetch_bot_usage("sso=abc\r\nX-Injected: 1").await.is_none());
    assert!(fetch_bot_usage("theme=dark").await.is_none());

    // Out-of-bounds percentages are clamped and out-of-range timestamps are dropped.
    let clamped = parse_bot_usage(&json!({
        "usagePercent": 145.0,
        "currentPeriodStartMs": 1_792_093_380_000_i64,
        "nextResetAtMs": 9_999_999_999_999_i64,
        "hasNonZeroIncludedLimit": true
    }))
    .unwrap();
    assert_eq!(clamped.used_percent, 100.0);
    assert!(clamped.resets_at.is_none());
}

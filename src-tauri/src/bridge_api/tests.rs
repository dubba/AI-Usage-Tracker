use super::*;
use crate::state::AppState;
use std::net::{IpAddr, Ipv4Addr};

fn test_app() -> Arc<AppState> {
    let directory = tempfile::tempdir().unwrap();
    Arc::new(
        AppState::new(
            directory.path().to_path_buf(),
            "test-bridge-token-32-chars-minimum-xx".into(),
        )
        .unwrap(),
    )
}

fn host_header(value: &str) -> HeaderValue {
    HeaderValue::from_str(value).unwrap()
}

fn loopback_headers() -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(HOST, host_header(&format!("127.0.0.1:{BRIDGE_PORT}")));
    headers.insert(
        AUTHORIZATION,
        HeaderValue::from_static("Bearer test-bridge-token-32-chars-minimum-xx"),
    );
    headers
}

fn loopback_ip() -> IpAddr {
    IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1))
}

#[tokio::test]
async fn controller_stays_off_and_reports_why_when_the_token_is_unavailable() {
    let app = test_app();
    app.settings.set_paseo_bridge_enabled(true).unwrap();
    app.set_bridge_unavailable(Some("token unavailable".into()));

    let controller = tokio::spawn(run_controller(app.clone()));
    let reported = tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if app.api_runtime.read().error.as_deref() == Some("token unavailable") {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await;
    controller.abort();

    assert!(reported.is_ok(), "the reason must reach the bridge status");
    assert!(!app.api_runtime.read().running);
}

#[test]
fn constant_time_equal_compares_accurately() {
    assert!(constant_time_equal(b"correct-token", b"correct-token"));
    assert!(!constant_time_equal(b"short", b"longer-token"));
    assert!(!constant_time_equal(b"longer-token", b"short"));
    assert!(!constant_time_equal(b"wrong-token", b"correct-token"));
    assert!(constant_time_equal(b"", b""));
}

#[test]
fn local_api_requires_bearer_token() {
    let app = test_app();
    assert!(!authorized(&app, &HeaderMap::new()));

    let mut headers = HeaderMap::new();
    headers.insert(
        AUTHORIZATION,
        HeaderValue::from_static("Bearer wrong-token"),
    );
    assert!(!authorized(&app, &headers));

    headers.insert(
        AUTHORIZATION,
        HeaderValue::from_static("Bearer test-bridge-token-32-chars-minimum-xx"),
    );
    assert!(authorized(&app, &headers));
}

#[test]
fn host_validation_rejects_rebinding_hosts() {
    let mut headers = HeaderMap::new();
    assert!(!host_valid(&headers));

    headers.insert(HOST, HeaderValue::from_static("evil.com"));
    assert!(!host_valid(&headers));

    headers.insert(HOST, HeaderValue::from_static("127.0.0.1.evil.com"));
    assert!(!host_valid(&headers));

    headers.insert(HOST, host_header(&format!("127.0.0.1:{BRIDGE_PORT}")));
    assert!(host_valid(&headers));

    headers.insert(HOST, host_header(&format!("localhost:{BRIDGE_PORT}")));
    assert!(host_valid(&headers));
}

/// The exact strings the allowlists accept. Spelled out on purpose, so widening them (or
/// changing the port) fails here and has to be done knowingly.
fn sample_account() -> Account {
    Account {
        id: "local-account-id".into(),
        label: "Personal Claude".into(),
        provider: crate::model::Provider::Anthropic,
        email: Some("person@example.com".into()),
        provider_account_id: Some("provider-account-id".into()),
        chatgpt_account_id: None,
        plan: Some("max".into()),
        created_at: "2026-09-03T11:00:00Z".into(),
        updated_at: "2026-09-03T11:00:00Z".into(),
        last_usage: Some(crate::model::UsageSnapshot {
            plan: Some("max".into()),
            email: None,
            windows: vec![crate::model::UsageWindow {
                id: "five_hour".into(),
                label: "5 hour".into(),
                used_percent: Some(18.0),
                remaining_percent: Some(82.0),
                resets_at: Some("2026-09-03T17:00:00Z".into()),
                window_seconds: Some(18_000),
                kind: None,
            }],
            credits_usd: None,
            unlimited_credits: false,
            fetched_at: "2026-09-03T12:00:00Z".into(),
            freshness: UsageFreshness::Live,
            source: "anthropic_oauth_usage".into(),
        }),
        last_error: None,
        auth_required: false,
    }
}

/// The public API is a contract with other tools (README, "Response contract"). Its JSON is
/// pinned here at every level, so a field added to the app's own model cannot leak into it.
#[test]
fn usage_response_matches_the_documented_contract_exactly() {
    let response = PublicUsageResponse {
        schema_version: 1,
        generated_at: "2026-09-03T12:00:00Z".into(),
        accounts: public_accounts(vec![sample_account()]),
    };
    let expected = json!({
        "schemaVersion": 1,
        "generatedAt": "2026-09-03T12:00:00Z",
        "accounts": [{
            "id": "local-account-id",
            "label": "Personal Claude",
            "provider": "anthropic",
            "email": "person@example.com",
            "providerAccountId": "provider-account-id",
            "plan": "max",
            "status": "available",
            "source": "anthropic_oauth_usage",
            "windows": [{
                "id": "five_hour",
                "label": "5 hour",
                "usedPercent": 18.0,
                "remainingPercent": 82.0,
                "resetsAt": "2026-09-03T17:00:00Z",
                "windowSeconds": 18000
            }],
            "creditsUsd": null,
            "fetchedAt": "2026-09-03T12:00:00Z",
            "error": null
        }]
    });
    assert_eq!(serde_json::to_value(&response).unwrap(), expected);
}

#[test]
fn allowlists_accept_exactly_these_hosts_and_origins() {
    assert_eq!(
        allowed_hosts(),
        [
            "127.0.0.1:47831",
            "localhost:47831",
            "127.0.0.1",
            "localhost"
        ]
    );
    assert_eq!(
        allowed_origins(),
        [
            "http://127.0.0.1:47831",
            "http://localhost:47831",
            "http://127.0.0.1",
            "http://localhost"
        ]
    );
    assert_eq!(bridge_origin(), "http://127.0.0.1:47831");
    assert_eq!(bridge_endpoint(), "http://127.0.0.1:47831/v1/paseo-usage");
    assert_eq!(API_ADDR.to_string(), "127.0.0.1:47831");
}

#[test]
fn host_and_origin_matching_is_exact_and_case_insensitive() {
    for host in ["LOCALHOST:47831", "Localhost", "127.0.0.1:47831"] {
        let mut headers = HeaderMap::new();
        headers.insert(HOST, host_header(host));
        assert!(host_valid(&headers), "{host}");
    }
    for host in [
        "127.0.0.1:47832",
        "127.0.0.1:",
        "localhost:80",
        "127.0.0.2",
        "[::1]",
        "0.0.0.0:47831",
        "127.0.0.1:47831.evil.com",
        " 127.0.0.1",
    ] {
        let mut headers = HeaderMap::new();
        headers.insert(HOST, host_header(host));
        assert!(!host_valid(&headers), "{host}");
    }
    for origin in ["http://LOCALHOST", "http://127.0.0.1:47831"] {
        assert!(is_loopback_origin(origin), "{origin}");
    }
    for origin in [
        "https://127.0.0.1:47831",
        "http://127.0.0.1:1",
        "http://localhost.evil.com",
        "http://127.0.0.1:47831/",
        "null",
    ] {
        assert!(!is_loopback_origin(origin), "{origin}");
    }
}

#[test]
fn origin_validation_allows_native_and_same_origin() {
    let headers = HeaderMap::new();
    assert!(origin_allowed(&headers));

    let mut same = HeaderMap::new();
    same.insert(ORIGIN, host_header(&bridge_origin()));
    assert!(origin_allowed(&same));

    let mut cross = HeaderMap::new();
    cross.insert(ORIGIN, HeaderValue::from_static("http://evil.com"));
    assert!(!origin_allowed(&cross));

    let mut referer = HeaderMap::new();
    referer.insert(REFERER, HeaderValue::from_static("http://evil.com/page"));
    assert!(!origin_allowed(&referer));
}

#[test]
fn local_api_rate_limits_per_client_ip() {
    let app = test_app();
    let client_a: IpAddr = "127.0.0.1".parse().unwrap();
    let client_b: IpAddr = "127.0.0.2".parse().unwrap();
    let start = Instant::now();

    // A burst is allowed, then the client is limited.
    for _ in 0..RATE_LIMIT_BURST as usize {
        assert!(!rate_limited_at(
            &app,
            client_a,
            RateLane::Authorized,
            start
        ));
    }
    assert!(rate_limited_at(&app, client_a, RateLane::Authorized, start));

    // A different loopback client has its own budget.
    assert!(!rate_limited_at(
        &app,
        client_b,
        RateLane::Authorized,
        start
    ));

    // One request per second comes back, but not a full burst at once.
    let later = start + Duration::from_millis(1100);
    assert!(!rate_limited_at(
        &app,
        client_a,
        RateLane::Authorized,
        later
    ));
    assert!(rate_limited_at(&app, client_a, RateLane::Authorized, later));

    // After a long idle time the whole burst is available again, no more.
    let much_later = start + Duration::from_secs(30);
    for _ in 0..RATE_LIMIT_BURST as usize {
        assert!(!rate_limited_at(
            &app,
            client_a,
            RateLane::Authorized,
            much_later
        ));
    }
    assert!(rate_limited_at(
        &app,
        client_a,
        RateLane::Authorized,
        much_later
    ));
}

#[test]
fn bad_requests_cannot_use_up_the_token_holders_budget() {
    let app = test_app();
    let client: IpAddr = "127.0.0.1".parse().unwrap();
    let mut bad = HeaderMap::new();
    bad.insert(
        AUTHORIZATION,
        HeaderValue::from_static("Bearer wrong-token"),
    );
    let mut good = HeaderMap::new();
    good.insert(
        AUTHORIZATION,
        HeaderValue::from_static("Bearer test-bridge-token-32-chars-minimum-xx"),
    );
    let status = |result: Result<(), axum::response::Response>| match result {
        Ok(()) => StatusCode::OK,
        Err(response) => response.status(),
    };

    // Another local process sends bad requests until it is throttled...
    for _ in 0..RATE_LIMIT_BURST as usize {
        assert_eq!(status(admit(&app, client, &bad)), StatusCode::UNAUTHORIZED);
    }
    assert_eq!(
        status(admit(&app, client, &bad)),
        StatusCode::TOO_MANY_REQUESTS
    );
    // ...and the client with the token, on the same address, is still served.
    assert_eq!(status(admit(&app, client, &good)), StatusCode::OK);
    assert_eq!(
        status(admit(&app, client, &HeaderMap::new())),
        StatusCode::TOO_MANY_REQUESTS
    );
}

#[test]
fn idle_rate_limit_entries_are_pruned() {
    let app = test_app();
    let start = Instant::now();
    for last in 1..=50u8 {
        let client: IpAddr = format!("127.0.0.{last}").parse().unwrap();
        assert!(!rate_limited_at(&app, client, RateLane::Authorized, start));
    }
    assert_eq!(app.bridge_rate_limit.lock().len(), 50);
    let client: IpAddr = "127.0.1.1".parse().unwrap();
    rate_limited_at(
        &app,
        client,
        RateLane::Authorized,
        start + RATE_LIMIT_ENTRY_TTL * 2,
    );
    assert_eq!(app.bridge_rate_limit.lock().len(), 1);
}

#[test]
fn rate_limit_response_includes_retry_after() {
    let response = too_many_requests();
    assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(
        response
            .headers()
            .get(axum::http::header::RETRY_AFTER)
            .and_then(|value| value.to_str().ok()),
        Some("1")
    );
}

#[test]
fn responses_carry_defensive_headers() {
    for response in [unauthorized(), forbidden(), too_many_requests()] {
        assert_eq!(
            response
                .headers()
                .get("cache-control")
                .and_then(|v| v.to_str().ok()),
            Some("no-store")
        );
        assert_eq!(
            response
                .headers()
                .get("x-content-type-options")
                .and_then(|v| v.to_str().ok()),
            Some("nosniff")
        );
    }
    let _ = (loopback_headers(), loopback_ip());
}

#[test]
fn security_headers_are_set_and_override_the_handler() {
    let mut response = Json(json!({ "ok": true })).into_response();
    response.headers_mut().insert(
        "cache-control",
        HeaderValue::from_static("private, max-age=5"),
    );
    let headers = with_security_headers(response).headers().clone();
    assert_eq!(headers["cache-control"], "no-store");
    assert_eq!(headers["x-content-type-options"], "nosniff");
    assert_eq!(headers["referrer-policy"], "no-referrer");
    assert_eq!(headers["x-frame-options"], "DENY");
    assert_eq!(
        headers["content-security-policy"],
        "default-src 'none'; frame-ancestors 'none'"
    );
    assert_eq!(headers["cross-origin-resource-policy"], "same-origin");
}

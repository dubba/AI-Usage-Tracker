use crate::{
    model::{now_rfc3339, PublicUsageAccount, PublicUsageResponse, UsageFreshness},
    state::AppState,
};
use axum::{
    extract::{ConnectInfo, State},
    http::{
        header::{AUTHORIZATION, HOST, ORIGIN, REFERER},
        HeaderMap, HeaderValue, StatusCode,
    },
    response::IntoResponse,
    routing::get,
    Json, Router,
};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    net::{IpAddr, SocketAddr},
    sync::Arc,
    time::{Duration, Instant},
};
use subtle::ConstantTimeEq;
use tokio::net::TcpListener;

const API_ADDR: &str = "127.0.0.1:47831";
const RETRY_DELAY_SECONDS: u64 = 3;
/// A client may make this many requests back to back...
const RATE_LIMIT_BURST: f64 = 10.0;
/// ...and then one more per second. Local tools that poll together (Paseo and a
/// script, say) no longer throttle each other, while a runaway loop still is.
const RATE_LIMIT_REFILL_PER_SECOND: f64 = 1.0;
/// Prune per-client rate-limit entries older than this to bound memory.
const RATE_LIMIT_ENTRY_TTL: Duration = Duration::from_secs(60);

pub async fn run_controller(app: Arc<AppState>) {
    loop {
        if !app.settings.paseo_bridge_enabled() {
            set_runtime(&app, false, None);
            app.settings.wait_for_bridge_state_change().await;
            continue;
        }
        if let Some(reason) = app.bridge_unavailable() {
            set_runtime(&app, false, Some(reason));
            app.settings.wait_for_bridge_state_change().await;
            continue;
        }

        match TcpListener::bind(API_ADDR).await {
            Ok(listener) => {
                set_runtime(&app, true, None);
                let router = Router::new()
                    .route("/v1/health", get(health))
                    .route("/v1/paseo-usage", get(usage))
                    .with_state(app.clone());
                let shutdown_state = app.clone();
                let server = axum::serve(
                    listener,
                    router.into_make_service_with_connect_info::<SocketAddr>(),
                )
                .with_graceful_shutdown(async move {
                    loop {
                        shutdown_state.settings.wait_for_bridge_state_change().await;
                        if !shutdown_state.settings.paseo_bridge_enabled() {
                            break;
                        }
                    }
                });

                match server.await {
                    Ok(()) => set_runtime(&app, false, None),
                    Err(error) => {
                        set_runtime(&app, false, Some(format!("Local API stopped: {error}")));
                        if app.settings.paseo_bridge_enabled() {
                            tokio::time::sleep(std::time::Duration::from_secs(RETRY_DELAY_SECONDS))
                                .await;
                        }
                    }
                }
            }
            Err(error) => {
                set_runtime(
                    &app,
                    false,
                    Some(format!("Unable to bind {API_ADDR}: {error}")),
                );
                tokio::select! {
                    _ = tokio::time::sleep(std::time::Duration::from_secs(RETRY_DELAY_SECONDS)) => {},
                    _ = app.settings.wait_for_bridge_state_change() => {},
                }
            }
        }
    }
}

fn set_runtime(app: &AppState, running: bool, error: Option<String>) {
    let mut runtime = app.api_runtime.write();
    runtime.running = running;
    runtime.error = error;
}

fn with_security_headers(mut response: axum::response::Response) -> axum::response::Response {
    let headers = response.headers_mut();
    for (name, value) in [
        ("cache-control", "no-store"),
        ("x-content-type-options", "nosniff"),
        ("referrer-policy", "no-referrer"),
        ("x-frame-options", "DENY"),
        (
            "content-security-policy",
            "default-src 'none'; frame-ancestors 'none'",
        ),
        ("cross-origin-resource-policy", "same-origin"),
    ] {
        // Replaces any value the handler set: these headers must always win.
        let _ = headers.try_insert(name, HeaderValue::from_static(value));
    }
    response
}

/// Rejects DNS-rebinding style requests where the Host header is not the
/// loopback address. Browsers send the attacked hostname (e.g. evil.com) in
/// Host even when it resolves to 127.0.0.1, so this gates browser access.
fn host_valid(headers: &HeaderMap) -> bool {
    let Some(host) = headers.get(HOST).and_then(|v| v.to_str().ok()) else {
        return false;
    };
    matches!(
        host.to_ascii_lowercase().as_str(),
        "127.0.0.1:47831" | "localhost:47831" | "127.0.0.1" | "localhost"
    )
}

/// Allows requests with no Origin/Referer (native non-browser clients) and
/// same-origin loopback browser requests. Rejects cross-origin browser reads.
fn origin_allowed(headers: &HeaderMap) -> bool {
    if let Some(origin) = headers.get(ORIGIN).and_then(|v| v.to_str().ok()) {
        return is_loopback_origin(origin);
    }
    if let Some(referer) = headers.get(REFERER).and_then(|v| v.to_str().ok()) {
        // Derive the origin from the referer URL (scheme://host[:port]).
        if let Some(origin) = referer_origin(referer) {
            return is_loopback_origin(&origin);
        }
        return false;
    }
    true
}

fn is_loopback_origin(origin: &str) -> bool {
    let lower = origin.to_ascii_lowercase();
    matches!(
        lower.as_str(),
        "http://127.0.0.1:47831"
            | "http://localhost:47831"
            | "http://127.0.0.1"
            | "http://localhost"
    )
}

fn referer_origin(referer: &str) -> Option<String> {
    let parsed = url::Url::parse(referer).ok()?;
    if parsed.scheme() != "http" {
        return None;
    }
    let host = parsed.host_str()?;
    match parsed.port() {
        Some(port) => Some(format!("http://{host}:{port}")),
        None => Some(format!("http://{host}")),
    }
}

async fn health(
    State(app): State<Arc<AppState>>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> impl IntoResponse {
    if !host_valid(&headers) || !origin_allowed(&headers) {
        return forbidden();
    }
    // Rate-limit before authentication so invalid-token probes are throttled
    // too, not just successful requests.
    if rate_limited(&app, addr.ip()) {
        return too_many_requests();
    }
    if !authorized(&app, &headers) {
        return unauthorized();
    }
    with_security_headers(Json(json!({ "ok": true, "schemaVersion": 1 })).into_response())
}

async fn usage(
    State(app): State<Arc<AppState>>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> impl IntoResponse {
    if !host_valid(&headers) || !origin_allowed(&headers) {
        return forbidden();
    }
    // Rate-limit before authentication so invalid-token probes are throttled
    // too, not just successful requests.
    if rate_limited(&app, addr.ip()) {
        return too_many_requests();
    }
    if !authorized(&app, &headers) {
        return unauthorized();
    }
    let accounts = app
        .store
        .list()
        .into_iter()
        .map(|account| {
            let usage = account.last_usage.clone();
            let status = if account.auth_required {
                "auth_required"
            } else {
                match usage.as_ref().map(|usage| &usage.freshness) {
                    Some(UsageFreshness::Live) => "available",
                    Some(UsageFreshness::Stale) => "stale",
                    Some(UsageFreshness::AuthRequired) => "auth_required",
                    _ => "unavailable",
                }
            };
            PublicUsageAccount {
                id: account.id,
                label: account.label,
                provider: account.provider,
                email: account.email,
                provider_account_id: account.provider_account_id.or(account.chatgpt_account_id),
                plan: account.plan,
                status: status.into(),
                source: usage.as_ref().map(|usage| usage.source.clone()),
                windows: usage
                    .as_ref()
                    .map(|usage| usage.windows.clone())
                    .unwrap_or_default(),
                credits_usd: usage.as_ref().and_then(|usage| usage.credits_usd),
                fetched_at: usage.as_ref().map(|usage| usage.fetched_at.clone()),
                error: account.last_error,
            }
        })
        .collect();
    with_security_headers(
        (
            StatusCode::OK,
            Json(PublicUsageResponse {
                schema_version: 1,
                generated_at: now_rfc3339(),
                accounts,
            }),
        )
            .into_response(),
    )
}

fn forbidden() -> axum::response::Response {
    with_security_headers(
        (StatusCode::FORBIDDEN, Json(json!({ "error": "forbidden" }))).into_response(),
    )
}

fn too_many_requests() -> axum::response::Response {
    with_security_headers(
        (
            StatusCode::TOO_MANY_REQUESTS,
            [(axum::http::header::RETRY_AFTER, "1")],
            Json(json!({ "error": "rate_limited" })),
        )
            .into_response(),
    )
}

/// Token bucket for one client.
#[derive(Clone, Copy, Debug)]
pub struct RateBucket {
    tokens: f64,
    updated: Instant,
}

fn rate_limited(app: &AppState, client: IpAddr) -> bool {
    rate_limited_at(app, client, Instant::now())
}

fn rate_limited_at(app: &AppState, client: IpAddr, now: Instant) -> bool {
    let mut map = app.bridge_rate_limit.lock();
    // Bound memory: drop entries idle longer than the TTL (their bucket would
    // be full again anyway).
    map.retain(|_, bucket| now.saturating_duration_since(bucket.updated) < RATE_LIMIT_ENTRY_TTL);
    let bucket = map.entry(client).or_insert(RateBucket {
        tokens: RATE_LIMIT_BURST,
        updated: now,
    });
    let refill =
        now.saturating_duration_since(bucket.updated).as_secs_f64() * RATE_LIMIT_REFILL_PER_SECOND;
    bucket.tokens = (bucket.tokens + refill).min(RATE_LIMIT_BURST);
    bucket.updated = now;
    if bucket.tokens >= 1.0 {
        bucket.tokens -= 1.0;
        false
    } else {
        true
    }
}

fn unauthorized() -> axum::response::Response {
    with_security_headers(
        (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "unauthorized" })),
        )
            .into_response(),
    )
}

fn authorized(app: &AppState, headers: &HeaderMap) -> bool {
    let expected = app.bridge_token.read();
    headers
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .is_some_and(|provided| constant_time_equal(provided.as_bytes(), expected.as_bytes()))
}

/// Compares two secrets without leaking their contents or lengths through
/// timing. Both sides are hashed to fixed-size digests first, so a mismatched
/// length takes the same path as a mismatched byte instead of returning early.
fn constant_time_equal(left: &[u8], right: &[u8]) -> bool {
    let left = Sha256::digest(left);
    let right = Sha256::digest(right);
    left.as_slice().ct_eq(right.as_slice()).unwrap_u8() == 1
}

#[cfg(test)]
mod tests {
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

    fn loopback_headers() -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(HOST, HeaderValue::from_static("127.0.0.1:47831"));
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

        headers.insert(HOST, HeaderValue::from_static("127.0.0.1:47831"));
        assert!(host_valid(&headers));

        headers.insert(HOST, HeaderValue::from_static("localhost:47831"));
        assert!(host_valid(&headers));
    }

    #[test]
    fn origin_validation_allows_native_and_same_origin() {
        let headers = HeaderMap::new();
        assert!(origin_allowed(&headers));

        let mut same = HeaderMap::new();
        same.insert(ORIGIN, HeaderValue::from_static("http://127.0.0.1:47831"));
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
            assert!(!rate_limited_at(&app, client_a, start));
        }
        assert!(rate_limited_at(&app, client_a, start));

        // A different loopback client has its own budget.
        assert!(!rate_limited_at(&app, client_b, start));

        // One request per second comes back, but not a full burst at once.
        let later = start + Duration::from_millis(1100);
        assert!(!rate_limited_at(&app, client_a, later));
        assert!(rate_limited_at(&app, client_a, later));

        // After a long idle time the whole burst is available again, no more.
        let much_later = start + Duration::from_secs(30);
        for _ in 0..RATE_LIMIT_BURST as usize {
            assert!(!rate_limited_at(&app, client_a, much_later));
        }
        assert!(rate_limited_at(&app, client_a, much_later));
    }

    #[test]
    fn idle_rate_limit_entries_are_pruned() {
        let app = test_app();
        let start = Instant::now();
        for last in 1..=50u8 {
            let client: IpAddr = format!("127.0.0.{last}").parse().unwrap();
            assert!(!rate_limited_at(&app, client, start));
        }
        assert_eq!(app.bridge_rate_limit.lock().len(), 50);
        let client: IpAddr = "127.0.1.1".parse().unwrap();
        rate_limited_at(&app, client, start + RATE_LIMIT_ENTRY_TTL * 2);
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
}

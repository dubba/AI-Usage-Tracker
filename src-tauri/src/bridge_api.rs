use crate::{
    model::{now_rfc3339, PublicUsageAccount, PublicUsageResponse, UsageFreshness},
    state::AppState,
};
use axum::{
    extract::{ConnectInfo, State},
    http::{
        header::{AUTHORIZATION, HOST, ORIGIN, REFERER},
        HeaderMap, StatusCode,
    },
    response::IntoResponse,
    routing::get,
    Json, Router,
};
use serde_json::json;
use std::{
    net::{IpAddr, SocketAddr},
    sync::Arc,
    time::{Duration, Instant},
};
use subtle::ConstantTimeEq;
use tokio::net::TcpListener;

const API_ADDR: &str = "127.0.0.1:47831";
const RETRY_DELAY_SECONDS: u64 = 3;
const MIN_REQUEST_INTERVAL: Duration = Duration::from_secs(1);
/// Prune per-client rate-limit entries older than this to bound memory.
const RATE_LIMIT_ENTRY_TTL: Duration = Duration::from_secs(60);

pub async fn run_controller(app: Arc<AppState>) {
    loop {
        if !app.settings.paseo_bridge_enabled() {
            set_runtime(&app, false, None);
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
                            tokio::time::sleep(std::time::Duration::from_secs(RETRY_DELAY_SECONDS)).await;
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
    let _ = headers.try_insert("cache-control", "no-store".parse().unwrap());
    let _ = headers.try_insert("x-content-type-options", "nosniff".parse().unwrap());
    let _ = headers.try_insert("referrer-policy", "no-referrer".parse().unwrap());
    let _ = headers.try_insert("x-frame-options", "DENY".parse().unwrap());
    let _ = headers.try_insert(
        "content-security-policy",
        "default-src 'none'; frame-ancestors 'none'".parse().unwrap(),
    );
    let _ = headers.try_insert(
        "cross-origin-resource-policy",
        "same-origin".parse().unwrap(),
    );
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
        "http://127.0.0.1:47831" | "http://localhost:47831" | "http://127.0.0.1" | "http://localhost"
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
    if !authorized(&app, &headers) {
        return unauthorized();
    }
    if rate_limited(&app, addr.ip()) {
        return too_many_requests();
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
    if !authorized(&app, &headers) {
        return unauthorized();
    }
    if rate_limited(&app, addr.ip()) {
        return too_many_requests();
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
                provider_account_id: account
                    .provider_account_id
                    .or(account.chatgpt_account_id),
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
        (
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "forbidden" })),
        )
            .into_response(),
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

fn rate_limited(app: &AppState, client: IpAddr) -> bool {
    let now = Instant::now();
    let mut map = app.bridge_rate_limit.lock();
    // Bound memory: drop entries idle longer than the TTL.
    map.retain(|_, seen| now.duration_since(*seen) < RATE_LIMIT_ENTRY_TTL);
    if let Some(previous) = map.get(&client) {
        if now.duration_since(*previous) < MIN_REQUEST_INTERVAL {
            return true;
        }
    }
    map.insert(client, now);
    false
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

fn constant_time_equal(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.ct_eq(right).unwrap_u8() == 1
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::AppState;
    use axum::http::HeaderValue;
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
        headers.insert(AUTHORIZATION, HeaderValue::from_static("Bearer wrong-token"));
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
        referer.insert(
            REFERER,
            HeaderValue::from_static("http://evil.com/page"),
        );
        assert!(!origin_allowed(&referer));
    }

    #[test]
    fn local_api_rate_limits_per_client_ip() {
        let app = test_app();
        let client_a: IpAddr = "127.0.0.1".parse().unwrap();
        let client_b: IpAddr = "127.0.0.2".parse().unwrap();
        assert!(!rate_limited(&app, client_a));
        assert!(rate_limited(&app, client_a));
        // A different loopback client has its own budget.
        assert!(!rate_limited(&app, client_b));
        assert!(rate_limited(&app, client_b));
        {
            let mut map = app.bridge_rate_limit.lock();
            map.insert(client_a, Instant::now() - MIN_REQUEST_INTERVAL);
        }
        assert!(!rate_limited(&app, client_a));
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
                response.headers().get("cache-control").and_then(|v| v.to_str().ok()),
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
}

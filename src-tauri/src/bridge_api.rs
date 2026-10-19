use crate::{
    model::{
        now_rfc3339, Account, BridgeUsageWindow, PublicUsageAccount, PublicUsageResponse,
        UsageFreshness,
    },
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
    net::{IpAddr, Ipv4Addr, SocketAddr},
    sync::Arc,
    time::{Duration, Instant},
};
use subtle::ConstantTimeEq;
use tokio::net::TcpListener;

/// The one port the local API listens on. The Host and Origin allowlists, the endpoint shown
/// in the app and the tests are all built from it.
pub(crate) const BRIDGE_PORT: u16 = 47831;
const API_ADDR: SocketAddr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), BRIDGE_PORT);
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
    let host = host.to_ascii_lowercase();
    allowed_hosts().contains(&host)
}

/// The Host header values the API answers to: the loopback names with the API's port (what
/// a client connecting to it sends) and without one.
fn allowed_hosts() -> [String; 4] {
    [
        format!("127.0.0.1:{BRIDGE_PORT}"),
        format!("localhost:{BRIDGE_PORT}"),
        "127.0.0.1".to_string(),
        "localhost".to_string(),
    ]
}

/// The origin of the local API, e.g. for the endpoint shown in the app.
pub(crate) fn bridge_origin() -> String {
    format!("http://127.0.0.1:{BRIDGE_PORT}")
}

/// The URL of the usage endpoint (`/v1/paseo-usage`).
pub(crate) fn bridge_endpoint() -> String {
    format!("{}/v1/paseo-usage", bridge_origin())
}

/// The Origin header values a browser request may carry: the loopback origins with the API's
/// port and without one.
fn allowed_origins() -> [String; 4] {
    [
        format!("http://127.0.0.1:{BRIDGE_PORT}"),
        format!("http://localhost:{BRIDGE_PORT}"),
        "http://127.0.0.1".to_string(),
        "http://localhost".to_string(),
    ]
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
    allowed_origins().contains(&lower)
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
    if let Err(response) = admit(&app, addr.ip(), &headers) {
        return response;
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
    if let Err(response) = admit(&app, addr.ip(), &headers) {
        return response;
    }
    let accounts = public_accounts(app.store.list());
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

/// The accounts as the local API lists them.
fn public_accounts(accounts: Vec<Account>) -> Vec<PublicUsageAccount> {
    accounts
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
                    .map(|usage| usage.windows.iter().map(BridgeUsageWindow::from).collect())
                    .unwrap_or_default(),
                credits_usd: usage.as_ref().and_then(|usage| usage.credits_usd),
                fetched_at: usage.as_ref().map(|usage| usage.fetched_at.clone()),
                error: account.last_error,
            }
        })
        .collect()
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

/// Which budget a request is charged to. Requests that present the right token
/// and requests that do not are counted separately: every local process shares
/// the 127.0.0.1 address, so with one budget any of them could keep it empty
/// with bad requests and lock out the client that holds the token.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum RateLane {
    Authorized,
    Rejected,
}

/// Authenticates a request and charges it to its rate-limit lane. Rejected
/// requests are still throttled (429 once their own budget runs out), so token
/// guessing stays rate-limited; they just cannot spend the authorized budget.
#[allow(clippy::result_large_err)]
fn admit(
    app: &AppState,
    client: IpAddr,
    headers: &HeaderMap,
) -> Result<(), axum::response::Response> {
    let lane = if authorized(app, headers) {
        RateLane::Authorized
    } else {
        RateLane::Rejected
    };
    if rate_limited(app, client, lane) {
        return Err(too_many_requests());
    }
    if lane == RateLane::Rejected {
        return Err(unauthorized());
    }
    Ok(())
}

fn rate_limited(app: &AppState, client: IpAddr, lane: RateLane) -> bool {
    rate_limited_at(app, client, lane, Instant::now())
}

fn rate_limited_at(app: &AppState, client: IpAddr, lane: RateLane, now: Instant) -> bool {
    let mut map = app.bridge_rate_limit.lock();
    // Bound memory: drop entries idle longer than the TTL (their bucket would
    // be full again anyway).
    map.retain(|_, bucket| now.saturating_duration_since(bucket.updated) < RATE_LIMIT_ENTRY_TTL);
    let bucket = map.entry((client, lane)).or_insert(RateBucket {
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
mod tests;

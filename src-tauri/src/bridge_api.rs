use crate::{
    model::{now_rfc3339, PublicUsageAccount, PublicUsageResponse, UsageFreshness},
    state::AppState,
};
use axum::{
    extract::State,
    http::{header::AUTHORIZATION, HeaderMap, StatusCode},
    response::IntoResponse,
    routing::get,
    Json, Router,
};
use serde_json::json;
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::net::TcpListener;

const API_ADDR: &str = "127.0.0.1:47831";
const RETRY_DELAY_SECONDS: u64 = 3;
const MIN_REQUEST_INTERVAL: Duration = Duration::from_secs(1);

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
                let server = axum::serve(listener, router).with_graceful_shutdown(async move {
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

async fn health(State(app): State<Arc<AppState>>, headers: HeaderMap) -> impl IntoResponse {
    if !authorized(&app, &headers) {
        return unauthorized();
    }
    if rate_limited(&app) {
        return too_many_requests();
    }
    Json(json!({ "ok": true, "schemaVersion": 1 })).into_response()
}

async fn usage(State(app): State<Arc<AppState>>, headers: HeaderMap) -> impl IntoResponse {
    if !authorized(&app, &headers) {
        return unauthorized();
    }
    if rate_limited(&app) {
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
    (
        StatusCode::OK,
        Json(PublicUsageResponse {
            schema_version: 1,
            generated_at: now_rfc3339(),
            accounts,
        }),
    )
        .into_response()
}

fn too_many_requests() -> axum::response::Response {
    (
        StatusCode::TOO_MANY_REQUESTS,
        [(axum::http::header::RETRY_AFTER, "1")],
        Json(json!({ "error": "rate_limited" })),
    )
        .into_response()
}

fn rate_limited(app: &AppState) -> bool {
    let now = Instant::now();
    let mut last = app.bridge_rate_limit.lock();
    if let Some(previous) = *last {
        if now.duration_since(previous) < MIN_REQUEST_INTERVAL {
            return true;
        }
    }
    *last = Some(now);
    false
}

fn unauthorized() -> axum::response::Response {
    (
        StatusCode::UNAUTHORIZED,
        Json(json!({ "error": "unauthorized" })),
    )
        .into_response()
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
    let mut difference = 0u8;
    for (left, right) in left.iter().zip(right.iter()) {
        difference |= *left ^ *right;
    }
    difference == 0
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::AppState;
    use axum::http::HeaderValue;

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
    fn local_api_rate_limits_authenticated_requests() {
        let app = test_app();
        assert!(!rate_limited(&app));
        assert!(rate_limited(&app));
        *app.bridge_rate_limit.lock() = Some(Instant::now() - MIN_REQUEST_INTERVAL);
        assert!(!rate_limited(&app));
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
}

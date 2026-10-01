//! Pieces shared by the browser-based OAuth logins (`oauth` and `google_ai_studio_oauth`):
//! the loopback callback query, PKCE helpers, and the HTML pages shown in the browser tab.

use crate::state::AppState;
use axum::{
    http::{HeaderMap, HeaderValue},
    response::{Html, IntoResponse},
    Router,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand::RngCore;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{sync::Arc, time::Duration};
use tokio::{net::TcpListener, sync::oneshot};

#[derive(Debug, Deserialize)]
pub(crate) struct CallbackQuery {
    pub code: Option<String>,
    pub state: Option<String>,
    pub error: Option<String>,
    pub error_description: Option<String>,
}

pub(crate) fn random_base64(bytes: usize) -> String {
    let mut value = vec![0u8; bytes];
    rand::thread_rng().fill_bytes(&mut value);
    URL_SAFE_NO_PAD.encode(value)
}

/// PKCE `code_challenge` (method S256) for a `code_verifier`.
pub(crate) fn pkce_challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

/// Serves a callback page with headers that keep it uncached, script-free, and unframed.
pub(crate) fn callback_html(body: String) -> axum::response::Response {
    let mut headers = HeaderMap::new();
    headers.insert(
        axum::http::header::CACHE_CONTROL,
        HeaderValue::from_static("no-store, no-cache, must-revalidate"),
    );
    headers.insert(
        axum::http::header::PRAGMA,
        HeaderValue::from_static("no-cache"),
    );
    headers.insert(
        axum::http::header::HeaderName::from_static("content-security-policy"),
        HeaderValue::from_static(
            "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
        ),
    );
    headers.insert(
        axum::http::header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        axum::http::header::HeaderName::from_static("referrer-policy"),
        HeaderValue::from_static("no-referrer"),
    );
    (headers, Html(body)).into_response()
}

pub(crate) fn escape_html(input: &str) -> String {
    input
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

/// How long a browser sign-in may stay open before it is given up on.
pub(crate) const LOGIN_TIMEOUT_MINUTES: i64 = 5;

/// Serves the loopback OAuth callback until `shutdown` fires. If the server itself fails (as
/// opposed to being shut down), `fail` is told why, prefixed with `failure_prefix`, and the
/// attempt's resources are released so the user can start again.
pub(crate) fn spawn_callback_server(
    app: Arc<AppState>,
    attempt_id: String,
    listener: TcpListener,
    router: Router,
    shutdown: oneshot::Receiver<()>,
    failure_prefix: &'static str,
    fail: impl FnOnce(String) + Send + 'static,
) {
    tokio::spawn(async move {
        if let Err(error) = axum::serve(listener, router)
            .with_graceful_shutdown(async {
                let _ = shutdown.await;
            })
            .await
        {
            fail(format!("{failure_prefix}: {error}"));
            app.abort_login_resources(&attempt_id);
        }
    });
}

/// After `after`, gives up on the attempt if it is still waiting: `fail` is told `message` and the
/// attempt's resources are released. An attempt that finished or failed in the meantime is left alone.
pub(crate) fn spawn_login_timeout(
    app: Arc<AppState>,
    attempt_id: String,
    after: Duration,
    message: String,
    fail: impl FnOnce(String) + Send + 'static,
) {
    tokio::spawn(async move {
        tokio::time::sleep(after).await;
        let waiting = app
            .pending_login
            .read()
            .as_ref()
            .is_some_and(|login| login.attempt_id == attempt_id && login.status == "waiting");
        if waiting {
            fail(message);
            app.abort_login_resources(&attempt_id);
        }
    });
}

/// The page shown in the browser when a sign-in fails. `message` is escaped here.
pub(crate) fn auth_failure_html(title: &str, message: &str) -> String {
    format!(
        r#"<!doctype html><html><body style="background:#101412;color:#f4f6f8;font-family:system-ui;padding:50px;text-align:center"><h1>{}</h1><p style="color:#ff9d9d">{}</p><p style="color:#8e9791">Return to the app and try again.</p></body></html>"#,
        escape_html(title),
        escape_html(message)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_challenge_matches_the_rfc_7636_example() {
        assert_eq!(
            pkce_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn random_base64_is_url_safe_and_unique() {
        let a = random_base64(32);
        let b = random_base64(32);
        assert_ne!(a, b);
        assert_eq!(a.len(), 43);
        assert!(a
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
    }

    #[test]
    fn failure_page_escapes_the_message() {
        let page = auth_failure_html("Authentication failed", "<script>alert(1)</script>");
        assert!(page.contains("Authentication failed"));
        assert!(page.contains("&lt;script&gt;"));
        assert!(!page.contains("<script>"));
    }

    fn test_app() -> (Arc<AppState>, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let app = Arc::new(AppState::new(dir.path().to_path_buf(), "token".into()).unwrap());
        (app, dir)
    }

    fn waiting(attempt_id: &str, status: &str) -> crate::model::LoginStatus {
        crate::model::LoginStatus {
            attempt_id: attempt_id.into(),
            status: status.into(),
            message: None,
            account: None,
            projects: None,
            selected_project_id: None,
        }
    }

    #[tokio::test]
    async fn the_callback_server_answers_until_it_is_shut_down() {
        let (app, _dir) = test_app();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (stop, shutdown) = oneshot::channel();
        let router = Router::new().route("/callback", axum::routing::get(|| async { "hello" }));
        spawn_callback_server(
            app,
            "a1".into(),
            listener,
            router,
            shutdown,
            "Callback server failed",
            |_| {},
        );

        let url = format!("http://{addr}/callback");
        assert_eq!(
            reqwest::get(&url).await.unwrap().text().await.unwrap(),
            "hello"
        );
        stop.send(()).unwrap();
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(
            reqwest::get(&url).await.is_err(),
            "the port should be released after shutdown"
        );
    }

    #[tokio::test]
    async fn the_timeout_fails_a_still_waiting_attempt_once() {
        let (app, _dir) = test_app();
        *app.pending_login.write() = Some(waiting("a1", "waiting"));
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        spawn_login_timeout(
            app.clone(),
            "a1".into(),
            Duration::from_millis(20),
            "timed out".into(),
            move |message| {
                tx.send(message).unwrap();
            },
        );
        assert_eq!(rx.recv().await.as_deref(), Some("timed out"));
    }

    #[tokio::test]
    async fn the_timeout_leaves_a_finished_or_different_attempt_alone() {
        let (app, _dir) = test_app();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
        for (attempt, status) in [("a1", "complete"), ("someone-else", "waiting")] {
            *app.pending_login.write() = Some(waiting(attempt, status));
            let tx = tx.clone();
            spawn_login_timeout(
                app.clone(),
                "a1".into(),
                Duration::from_millis(20),
                "timed out".into(),
                move |message| {
                    tx.send(message).unwrap();
                },
            );
        }
        drop(tx);
        tokio::time::sleep(Duration::from_millis(120)).await;
        assert!(rx.try_recv().is_err());
    }
}

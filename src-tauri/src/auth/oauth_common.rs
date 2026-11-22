//! Pieces shared by the sign-ins: the account a sign-in saves, the loopback callback query and
//! server of the browser-based OAuth logins (`oauth` and `google_ai_studio_oauth`), and their
//! timeout. The pages they end on are in `result_pages`, PKCE in `pkce`.

use crate::{
    model::{Account, Provider},
    state::AppState,
};
use axum::Router;
use serde::Deserialize;
use std::{sync::Arc, time::Duration};
use tokio::{net::TcpListener, sync::oneshot};

/// Why a second sign-in cannot start while one is still in progress.
pub(crate) const LOGIN_IN_PROGRESS_MESSAGE: &str = "Another provider login is already in progress.";

/// What a sign-in settled on for an account: the label and the identity the provider reported,
/// each already combined with the existing account's values where the sign-in found none.
pub(crate) struct ConnectedFields {
    pub label: String,
    pub provider: Provider,
    pub email: Option<String>,
    pub provider_account_id: Option<String>,
    pub chatgpt_account_id: Option<String>,
    pub plan: Option<String>,
}

/// Builds the account a sign-in saves. When it signs in to an account that is already stored
/// (`duplicate`), the result keeps that account's id, creation time and last usage, so the
/// sign-in updates it instead of adding a second one; otherwise it is a new account with a
/// fresh id. The error state is cleared either way: the sign-in just worked.
pub(crate) fn merge_into_existing(duplicate: Option<&Account>, fields: ConnectedFields) -> Account {
    let now = crate::model::now_rfc3339();
    Account {
        id: duplicate
            .map(|account| account.id.clone())
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
        label: fields.label,
        provider: fields.provider,
        email: fields.email,
        provider_account_id: fields.provider_account_id,
        chatgpt_account_id: fields.chatgpt_account_id,
        plan: fields.plan,
        created_at: duplicate
            .map(|account| account.created_at.clone())
            .unwrap_or_else(|| now.clone()),
        updated_at: now,
        last_usage: duplicate.and_then(|account| account.last_usage.clone()),
        last_error: None,
        auth_required: false,
    }
}

/// Ends a sign-in that has its own window (Grok, OpenCode): marks the attempt complete if it is
/// still waiting and, on desktop, shows the "Account connected" page and closes the window.
/// On mobile the sign-in poll loop (`mobile_auth`) shows the page instead. Returns whether
/// the attempt was still waiting; if not, nothing was shown.
pub(crate) fn finish_window_login(
    state: &AppState,
    attempt_id: &str,
    account: Account,
    window: tauri::WebviewWindow,
) -> bool {
    #[cfg(desktop)]
    let connected = account.clone();
    let completed = state.update_login_if_waiting(attempt_id, |login| {
        *login = crate::model::LoginStatus::complete(attempt_id, account);
    });
    #[cfg(desktop)]
    if completed {
        crate::auth::result_pages::close_after_connected_page(window, &connected);
    }
    #[cfg(not(desktop))]
    let _ = window;
    completed
}

#[derive(Debug, Deserialize)]
pub(crate) struct CallbackQuery {
    pub code: Option<String>,
    pub state: Option<String>,
    pub error: Option<String>,
    pub error_description: Option<String>,
}

/// How long a browser sign-in may stay open before it is given up on. The cookie sign-ins in app
/// windows (Grok, OpenCode) wait `COOKIE_LOGIN_TIMEOUT_MINUTES` (10) on purpose.
pub(crate) const OAUTH_LOGIN_TIMEOUT_MINUTES: i64 = 5;

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
        if app.login_is_waiting(&attempt_id) {
            fail(message);
            app.abort_login_resources(&attempt_id);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::LoginState;

    fn account(provider: Provider, email: Option<&str>, label: &str) -> Account {
        Account {
            id: String::new(),
            label: label.to_string(),
            provider,
            email: email.map(str::to_string),
            created_at: String::new(),
            updated_at: String::new(),
            ..Account::for_test()
        }
    }

    fn fields(label: &str) -> ConnectedFields {
        ConnectedFields {
            label: label.into(),
            provider: Provider::Grok,
            email: Some("new@example.com".into()),
            provider_account_id: Some("pid".into()),
            chatgpt_account_id: None,
            plan: Some("SuperGrok".into()),
        }
    }

    #[test]
    fn merge_into_existing_makes_a_new_account_when_there_is_no_duplicate() {
        let merged = merge_into_existing(None, fields("Work"));
        assert!(!merged.id.is_empty());
        assert_eq!(merged.label, "Work");
        assert_eq!(merged.email.as_deref(), Some("new@example.com"));
        assert_eq!(merged.created_at, merged.updated_at);
        assert!(merged.last_usage.is_none());
        assert!(merged.last_error.is_none() && !merged.auth_required);
        let other = merge_into_existing(None, fields("Work"));
        assert_ne!(merged.id, other.id);
    }

    #[test]
    fn merge_into_existing_keeps_the_stored_accounts_identity_and_clears_its_error() {
        let mut stored = account(Provider::Grok, Some("old@example.com"), "Old");
        stored.id = "stored-id".into();
        stored.created_at = "2020-01-01T00:00:00Z".into();
        stored.last_error = Some("expired".into());
        stored.auth_required = true;

        let merged = merge_into_existing(Some(&stored), fields("Renamed"));

        assert_eq!(merged.id, "stored-id");
        assert_eq!(merged.created_at, "2020-01-01T00:00:00Z");
        assert_ne!(merged.updated_at, "2020-01-01T00:00:00Z");
        assert_eq!(merged.label, "Renamed");
        // The sign-in's own values win; the caller decides about fallbacks.
        assert_eq!(merged.email.as_deref(), Some("new@example.com"));
        assert!(merged.last_error.is_none());
        assert!(!merged.auth_required);
    }

    fn test_app() -> (Arc<AppState>, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let app = Arc::new(AppState::new(dir.path().to_path_buf(), "token".into()).unwrap());
        (app, dir)
    }

    fn waiting(attempt_id: &str, status: LoginState) -> crate::model::LoginStatus {
        crate::model::LoginStatus {
            attempt_id: attempt_id.into(),
            status,
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
        *app.pending_login.write() = Some(waiting("a1", LoginState::Waiting));
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
        for (attempt, status) in [
            ("a1", LoginState::Complete),
            ("someone-else", LoginState::Waiting),
        ] {
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

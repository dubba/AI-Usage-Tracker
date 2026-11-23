use super::*;
use crate::model::{LoginState, LoginStatus};

fn login(attempt_id: &str, status: LoginState) -> LoginStatus {
    LoginStatus {
        attempt_id: attempt_id.into(),
        status,
        message: None,
        account: None,
        projects: None,
        selected_project_id: None,
    }
}

fn pending_state(state: &AppState) -> Option<(String, LoginState, Option<String>)> {
    state.pending_login.read().as_ref().map(|login| {
        (
            login.attempt_id.clone(),
            login.status,
            login.message.clone(),
        )
    })
}

#[test]
fn begin_login_claims_the_slot_only_when_no_login_is_in_progress() {
    let directory = tempfile::tempdir().unwrap();
    let state = AppState::new(directory.path().to_path_buf(), "test-token".into()).unwrap();

    state
        .begin_login("attempt-1", Some("Sign in".into()))
        .unwrap();
    assert_eq!(
        pending_state(&state),
        Some((
            "attempt-1".into(),
            LoginState::Waiting,
            Some("Sign in".into())
        ))
    );

    // A second start is refused and leaves the first attempt alone.
    let error = state.begin_login("attempt-2", None).unwrap_err();
    assert_eq!(error, crate::auth::oauth_common::LOGIN_IN_PROGRESS_MESSAGE);
    assert_eq!(pending_state(&state).unwrap().0, "attempt-1");

    // A finished login does not block the next one.
    *state.pending_login.write() = Some(login("attempt-1", LoginState::Failed));
    state.begin_login("attempt-3", None).unwrap();
    assert_eq!(pending_state(&state).unwrap().0, "attempt-3");
}

#[test]
fn clear_pending_login_only_clears_its_own_attempt() {
    let directory = tempfile::tempdir().unwrap();
    let state = AppState::new(directory.path().to_path_buf(), "test-token".into()).unwrap();
    *state.pending_login.write() = Some(login("attempt-1", LoginState::Waiting));

    state.clear_pending_login("attempt-2");
    assert!(state.pending_login.read().is_some());
    state.clear_pending_login("attempt-1");
    assert!(state.pending_login.read().is_none());
    // Nothing pending: no-op.
    state.clear_pending_login("attempt-1");
}

#[test]
fn a_dropped_login_guard_forgets_the_attempt_and_a_kept_one_leaves_it() {
    let directory = tempfile::tempdir().unwrap();
    let state =
        Arc::new(AppState::new(directory.path().to_path_buf(), "test-token".into()).unwrap());

    // An early return drops the guard, so the next attempt can begin.
    drop(state.begin_login_guarded("attempt-1", None).unwrap());
    assert!(state.pending_login.read().is_none());

    // A kept attempt stays pending and still blocks a second start.
    state.begin_login_guarded("attempt-2", None).unwrap().keep();
    assert_eq!(pending_state(&state).unwrap().0, "attempt-2");
    assert!(state.begin_login_guarded("attempt-3", None).is_err());
    assert_eq!(pending_state(&state).unwrap().0, "attempt-2");
}

#[test]
fn login_status_constructors_build_the_expected_states() {
    let waiting = LoginStatus::waiting("a", Some("hi".into()));
    assert_eq!(waiting.status, LoginState::Waiting);
    assert_eq!(waiting.message.as_deref(), Some("hi"));
    assert!(waiting.account.is_none() && waiting.projects.is_none());

    let account = crate::model::Account {
        id: "acc".into(),
        label: "Acc".into(),
        provider: crate::model::Provider::Openai,
        created_at: String::new(),
        updated_at: String::new(),
        ..crate::model::Account::for_test()
    };
    let complete = LoginStatus::complete("a", account.clone());
    assert_eq!(complete.status, LoginState::Complete);
    assert_eq!(complete.account.map(|a| a.id), Some(account.id));
    assert!(complete.message.is_none());
}

#[test]
fn abandon_waiting_login_clears_in_progress_attempt() {
    let directory = tempfile::tempdir().unwrap();
    let state = AppState::new(directory.path().to_path_buf(), "test-token".into()).unwrap();
    *state.pending_login.write() = Some(login("attempt-1", LoginState::Waiting));

    assert!(state.abandon_waiting_login("attempt-1"));
    assert!(state.pending_login.read().is_none());
    assert!(!state.abandon_waiting_login("attempt-1"));
}

#[test]
fn fail_login_if_waiting_fails_only_the_waiting_attempt() {
    let directory = tempfile::tempdir().unwrap();
    let state = AppState::new(directory.path().to_path_buf(), "test-token".into()).unwrap();
    *state.pending_login.write() = Some(login("attempt-1", LoginState::Waiting));

    state.fail_login_if_waiting("attempt-1", "timed out".into());
    assert_eq!(
        pending_state(&state),
        Some((
            "attempt-1".into(),
            LoginState::Failed,
            Some("timed out".into())
        ))
    );
}

#[test]
fn fail_login_if_waiting_never_overwrites_a_finished_or_other_attempt() {
    let directory = tempfile::tempdir().unwrap();
    let state = AppState::new(directory.path().to_path_buf(), "test-token".into()).unwrap();
    for (attempt, status) in [
        ("attempt-1", LoginState::Complete),
        ("attempt-1", LoginState::ChooseProject),
        ("attempt-1", LoginState::MonitoringDisabled),
        ("attempt-1", LoginState::Failed),
        ("someone-else", LoginState::Waiting),
    ] {
        *state.pending_login.write() = Some(login(attempt, status));
        state.fail_login_if_waiting("attempt-1", "timed out".into());
        state.set_waiting_message("attempt-1", "still going".into());
        assert_eq!(
            pending_state(&state),
            Some((attempt.into(), status, None)),
            "{attempt} {status:?}"
        );
    }
}

#[test]
fn a_racing_finish_and_failure_never_both_win() {
    // Checking "still waiting?" and writing under separate locks let a
    // timeout overwrite a sign-in that had just completed. Exactly one side
    // may win, and the stored status must be the winner's.
    let directory = tempfile::tempdir().unwrap();
    let state =
        Arc::new(AppState::new(directory.path().to_path_buf(), "test-token".into()).unwrap());
    for _ in 0..500 {
        *state.pending_login.write() = Some(login("attempt-1", LoginState::Waiting));
        let barrier = Arc::new(std::sync::Barrier::new(2));
        let race = |status: LoginState| {
            let state = state.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                state.update_login_if_waiting("attempt-1", |login| login.status = status)
            })
        };
        let completed = race(LoginState::Complete);
        let failed = race(LoginState::Failed);
        let (completed, failed) = (completed.join().unwrap(), failed.join().unwrap());
        assert_ne!(completed, failed, "exactly one side must win");
        let winner = if completed {
            LoginState::Complete
        } else {
            LoginState::Failed
        };
        assert_eq!(pending_state(&state).unwrap().1, winner);
    }
}

#[test]
fn login_state_matches_the_frontend_union() {
    // LoginState in src/types.generated.ts: "waiting" | "complete" | "failed" | "choose_project" | "monitoring_disabled"
    for (state, wire) in [
        (LoginState::Waiting, "waiting"),
        (LoginState::Complete, "complete"),
        (LoginState::Failed, "failed"),
        (LoginState::ChooseProject, "choose_project"),
        (LoginState::MonitoringDisabled, "monitoring_disabled"),
    ] {
        assert_eq!(serde_json::to_value(state).unwrap(), wire);
        assert_eq!(
            serde_json::from_value::<LoginState>(wire.into()).unwrap(),
            state
        );
    }
    assert!(LoginState::Waiting.is_in_progress());
    assert!(LoginState::ChooseProject.is_in_progress());
    assert!(LoginState::MonitoringDisabled.is_in_progress());
    assert!(!LoginState::Complete.is_in_progress());
    assert!(!LoginState::Failed.is_in_progress());
}

#[tokio::test]
async fn remove_account_waits_for_an_in_flight_refresh() {
    let directory = tempfile::tempdir().unwrap();
    let state =
        Arc::new(AppState::new(directory.path().to_path_buf(), "test-token".into()).unwrap());
    let id = "state-remove-waits";
    let now = crate::model::now_rfc3339();
    let account = Account {
        id: id.into(),
        label: "Removal".into(),
        provider: crate::model::Provider::Openai,
        created_at: now.clone(),
        updated_at: now,
        ..Account::for_test()
    };
    let secret = ProviderSecret::Openai(crate::model::OAuthSecret {
        access_token: "a".into(),
        refresh_token: "r".into(),
        id_token: None,
        expires_at: 1,
    });
    state.store.persist_account(account, &secret).unwrap();

    // An in-flight refresh holds the account lock.
    let refresh_guard = state.account_lock(id).lock_owned().await;
    let remover = {
        let state = state.clone();
        tokio::spawn(async move { state.remove_account(id).await })
    };
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(!remover.is_finished(), "removal must wait for the refresh");
    assert!(state.store.get(id).is_some());

    drop(refresh_guard);
    remover.await.unwrap().unwrap();
    assert!(state.store.get(id).is_none());
    assert!(crate::store::load_provider_secret(id).is_err());
    // The lock entry is dropped once nothing holds it.
    assert!(state.account_locks.lock().get(id).is_none());
}

#[tokio::test]
async fn delete_all_local_data_removes_accounts_groups_alerts_and_settings() {
    let directory = tempfile::tempdir().unwrap();
    let state =
        Arc::new(AppState::new(directory.path().to_path_buf(), "test-token".into()).unwrap());
    let ids = ["state-wipe-one", "state-wipe-two"];
    for id in ids {
        let now = crate::model::now_rfc3339();
        let account = Account {
            id: id.into(),
            label: id.into(),
            provider: crate::model::Provider::Openai,
            created_at: now.clone(),
            updated_at: now,
            ..Account::for_test()
        };
        let secret = ProviderSecret::Openai(crate::model::OAuthSecret {
            access_token: "a".into(),
            refresh_token: "r".into(),
            id_token: None,
            expires_at: 1,
        });
        state.store.persist_account(account, &secret).unwrap();
    }
    state
        .account_order
        .save(
            ids.iter().map(|id| id.to_string()).collect(),
            state.store.list(),
        )
        .unwrap();
    state
        .buckets
        .save(
            None,
            "Work".into(),
            None,
            ids.iter().map(|id| id.to_string()).collect(),
        )
        .unwrap();
    state.settings.set_account_refresh_minutes(45).unwrap();
    state.settings.set_include_beta_updates(true).unwrap();

    state.delete_all_local_data().await.unwrap();

    assert!(state.store.list().is_empty());
    assert!(state.store.tombstones().is_empty());
    assert!(state.account_order.snapshot_ids().is_empty());
    assert!(state.buckets.list().is_empty());
    let settings = state.settings.get();
    assert_eq!(
        settings.account_refresh_minutes,
        crate::store::settings::DEFAULT_ACCOUNT_REFRESH_MINUTES
    );
    assert!(!settings.include_beta_updates);
    for id in ids {
        assert!(crate::store::load_provider_secret(id).is_err());
    }

    // The wipe reached the disk too, not only memory.
    let reopened = AppState::new(directory.path().to_path_buf(), "test-token".into()).unwrap();
    assert!(reopened.store.list().is_empty());
    assert!(reopened.buckets.list().is_empty());
    assert_eq!(reopened.settings.get().account_refresh_minutes, 15);
}

#[test]
fn invalid_primary_accounts_fall_back_to_backup() {
    let directory = tempfile::tempdir().unwrap();
    fs::write(
        directory.path().join("accounts.json"),
        r#"{"version":2,"accounts":[{"provider":"unsupported"}]}"#,
    )
    .unwrap();
    fs::write(
        directory.path().join("accounts.json.bak"),
        r#"{
          "version": 2,
          "accounts": [{
            "id": "restored",
            "label": "Restored account",
            "provider": "openai",
            "email": null,
            "providerAccountId": null,
            "chatgptAccountId": null,
            "plan": null,
            "createdAt": "2026-01-01T00:00:00Z",
            "updatedAt": "2026-01-01T00:00:00Z",
            "lastUsage": null,
            "lastError": null,
            "authRequired": false
          }]
        }"#,
    )
    .unwrap();

    let store = load_with_metadata_recovery(directory.path(), "accounts.json", || {
        AccountStore::load(directory.path().to_path_buf()).map_err(|error| error.to_string())
    })
    .unwrap();

    assert_eq!(store.list().len(), 1);
    assert_eq!(store.list()[0].id, "restored");
    assert!(directory.path().join("accounts.json.invalid").exists());
}

#[test]
fn invalid_settings_are_quarantined_and_defaults_load() {
    let directory = tempfile::tempdir().unwrap();
    fs::write(
        directory.path().join("app-settings.json"),
        r#"{"accountRefreshMinutes":"not-a-number"}"#,
    )
    .unwrap();

    let settings = load_with_metadata_recovery(directory.path(), "app-settings.json", || {
        SettingsStore::load(directory.path())
    })
    .unwrap();

    assert_eq!(settings.get().account_refresh_minutes, 15);
    assert!(directory.path().join("app-settings.json.invalid").exists());
}

#[test]
fn a_pending_exchange_does_not_print_its_code_or_verifier() {
    let pending = PendingAuthExchange {
        attempt_id: "attempt".into(),
        provider: crate::model::Provider::Openai,
        label: "Work".into(),
        reconnect_account_id: None,
        code: "SECRET_CODE".into(),
        verifier: "SECRET_VERIFIER".into(),
        expected_state: "SECRET_STATE".into(),
        redirect_uri: "http://localhost:1455/auth/callback".into(),
    };
    let text = format!("{pending:?}");
    assert!(!text.contains("SECRET"), "{text}");
    assert!(
        text.contains("attempt") && text.contains("localhost:1455"),
        "{text}"
    );
}

#[test]
fn update_login_account_updates_completed_login() {
    let directory = tempfile::tempdir().unwrap();
    let state = AppState::new(directory.path().to_path_buf(), "test-token".into()).unwrap();
    let initial_account = Account {
        id: "acc-1".into(),
        label: "Test".into(),
        provider: crate::model::Provider::Openai,
        created_at: "2026-01-01T00:00:00Z".into(),
        updated_at: "2026-01-01T00:00:00Z".into(),
        ..Account::for_test()
    };
    *state.pending_login.write() = Some(LoginStatus {
        attempt_id: "attempt-1".into(),
        status: LoginState::Complete,
        message: None,
        account: Some(initial_account),
        projects: None,
        selected_project_id: None,
    });

    let refreshed = Account {
        id: "acc-1".into(),
        label: "Test".into(),
        provider: crate::model::Provider::Openai,
        plan: Some("ChatGPT Plus".into()),
        created_at: "2026-01-01T00:00:00Z".into(),
        updated_at: "2026-01-01T00:00:00Z".into(),
        ..Account::for_test()
    };

    // Mismatched attempt_id does not update
    state.update_login_account("attempt-2", refreshed.clone());
    assert_eq!(
        state
            .pending_login
            .read()
            .as_ref()
            .unwrap()
            .account
            .as_ref()
            .unwrap()
            .plan,
        None
    );

    // Matching attempt_id updates the account
    state.update_login_account("attempt-1", refreshed);
    assert_eq!(
        state
            .pending_login
            .read()
            .as_ref()
            .unwrap()
            .account
            .as_ref()
            .unwrap()
            .plan,
        Some("ChatGPT Plus".into())
    );
}

/// An account whose last refresh was live and reported a weekly window, so it has a tracker.
fn account_with_weekly_usage(id: &str) -> Account {
    use crate::model::{UsageSnapshot, UsageWindow, WindowKind};
    let now = crate::model::now_rfc3339();
    Account {
        id: id.into(),
        label: id.into(),
        provider: crate::model::Provider::Anthropic,
        created_at: now.clone(),
        updated_at: now.clone(),
        last_usage: Some(UsageSnapshot {
            windows: vec![UsageWindow {
                id: "weekly".into(),
                label: "Weekly".into(),
                used_percent: Some(10.0),
                remaining_percent: Some(90.0),
                resets_at: None,
                window_seconds: Some(crate::model::WEEKLY_WINDOW_SECONDS),
                kind: Some(WindowKind::Weekly),
            }],
            fetched_at: now,
            ..UsageSnapshot::for_test()
        }),
        ..Account::for_test()
    }
}

fn recorded_readings(state: &AppState, account_id: &str) -> usize {
    let key = crate::history::tracker_key(account_id, "weekly");
    state
        .history
        .readings(std::slice::from_ref(&key), 0)
        .remove(&key)
        .map_or(0, |readings| readings.len())
}

#[tokio::test]
async fn removing_an_account_forgets_its_activity_history_and_only_its_own() {
    let directory = tempfile::tempdir().unwrap();
    let state =
        Arc::new(AppState::new(directory.path().to_path_buf(), "test-token".into()).unwrap());
    for id in ["state-history-gone", "state-history-kept"] {
        let account = account_with_weekly_usage(id);
        state.store.upsert(account.clone()).unwrap();
        state.history.record(&account).unwrap();
    }
    assert_eq!(recorded_readings(&state, "state-history-gone"), 1);

    state.remove_account("state-history-gone").await.unwrap();

    assert_eq!(recorded_readings(&state, "state-history-gone"), 0);
    assert_eq!(recorded_readings(&state, "state-history-kept"), 1);
    // The removal reached the disk too.
    let reopened = AppState::new(directory.path().to_path_buf(), "test-token".into()).unwrap();
    assert_eq!(recorded_readings(&reopened, "state-history-gone"), 0);
    assert_eq!(recorded_readings(&reopened, "state-history-kept"), 1);
}

#[tokio::test]
async fn deleting_all_local_data_deletes_the_activity_history() {
    let directory = tempfile::tempdir().unwrap();
    let state =
        Arc::new(AppState::new(directory.path().to_path_buf(), "test-token".into()).unwrap());
    let account = account_with_weekly_usage("state-history-wipe");
    state.store.upsert(account.clone()).unwrap();
    state.history.record(&account).unwrap();
    // History of an account that is already gone from the list is deleted as well.
    state
        .history
        .record(&account_with_weekly_usage("state-history-orphan"))
        .unwrap();
    let history_files = || {
        fs::read_dir(directory.path().join("activity-history"))
            .unwrap()
            .count()
    };
    assert_eq!(history_files(), 1);

    state.delete_all_local_data().await.unwrap();

    assert_eq!(recorded_readings(&state, "state-history-wipe"), 0);
    assert_eq!(recorded_readings(&state, "state-history-orphan"), 0);
    assert_eq!(history_files(), 0);
}

#[tokio::test]
async fn clearing_cached_usage_keeps_the_activity_history() {
    let directory = tempfile::tempdir().unwrap();
    let state =
        Arc::new(AppState::new(directory.path().to_path_buf(), "test-token".into()).unwrap());
    let account = account_with_weekly_usage("state-history-cache");
    state.store.upsert(account.clone()).unwrap();
    state.history.record(&account).unwrap();

    state.store.clear_cached_usage().unwrap();

    assert!(state
        .store
        .get("state-history-cache")
        .unwrap()
        .last_usage
        .is_none());
    assert_eq!(recorded_readings(&state, "state-history-cache"), 1);
}

#[test]
fn the_login_callback_is_offered_only_while_its_own_attempt_runs() {
    // L-96: the mobile navigation guard allows this one callback, and only
    // for the sign-in that recorded it.
    let temp = tempfile::tempdir().unwrap();
    let app = AppState::new(temp.path().to_path_buf(), "test-token".into()).unwrap();
    assert_eq!(app.active_login_callback(), None);

    app.begin_login("first", None).unwrap();
    app.set_login_callback("first", "http://localhost:1455/auth/callback");
    assert_eq!(
        app.active_login_callback().map(|url| url.to_string()),
        Some("http://localhost:1455/auth/callback".to_string())
    );

    // Finished: no callback is allowed any more.
    app.fail_login_if_waiting("first", "stopped".into());
    assert_eq!(app.active_login_callback(), None);

    // A new attempt does not inherit the previous attempt's callback.
    app.begin_login("second", None).unwrap();
    assert_eq!(app.active_login_callback(), None);
    app.set_login_callback("second", "not a url");
    assert_eq!(app.active_login_callback(), None);
}

/// A local server that records whether each request carried `x-goog-api-key`,
/// and one that redirects to it, standing in for a provider that redirects
/// across origins. Returns the redirecting server's URL and the record.
async fn redirect_to_a_recording_server() -> (String, std::sync::Arc<Mutex<Vec<bool>>>) {
    use axum::{http::HeaderMap, response::Redirect, routing::get, Router};
    let seen = std::sync::Arc::new(Mutex::new(Vec::new()));

    let sink = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let sink_address = sink.local_addr().unwrap();
    let record = seen.clone();
    let sink_router = Router::new().route(
        "/",
        get(move |headers: HeaderMap| {
            let record = record.clone();
            async move {
                record.lock().push(headers.contains_key("x-goog-api-key"));
                "ok"
            }
        }),
    );
    tokio::spawn(async move { axum::serve(sink, sink_router).await.unwrap() });

    let origin = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin_address = origin.local_addr().unwrap();
    let target = format!("http://{sink_address}/");
    let origin_router = Router::new().route(
        "/",
        get(move || {
            let target = target.clone();
            async move { Redirect::temporary(&target) }
        }),
    );
    tokio::spawn(async move { axum::serve(origin, origin_router).await.unwrap() });
    (format!("http://{origin_address}/"), seen)
}

#[tokio::test]
async fn provider_requests_do_not_follow_a_redirect_to_an_unencrypted_address() {
    // L-84: the shared client follows redirects only to HTTPS.
    let temp = tempfile::tempdir().unwrap();
    let app = AppState::new(temp.path().to_path_buf(), "test-token".into()).unwrap();
    let (url, seen) = redirect_to_a_recording_server().await;
    let error = app
        .client
        .get(url)
        .send()
        .await
        .expect_err("a redirect to http must fail");
    assert!(error.is_redirect(), "{error}");
    assert!(
        seen.lock().is_empty(),
        "the http target must never be requested"
    );
}

#[tokio::test]
async fn the_api_key_client_never_sends_its_key_header_to_a_redirect_target() {
    // L-84: reqwest forwards a custom header such as `x-goog-api-key` across
    // origins, so the request that carries it must not follow redirects.
    let temp = tempfile::tempdir().unwrap();
    let app = AppState::new(temp.path().to_path_buf(), "test-token".into()).unwrap();

    // Without the fix, a default client hands the key to the other origin.
    let (url, seen) = redirect_to_a_recording_server().await;
    let default_client = reqwest::Client::new();
    default_client
        .get(&url)
        .header("x-goog-api-key", "AIzaSyExampleKey")
        .send()
        .await
        .unwrap();
    assert_eq!(
        *seen.lock(),
        vec![true],
        "reqwest forwards the custom header"
    );

    // The api-key client stops at the redirect and never reaches the target.
    let (url, seen) = redirect_to_a_recording_server().await;
    let response = app
        .api_key_client
        .get(url)
        .header("x-goog-api-key", "AIzaSyExampleKey")
        .send()
        .await
        .unwrap();
    assert!(response.status().is_redirection());
    assert!(
        seen.lock().is_empty(),
        "the key must not reach the redirect target"
    );
}

#[test]
fn only_the_google_models_request_uses_the_api_key_client() {
    // Anything that puts the key in a header must use `api_key_client`.
    let source = include_str!("../providers/google_ai_studio/mod.rs");
    let code = source.split("#[cfg(test)]").next().unwrap();
    for (index, _) in code.match_indices("x-goog-api-key") {
        let before = &code[index.saturating_sub(260)..index];
        assert!(
            before.contains("api_key_client"),
            "a request with x-goog-api-key does not use api_key_client: {before}"
        );
    }
}

/// A failed removal must not touch the phone's in-app provider session, and
/// deleting everything must, even when no account was stored. The WebView
/// clear itself runs only on a phone; this pins the order in the source.
#[test]
fn removing_an_account_clears_the_in_app_sign_in_session() {
    let source = include_str!("../state.rs").replace("\r\n", "\n");
    let remove = method_body(&source, "pub async fn remove_account(");
    let failed = remove
        .find("result?")
        .expect("remove_account must keep the removal result");
    let cleared = remove
        .find("self.clear_provider_sign_in_session()")
        .expect("remove_account must clear the in-app sign-in session");
    assert!(
        failed < cleared,
        "a failed removal must not clear the sign-in session"
    );

    let wipe = method_body(&source, "pub async fn delete_all_local_data(");
    let reset = wipe
        .find("self.settings.reset()")
        .expect("delete_all_local_data resets settings");
    assert!(
        wipe[reset..].contains("self.clear_provider_sign_in_session()"),
        "delete all must clear the sign-in session even when no account was stored"
    );

    let helper = include_str!("../auth/mobile_auth/mod.rs").replace("\r\n", "\n");
    let clear = function_body(&helper, "fn clear_provider_sign_in_session(");
    let signature = clear.lines().next().expect("signature");
    assert!(
        !signature.contains("Result"),
        "a cookie-clear failure must not fail the removal"
    );
    let mobile = clear
        .find("#[cfg(mobile)]")
        .expect("the clear runs on a phone");
    let desktop = clear
        .find("#[cfg(not(mobile))]")
        .expect("desktop has no in-app provider session to clear");
    assert!(
        clear[mobile..desktop].contains("forget_provider_sign_in("),
        "the phone clear must drop the WebView's provider cookies"
    );
    assert!(
        !clear[desktop..].contains("forget_provider_sign_in("),
        "desktop must not try to clear an in-app session"
    );
}

/// The body of a method inside `impl AppState`, through its closing brace.
fn method_body<'a>(source: &'a str, signature: &str) -> &'a str {
    let start = source
        .find(signature)
        .unwrap_or_else(|| panic!("missing {signature}"));
    let body = &source[start..];
    &body[..body.find("\n    }\n").expect("end of method")]
}

/// The body of a top-level function, through its closing brace.
fn function_body<'a>(source: &'a str, signature: &str) -> &'a str {
    let start = source
        .find(signature)
        .unwrap_or_else(|| panic!("missing {signature}"));
    let body = &source[start..];
    &body[..body.find("\n}\n").expect("end of function")]
}

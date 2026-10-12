use crate::{
    account_order::AccountOrderStore,
    alerts::AlertStore,
    buckets::BucketStore,
    model::{Account, LoginStatus, ProviderSecret},
    refresh_backoff::RefreshBackoff,
    settings::SettingsStore,
    store::{AccountStore, StoreError},
};
use parking_lot::{Mutex, RwLock};
use reqwest::Client;
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};
use tauri::AppHandle;
use tokio::sync::{oneshot, Mutex as AsyncMutex, Notify, Semaphore};

/// Most accounts refreshed at the same time.
pub const MAX_CONCURRENT_REFRESHES: usize = 4;

#[derive(Clone, Debug)]
pub struct ApiRuntime {
    pub endpoint: String,
    pub running: bool,
    pub error: Option<String>,
}

#[derive(Clone, Debug)]
pub struct PendingAuthExchange {
    pub attempt_id: String,
    pub provider: crate::model::Provider,
    pub label: String,
    pub reconnect_account_id: Option<String>,
    pub code: String,
    pub verifier: String,
    pub expected_state: String,
    pub redirect_uri: String,
}

pub struct AppState {
    pub store: AccountStore,
    pub account_order: AccountOrderStore,
    pub alerts: AlertStore,
    pub buckets: BucketStore,
    pub settings: SettingsStore,
    pub client: Client,
    pub pending_login: RwLock<Option<LoginStatus>>,
    pub pending_auth_exchange: Mutex<Option<PendingAuthExchange>>,
    /// Serializes OAuth callback completion so overlapping status polls cannot
    /// replay a single-use authorization code.
    pub login_status_lock: AsyncMutex<()>,
    login_shutdowns: Mutex<HashMap<String, oneshot::Sender<()>>>,
    pub bridge_token: RwLock<String>,
    /// Per-client token buckets for bridge rate limiting, keyed by client IP.
    /// Bound to loopback only; idle entries are pruned on each check.
    pub bridge_rate_limit: Mutex<
        std::collections::HashMap<
            (std::net::IpAddr, crate::bridge_api::RateLane),
            crate::bridge_api::RateBucket,
        >,
    >,
    pub api_runtime: RwLock<ApiRuntime>,
    /// Why the local API cannot run at all (its token could not be loaded from
    /// secure storage). Reported through the bridge status instead of failing
    /// startup.
    bridge_unavailable: RwLock<Option<String>>,
    /// Saved sign-ins still stored unencrypted because sealing them failed
    /// (Android). Zero everywhere else.
    unprotected_credentials: AtomicUsize,
    /// Account ids for those sign-ins. Empty when the count is zero.
    unprotected_account_ids: RwLock<Vec<String>>,
    pub app_handle: RwLock<Option<AppHandle>>,
    pub pairing: Arc<crate::pairing::PairingSessionManager>,
    account_locks: Mutex<HashMap<String, Arc<AsyncMutex<()>>>>,
    /// Caps how many accounts are refreshed at once so a large account list
    /// does not open dozens of simultaneous provider connections.
    pub refresh_permits: Arc<Semaphore>,
    /// Failure backoff for automatic refreshes (in memory only).
    pub refresh_backoff: Mutex<RefreshBackoff>,
    refresh_wakeup: Notify,
    refresh_check: Notify,
    pub pairing_include_settings: RwLock<bool>,
    pub pairing_pending_ui_state: RwLock<Option<serde_json::Value>>,
    /// Explicit per-transfer opt-in to replace credentials of existing local
    /// accounts during a pairing import. Defaults to false (preserve local
    /// credentials); the frontend must set it for the transfer that should
    /// overwrite, and it is cleared after each import.
    pub pairing_allow_credential_replace: RwLock<bool>,
}

impl AppState {
    pub fn new(data_dir: PathBuf, bridge_token: String) -> Result<Self, String> {
        let store = load_with_metadata_recovery(&data_dir, "accounts.json", || {
            AccountStore::load(data_dir.clone()).map_err(|error| error.to_string())
        })?;
        let account_order = load_with_metadata_recovery(&data_dir, "account-order.json", || {
            AccountOrderStore::load(&data_dir)
        })?;
        let alerts = load_with_metadata_recovery(&data_dir, "usage-alerts.json", || {
            AlertStore::load(&data_dir)
        })?;
        let buckets = load_with_metadata_recovery(&data_dir, "account-buckets.json", || {
            BucketStore::load(&data_dir)
        })?;
        let settings = load_with_metadata_recovery(&data_dir, "app-settings.json", || {
            SettingsStore::load(&data_dir)
        })?;
        let client = Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(15))
            .user_agent(concat!("AI-Usage-Tracker/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|error| error.to_string())?;
        Ok(Self {
            store,
            account_order,
            alerts,
            buckets,
            settings,
            client,
            pending_login: RwLock::new(None),
            pending_auth_exchange: Mutex::new(None),
            login_status_lock: AsyncMutex::new(()),
            login_shutdowns: Mutex::new(HashMap::new()),
            bridge_token: RwLock::new(bridge_token),
            bridge_rate_limit: Mutex::new(std::collections::HashMap::new()),
            api_runtime: RwLock::new(ApiRuntime {
                endpoint: "http://127.0.0.1:47831/v1/paseo-usage".into(),
                running: false,
                error: None,
            }),
            bridge_unavailable: RwLock::new(None),
            unprotected_credentials: AtomicUsize::new(0),
            unprotected_account_ids: RwLock::new(Vec::new()),
            app_handle: RwLock::new(None),
            pairing: Arc::new(crate::pairing::PairingSessionManager::new()),
            account_locks: Mutex::new(HashMap::new()),
            refresh_permits: Arc::new(Semaphore::new(MAX_CONCURRENT_REFRESHES)),
            refresh_backoff: Mutex::new(RefreshBackoff::default()),
            refresh_wakeup: Notify::new(),
            refresh_check: Notify::new(),
            pairing_include_settings: RwLock::new(false),
            pairing_pending_ui_state: RwLock::new(None),
            pairing_allow_credential_replace: RwLock::new(false),
        })
    }

    pub fn set_bridge_unavailable(&self, reason: Option<String>) {
        *self.bridge_unavailable.write() = reason;
    }

    pub fn bridge_unavailable(&self) -> Option<String> {
        self.bridge_unavailable.read().clone()
    }

    pub fn set_unprotected_credentials(&self, count: usize, account_ids: Vec<String>) {
        self.unprotected_credentials.store(count, Ordering::Relaxed);
        *self.unprotected_account_ids.write() = if count == 0 { Vec::new() } else { account_ids };
    }

    pub fn unprotected_credentials(&self) -> usize {
        self.unprotected_credentials.load(Ordering::Relaxed)
    }

    pub fn unprotected_account_ids(&self) -> Vec<String> {
        self.unprotected_account_ids.read().clone()
    }

    pub fn wakeup_refresh(&self) {
        self.refresh_wakeup.notify_waiters();
    }

    pub async fn wait_for_refresh_wakeup(&self) {
        self.refresh_wakeup.notified().await;
    }

    /// Asks the refresh loop to re-check whether a refresh is due (app resumed
    /// or regained focus). Unlike `wakeup_refresh` this does not force a
    /// refresh, and the request is remembered if the loop is mid-refresh.
    pub fn request_refresh_check(&self) {
        self.refresh_check.notify_one();
    }

    pub async fn wait_for_refresh_check(&self) {
        self.refresh_check.notified().await;
    }

    pub fn set_app_handle(&self, app_handle: AppHandle) {
        *self.app_handle.write() = Some(app_handle);
    }

    pub fn register_login_shutdown(&self, attempt_id: String, sender: oneshot::Sender<()>) {
        if let Some(previous) = self.login_shutdowns.lock().insert(attempt_id, sender) {
            let _ = previous.send(());
        }
    }

    pub fn stop_login_shutdown(&self, attempt_id: &str) {
        if let Some(sender) = self.login_shutdowns.lock().remove(attempt_id) {
            let _ = sender.send(());
        }
    }

    /// Stops the loopback callback server and drops any queued authorization
    /// code for this attempt so it cannot be retried on a later poll.
    pub fn abort_login_resources(&self, attempt_id: &str) {
        self.stop_login_shutdown(attempt_id);
        let mut exchange = self.pending_auth_exchange.lock();
        if exchange
            .as_ref()
            .is_some_and(|pending| pending.attempt_id == attempt_id)
        {
            *exchange = None;
        }
    }

    /// True while attempt `attempt_id` is the pending login and still waiting on
    /// the provider. Only a hint: use `update_login_if_waiting` to act on it.
    pub fn login_is_waiting(&self, attempt_id: &str) -> bool {
        self.pending_login
            .read()
            .as_ref()
            .is_some_and(|login| login.is_waiting_for(attempt_id))
    }

    /// Runs `update` on the pending login only while attempt `attempt_id` is
    /// still waiting. The check and the write share one lock, so an attempt that
    /// completes or is cancelled at the same moment is never overwritten.
    /// Returns whether `update` ran.
    pub fn update_login_if_waiting(
        &self,
        attempt_id: &str,
        update: impl FnOnce(&mut LoginStatus),
    ) -> bool {
        let mut pending = self.pending_login.write();
        match pending.as_mut() {
            Some(login) if login.is_waiting_for(attempt_id) => {
                update(login);
                true
            }
            _ => false,
        }
    }

    /// Marks attempt `attempt_id` failed with `message` if it is still waiting.
    pub fn fail_login_if_waiting(&self, attempt_id: &str, message: String) {
        self.update_login_if_waiting(attempt_id, |login| {
            *login = LoginStatus::failed(attempt_id, message);
        });
    }

    /// Shows `message` on attempt `attempt_id` if it is still waiting.
    pub fn set_waiting_message(&self, attempt_id: &str, message: String) {
        self.update_login_if_waiting(attempt_id, |login| login.message = Some(message));
    }

    /// Drops a waiting in-app login so backing out of the provider page does not
    /// block the next Add Account attempt. Returns whether an attempt was cleared.
    #[cfg_attr(not(any(test, mobile)), allow(dead_code))]
    pub fn abandon_waiting_login(&self, attempt_id: &str) -> bool {
        let abandoned = {
            let mut pending = self.pending_login.write();
            let matches = pending.as_ref().is_some_and(|login| {
                login.attempt_id == attempt_id && login.status.is_in_progress()
            });
            if matches {
                *pending = None;
            }
            matches
        };
        if abandoned {
            self.abort_login_resources(attempt_id);
        }
        abandoned
    }

    pub fn account_lock(&self, account_id: &str) -> Arc<AsyncMutex<()>> {
        let mut locks = self.account_locks.lock();
        locks
            .entry(account_id.to_string())
            .or_insert_with(|| Arc::new(AsyncMutex::new(())))
            .clone()
    }

    /// Drops the lock entry for a removed account once nobody else holds or
    /// awaits it, so the map does not grow with every account ever added.
    fn forget_account_lock(&self, account_id: &str) {
        let mut locks = self.account_locks.lock();
        if locks
            .get(account_id)
            .is_some_and(|lock| Arc::strong_count(lock) == 1)
        {
            locks.remove(account_id);
        }
    }

    /// Removes an account and everything keyed by it. Holds the account's lock
    /// for the whole removal so it cannot interleave with an in-flight refresh:
    /// a refresh that saved rotated credentials after the delete would leave an
    /// orphaned secret behind for an account the user removed.
    pub async fn remove_account(&self, account_id: &str) -> Result<(), String> {
        let lock = self.account_lock(account_id);
        let guard = lock.clone().lock_owned().await;
        let result = self.remove_account_locked(account_id);
        drop(guard);
        drop(lock);
        self.forget_account_lock(account_id);
        result
    }

    fn remove_account_locked(&self, account_id: &str) -> Result<(), String> {
        self.store
            .remove(account_id)
            .map_err(|error| error.to_string())?;
        self.refresh_backoff.lock().forget(account_id);
        self.account_order.remove(account_id)?;
        self.alerts.remove(account_id)?;
        self.buckets.cleanup_account(account_id)?;
        Ok(())
    }

    pub async fn persist_connected_account(
        &self,
        account: Account,
        secret: &ProviderSecret,
    ) -> Result<Account, StoreError> {
        let lock = self.account_lock(&account.id);
        let _guard = lock.lock().await;
        self.store.persist_account(account, secret)
    }
}

fn load_with_metadata_recovery<T, F>(data_dir: &Path, file_name: &str, load: F) -> Result<T, String>
where
    F: Fn() -> Result<T, String>,
{
    match load() {
        Ok(value) => Ok(value),
        Err(original_error) => {
            let Some(quarantined_path) = quarantine_metadata_file(data_dir, file_name)? else {
                return Err(original_error);
            };
            load().map_err(|recovery_error| {
                format!(
                    "Unable to recover {file_name} after moving the unreadable file to {}. Original error: {original_error}. Recovery error: {recovery_error}",
                    quarantined_path.display()
                )
            })
        }
    }
}

fn quarantine_metadata_file(data_dir: &Path, file_name: &str) -> Result<Option<PathBuf>, String> {
    let source = data_dir.join(file_name);
    if !source.exists() {
        return Ok(None);
    }

    for index in 0..1000 {
        let suffix = if index == 0 {
            "invalid".to_string()
        } else {
            format!("invalid-{index}")
        };
        let destination = data_dir.join(format!("{file_name}.{suffix}"));
        if destination.exists() {
            continue;
        }
        fs::rename(&source, &destination).map_err(|error| {
            format!(
                "Unable to preserve unreadable startup metadata {}: {error}",
                source.display()
            )
        })?;
        return Ok(Some(destination));
    }

    Err(format!(
        "Unable to preserve unreadable startup metadata {} because too many quarantine files already exist.",
        source.display()
    ))
}

#[cfg(test)]
mod tests {
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
        // src/types.ts: "waiting" | "complete" | "failed" | "choose_project" | "monitoring_disabled"
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
            email: None,
            provider_account_id: None,
            chatgpt_account_id: None,
            plan: None,
            created_at: now.clone(),
            updated_at: now,
            last_usage: None,
            last_error: None,
            auth_required: false,
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
}

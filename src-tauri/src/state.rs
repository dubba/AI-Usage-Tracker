use crate::{
    history::HistoryStore,
    model::{Account, LoginStatus, ProviderSecret},
    refresh_backoff::RefreshBackoff,
    store::account_order::AccountOrderStore,
    store::alerts::AlertStore,
    store::buckets::BucketStore,
    store::settings::SettingsStore,
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

#[derive(Clone)]
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

impl std::fmt::Debug for PendingAuthExchange {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("PendingAuthExchange")
            .field("attempt_id", &self.attempt_id)
            .field("provider", &self.provider)
            .field("label", &self.label)
            .field("reconnect_account_id", &self.reconnect_account_id)
            .field("code", &crate::model::REDACTED_DEBUG)
            .field("verifier", &crate::model::REDACTED_DEBUG)
            .field("expected_state", &crate::model::REDACTED_DEBUG)
            .field("redirect_uri", &self.redirect_uri)
            .finish()
    }
}

pub struct AppState {
    pub store: AccountStore,
    pub account_order: AccountOrderStore,
    pub alerts: AlertStore,
    pub buckets: BucketStore,
    pub settings: SettingsStore,
    /// Weekly usage readings for the Usage page.
    pub history: HistoryStore,
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
    /// What the next pairing transfer carries beyond accounts; reset between transfers.
    pub pairing_options: RwLock<crate::pairing::PairingTransferOptions>,
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
        // Cannot fail: unreadable history is set aside and the app starts without it.
        let history = HistoryStore::load(&data_dir);
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
            history,
            client,
            pending_login: RwLock::new(None),
            pending_auth_exchange: Mutex::new(None),
            login_status_lock: AsyncMutex::new(()),
            login_shutdowns: Mutex::new(HashMap::new()),
            bridge_token: RwLock::new(bridge_token),
            bridge_rate_limit: Mutex::new(std::collections::HashMap::new()),
            api_runtime: RwLock::new(ApiRuntime {
                endpoint: crate::bridge_api::bridge_endpoint(),
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
            pairing_options: RwLock::new(Default::default()),
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

    /// Makes `attempt_id` the pending login, waiting with `message`, unless another login is still
    /// in progress. The check and the write share one lock.
    pub fn begin_login(&self, attempt_id: &str, message: Option<String>) -> Result<(), String> {
        let mut pending = self.pending_login.write();
        if pending
            .as_ref()
            .is_some_and(|login| login.status.is_in_progress())
        {
            return Err(crate::auth::oauth_common::LOGIN_IN_PROGRESS_MESSAGE.into());
        }
        *pending = Some(LoginStatus::waiting(attempt_id, message));
        Ok(())
    }

    /// Forgets the pending login if it is attempt `attempt_id`, e.g. when starting it failed
    /// before anything was shown to the user. Another attempt's status is left alone.
    pub fn clear_pending_login(&self, attempt_id: &str) {
        let mut pending = self.pending_login.write();
        if pending
            .as_ref()
            .is_some_and(|login| login.attempt_id == attempt_id)
        {
            *pending = None;
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

    /// Updates the account in `pending_login` if attempt `attempt_id` has completed.
    pub fn update_login_account(&self, attempt_id: &str, refreshed_account: Account) {
        let mut pending = self.pending_login.write();
        if let Some(login) = pending.as_mut() {
            if login.attempt_id == attempt_id && login.status == crate::model::LoginState::Complete
            {
                login.account = Some(refreshed_account);
            }
        }
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
        self.history.remove_account(account_id)?;
        Ok(())
    }

    /// Removes every account with its saved sign-in, then what is left over: bucket groups, the
    /// account order, alert settings, the usage history, the deleted-account list, and all
    /// settings. Accounts go one at a time through `remove_account`, so a failure part-way leaves
    /// the rest of the data as it was and can simply be tried again.
    pub async fn delete_all_local_data(&self) -> Result<(), String> {
        for account in self.store.list() {
            self.remove_account(&account.id).await?;
        }
        self.store.clear_tombstones();
        self.account_order.clear()?;
        self.alerts.clear()?;
        self.buckets.clear()?;
        self.history.clear()?;
        self.settings.reset()?;
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

pub(crate) fn quarantine_metadata_file(
    data_dir: &Path,
    file_name: &str,
) -> Result<Option<PathBuf>, String> {
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
mod tests;

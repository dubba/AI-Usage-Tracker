use crate::{
    account_order::AccountOrderStore,
    alerts::AlertStore,
    model::LoginStatus,
    settings::SettingsStore,
    store::AccountStore,
};
use parking_lot::{Mutex, RwLock};
use reqwest::Client;
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant},
};
use tauri::AppHandle;
use tokio::sync::{oneshot, Mutex as AsyncMutex};

#[derive(Clone, Debug)]
pub struct ApiRuntime {
    pub endpoint: String,
    pub running: bool,
    pub error: Option<String>,
}

pub struct AppState {
    pub store: AccountStore,
    pub account_order: AccountOrderStore,
    pub alerts: AlertStore,
    pub settings: SettingsStore,
    pub client: Client,
    pub pending_login: RwLock<Option<LoginStatus>>,
    login_shutdowns: Mutex<HashMap<String, oneshot::Sender<()>>>,
    pub bridge_token: RwLock<String>,
    pub bridge_rate_limit: Mutex<Option<Instant>>,
    pub api_runtime: RwLock<ApiRuntime>,
    pub app_handle: RwLock<Option<AppHandle>>,
    account_locks: Mutex<HashMap<String, Arc<AsyncMutex<()>>>>,
    #[allow(dead_code)]
    pub data_dir: PathBuf,
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
        let settings = load_with_metadata_recovery(&data_dir, "app-settings.json", || {
            SettingsStore::load(&data_dir)
        })?;
        let client = Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(15))
            .user_agent("AI-Usage-Tracker/0.1")
            .build()
            .map_err(|error| error.to_string())?;
        Ok(Self {
            store,
            account_order,
            alerts,
            settings,
            client,
            pending_login: RwLock::new(None),
            login_shutdowns: Mutex::new(HashMap::new()),
            bridge_token: RwLock::new(bridge_token),
            bridge_rate_limit: Mutex::new(None),
            api_runtime: RwLock::new(ApiRuntime {
                endpoint: "http://127.0.0.1:47831/v1/paseo-usage".into(),
                running: false,
                error: None,
            }),
            app_handle: RwLock::new(None),
            account_locks: Mutex::new(HashMap::new()),
            data_dir,
        })
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

    pub fn account_lock(&self, account_id: &str) -> Arc<AsyncMutex<()>> {
        let mut locks = self.account_locks.lock();
        locks
            .entry(account_id.to_string())
            .or_insert_with(|| Arc::new(AsyncMutex::new(())))
            .clone()
    }
}

fn load_with_metadata_recovery<T, F>(
    data_dir: &Path,
    file_name: &str,
    load: F,
) -> Result<T, String>
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

    #[test]
    fn invalid_primary_accounts_fall_back_to_backup() {
        let directory = tempfile::tempdir().unwrap();
        fs::write(directory.path().join("accounts.json"), r#"{"version":2,"accounts":[{"provider":"unsupported"}]}"#).unwrap();
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

        assert_eq!(settings.get().account_refresh_minutes, 5);
        assert!(directory.path().join("app-settings.json.invalid").exists());
    }
}

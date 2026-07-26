use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use std::{fs, path::{Path, PathBuf}};
use tokio::sync::Notify;

const SETTINGS_FILE_NAME: &str = "app-settings.json";
pub const DEFAULT_ACCOUNT_REFRESH_MINUTES: u64 = 5;
pub const MIN_ACCOUNT_REFRESH_MINUTES: u64 = 5;
pub const MAX_ACCOUNT_REFRESH_MINUTES: u64 = 60;
pub const ACCOUNT_REFRESH_STEP_MINUTES: u64 = 5;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub account_refresh_minutes: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct StoredAppSettings {
    #[serde(default = "settings_version")]
    version: u32,
    #[serde(default = "default_account_refresh_minutes")]
    account_refresh_minutes: u64,
    #[serde(default)]
    last_notified_update_version: Option<String>,
}

impl Default for StoredAppSettings {
    fn default() -> Self {
        Self {
            version: settings_version(),
            account_refresh_minutes: DEFAULT_ACCOUNT_REFRESH_MINUTES,
            last_notified_update_version: None,
        }
    }
}

pub struct SettingsStore {
    path: PathBuf,
    settings: RwLock<StoredAppSettings>,
    refresh_schedule_changed: Notify,
}

impl SettingsStore {
    pub fn load(data_dir: &Path) -> Result<Self, String> {
        fs::create_dir_all(data_dir).map_err(|error| error.to_string())?;
        let path = data_dir.join(SETTINGS_FILE_NAME);
        let mut settings = if path.exists() {
            let payload = fs::read_to_string(&path).map_err(|error| error.to_string())?;
            serde_json::from_str::<StoredAppSettings>(&payload)
                .map_err(|error| format!("Unable to read app settings: {error}"))?
        } else {
            StoredAppSettings::default()
        };

        if !valid_refresh_minutes(settings.account_refresh_minutes) {
            settings.account_refresh_minutes = DEFAULT_ACCOUNT_REFRESH_MINUTES;
        }

        Ok(Self {
            path,
            settings: RwLock::new(settings),
            refresh_schedule_changed: Notify::new(),
        })
    }

    pub fn get(&self) -> AppSettings {
        AppSettings {
            account_refresh_minutes: self.settings.read().account_refresh_minutes,
        }
    }

    pub fn account_refresh_minutes(&self) -> u64 {
        self.settings.read().account_refresh_minutes
    }

    pub fn set_account_refresh_minutes(&self, minutes: u64) -> Result<AppSettings, String> {
        if !valid_refresh_minutes(minutes) {
            return Err("Account updates must be between 5 and 60 minutes in 5-minute increments.".into());
        }

        let mut settings = self.settings.write();
        if settings.account_refresh_minutes == minutes {
            return Ok(AppSettings {
                account_refresh_minutes: minutes,
            });
        }

        let mut next = settings.clone();
        next.account_refresh_minutes = minutes;
        self.persist(&next)?;
        *settings = next;
        self.refresh_schedule_changed.notify_one();

        Ok(AppSettings {
            account_refresh_minutes: minutes,
        })
    }

    pub async fn wait_for_refresh_schedule_change(&self) {
        self.refresh_schedule_changed.notified().await;
    }

    pub fn update_notification_needed(&self, version: &str) -> bool {
        self.settings
            .read()
            .last_notified_update_version
            .as_deref()
            != Some(version)
    }

    pub fn mark_update_notified(&self, version: &str) -> Result<(), String> {
        let mut settings = self.settings.write();
        if settings.last_notified_update_version.as_deref() == Some(version) {
            return Ok(());
        }

        let mut next = settings.clone();
        next.last_notified_update_version = Some(version.to_string());
        self.persist(&next)?;
        *settings = next;
        Ok(())
    }

    fn persist(&self, settings: &StoredAppSettings) -> Result<(), String> {
        let payload = serde_json::to_vec_pretty(settings).map_err(|error| error.to_string())?;
        fs::write(&self.path, payload).map_err(|error| error.to_string())
    }
}

fn settings_version() -> u32 {
    1
}

fn default_account_refresh_minutes() -> u64 {
    DEFAULT_ACCOUNT_REFRESH_MINUTES
}

fn valid_refresh_minutes(minutes: u64) -> bool {
    (MIN_ACCOUNT_REFRESH_MINUTES..=MAX_ACCOUNT_REFRESH_MINUTES).contains(&minutes)
        && minutes % ACCOUNT_REFRESH_STEP_MINUTES == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saves_supported_refresh_intervals() {
        let directory = tempfile::tempdir().unwrap();
        let store = SettingsStore::load(directory.path()).unwrap();
        assert_eq!(store.get().account_refresh_minutes, 5);
        assert_eq!(store.set_account_refresh_minutes(35).unwrap().account_refresh_minutes, 35);
        assert_eq!(SettingsStore::load(directory.path()).unwrap().get().account_refresh_minutes, 35);
    }

    #[test]
    fn rejects_unsupported_refresh_intervals() {
        let directory = tempfile::tempdir().unwrap();
        let store = SettingsStore::load(directory.path()).unwrap();
        assert!(store.set_account_refresh_minutes(0).is_err());
        assert!(store.set_account_refresh_minutes(7).is_err());
        assert!(store.set_account_refresh_minutes(65).is_err());
    }

    #[test]
    fn remembers_notified_update_versions() {
        let directory = tempfile::tempdir().unwrap();
        let store = SettingsStore::load(directory.path()).unwrap();
        assert!(store.update_notification_needed("0.2.23"));
        store.mark_update_notified("0.2.23").unwrap();
        assert!(!SettingsStore::load(directory.path()).unwrap().update_notification_needed("0.2.23"));
        assert!(store.update_notification_needed("0.2.24"));
    }
}

use crate::{model::Account, store::json_file::JsonFileStore};
// The rules (which windows an alert watches, when it fires) live in `usage_core::alerts`; this
// store keeps the settings and what each one already notified about.
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    path::Path,
};
pub use usage_core::alerts::AlertNotification;
use usage_core::alerts::{self, ALERT_WINDOW_IDS};

const ALERTS_FILE_NAME: &str = "usage-alerts.json";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct UsageAlertSetting {
    #[cfg_attr(test, ts(type = r#""five_hour" | "weekly" | "monthly""#))]
    pub window_id: String,
    pub enabled: bool,
    pub threshold_percent: u8,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredUsageAlertSetting {
    window_id: String,
    enabled: bool,
    threshold_percent: u8,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    last_notified_key: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AlertFile {
    version: u32,
    accounts: HashMap<String, Vec<StoredUsageAlertSetting>>,
}

pub struct AlertStore {
    file: JsonFileStore<AlertFile>,
    accounts: RwLock<HashMap<String, Vec<StoredUsageAlertSetting>>>,
}

impl AlertStore {
    pub fn load(data_dir: &Path) -> Result<Self, String> {
        let (file, saved) = JsonFileStore::<AlertFile>::open(
            data_dir,
            ALERTS_FILE_NAME,
            "Unable to read usage alert settings",
        )?;
        Ok(Self {
            file,
            accounts: RwLock::new(saved.accounts),
        })
    }

    pub fn get(&self, account_id: &str) -> Vec<UsageAlertSetting> {
        let mut settings = self
            .accounts
            .read()
            .get(account_id)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .map(|setting| UsageAlertSetting {
                window_id: setting.window_id,
                enabled: setting.enabled,
                threshold_percent: setting.threshold_percent,
            })
            .collect::<Vec<_>>();
        sort_settings(&mut settings, |setting| setting.window_id.as_str());
        settings
    }

    pub fn export_all(&self) -> Vec<(String, Vec<UsageAlertSetting>)> {
        let accounts = self.accounts.read().clone();
        let mut out = Vec::new();
        for (account_id, stored) in accounts {
            let mut settings = stored
                .into_iter()
                .map(|setting| UsageAlertSetting {
                    window_id: setting.window_id,
                    enabled: setting.enabled,
                    threshold_percent: setting.threshold_percent,
                })
                .collect::<Vec<_>>();
            sort_settings(&mut settings, |setting| setting.window_id.as_str());
            if !settings.is_empty() {
                out.push((account_id, settings));
            }
        }
        out
    }

    pub fn save(
        &self,
        account_id: &str,
        settings: Vec<UsageAlertSetting>,
    ) -> Result<Vec<UsageAlertSetting>, String> {
        if settings.len() > ALERT_WINDOW_IDS.len() {
            return Err("Only 5 hour, weekly, and monthly alerts are supported.".into());
        }

        let mut seen = HashSet::new();
        for setting in &settings {
            if !ALERT_WINDOW_IDS.contains(&setting.window_id.as_str()) {
                return Err(format!(
                    "Unsupported usage alert window: {}",
                    setting.window_id
                ));
            }
            if !seen.insert(setting.window_id.as_str()) {
                return Err(format!(
                    "Duplicate usage alert window: {}",
                    setting.window_id
                ));
            }
            if !(1..=100).contains(&setting.threshold_percent) {
                return Err("Alert thresholds must be between 1% and 100%.".into());
            }
        }

        let existing = self
            .accounts
            .read()
            .get(account_id)
            .cloned()
            .unwrap_or_default();
        let mut stored = settings
            .iter()
            .map(|setting| {
                let previous = existing.iter().find(|candidate| {
                    candidate.window_id == setting.window_id
                        && candidate.enabled == setting.enabled
                        && candidate.threshold_percent == setting.threshold_percent
                });
                StoredUsageAlertSetting {
                    window_id: setting.window_id.clone(),
                    enabled: setting.enabled,
                    threshold_percent: setting.threshold_percent,
                    last_notified_key: previous
                        .and_then(|candidate| candidate.last_notified_key.clone()),
                }
            })
            .collect::<Vec<_>>();
        sort_settings(&mut stored, |setting| setting.window_id.as_str());

        let mut accounts = self.accounts.write();
        if stored.is_empty() {
            accounts.remove(account_id);
        } else {
            accounts.insert(account_id.to_string(), stored);
        }
        self.persist_locked(&accounts)?;
        Ok(settings)
    }

    pub fn evaluate(&self, account: &Account) -> Result<Vec<AlertNotification>, String> {
        if account.last_usage.is_none() {
            return Ok(Vec::new());
        }
        let mut accounts = self.accounts.write();
        let Some(settings) = accounts.get_mut(&account.id) else {
            return Ok(Vec::new());
        };

        let mut notifications = Vec::new();
        let mut changed = false;
        for setting in settings.iter_mut().filter(|setting| setting.enabled) {
            let mut notified: HashSet<String> = setting
                .last_notified_key
                .as_deref()
                .unwrap_or("")
                .split('|')
                .filter(|key| !key.is_empty())
                .map(str::to_string)
                .collect();
            let (sent, keys_changed) = alerts::check(
                account,
                &setting.window_id,
                setting.threshold_percent,
                &mut notified,
            );
            notifications.extend(sent);
            changed |= keys_changed;

            let updated_key = if notified.is_empty() {
                None
            } else {
                let mut keys: Vec<String> = notified.into_iter().collect();
                keys.sort();
                Some(keys.join("|"))
            };
            if setting.last_notified_key != updated_key {
                setting.last_notified_key = updated_key;
                changed = true;
            }
        }

        if changed {
            self.persist_locked(&accounts)?;
        }
        Ok(notifications)
    }

    pub fn remove(&self, account_id: &str) -> Result<(), String> {
        let mut accounts = self.accounts.write();
        if accounts.remove(account_id).is_some() {
            self.persist_locked(&accounts)?;
        }
        Ok(())
    }

    /// Forgets every account's alert settings, including those of accounts that no longer exist.
    pub fn clear(&self) -> Result<(), String> {
        let mut accounts = self.accounts.write();
        if !accounts.is_empty() {
            accounts.clear();
            self.persist_locked(&accounts)?;
        }
        Ok(())
    }

    fn persist_locked(
        &self,
        accounts: &HashMap<String, Vec<StoredUsageAlertSetting>>,
    ) -> Result<(), String> {
        self.file.save(&AlertFile {
            version: 1,
            accounts: accounts.clone(),
        })
    }
}

fn sort_settings<T, F>(settings: &mut [T], window_id: F)
where
    F: Fn(&T) -> &str,
{
    settings.sort_by_key(|setting| {
        ALERT_WINDOW_IDS
            .iter()
            .position(|candidate| candidate == &window_id(setting))
            .unwrap_or(ALERT_WINDOW_IDS.len())
    });
}

#[cfg(test)]
mod tests;

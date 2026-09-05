use crate::{
    fs_util::{atomic_write_private, ensure_private_file},
    model::{Account, UsageWindow},
};
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
};

const ALERTS_FILE_NAME: &str = "usage-alerts.json";
const ALERT_WINDOW_IDS: [&str; 3] = ["five_hour", "weekly", "monthly"];

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UsageAlertSetting {
    pub window_id: String,
    pub enabled: bool,
    pub threshold_percent: u8,
}

#[derive(Clone, Debug)]
pub struct AlertNotification {
    pub window_label: String,
    pub remaining_percent: u8,
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
    path: PathBuf,
    accounts: RwLock<HashMap<String, Vec<StoredUsageAlertSetting>>>,
}

impl AlertStore {
    pub fn load(data_dir: &Path) -> Result<Self, String> {
        fs::create_dir_all(data_dir).map_err(|error| error.to_string())?;
        let path = data_dir.join(ALERTS_FILE_NAME);
        let accounts = if path.exists() {
            let payload = fs::read_to_string(&path).map_err(|error| error.to_string())?;
            let parsed = serde_json::from_str::<AlertFile>(&payload)
                .map_err(|error| format!("Unable to read usage alert settings: {error}"))?
                .accounts;
            ensure_private_file(&path)?;
            parsed
        } else {
            HashMap::new()
        };
        Ok(Self {
            path,
            accounts: RwLock::new(accounts),
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
                return Err(format!("Unsupported usage alert window: {}", setting.window_id));
            }
            if !seen.insert(setting.window_id.as_str()) {
                return Err(format!("Duplicate usage alert window: {}", setting.window_id));
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
                    last_notified_key: previous.and_then(|candidate| candidate.last_notified_key.clone()),
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
        let Some(usage) = account.last_usage.as_ref() else {
            return Ok(Vec::new());
        };
        let mut accounts = self.accounts.write();
        let Some(settings) = accounts.get_mut(&account.id) else {
            return Ok(Vec::new());
        };

        let mut notifications = Vec::new();
        let mut changed = false;
        for setting in settings.iter_mut().filter(|setting| setting.enabled) {
            let matching_windows: Vec<&UsageWindow> = usage
                .windows
                .iter()
                .filter(|window| {
                    if canonical_window_id(window) == Some(setting.window_id.as_str()) {
                        return true;
                    }
                    if account.provider == crate::model::Provider::Openai
                        && setting.window_id == "monthly"
                        && account.plan.as_deref().map_or(true, |p| p.eq_ignore_ascii_case("free"))
                        && (window.id == "session" || window.id == "monthly")
                    {
                        return true;
                    }
                    false
                })
                .collect();

            if matching_windows.is_empty() {
                continue;
            }

            let mut notified_keys: HashSet<String> = setting
                .last_notified_key
                .as_deref()
                .unwrap_or("")
                .split('|')
                .filter(|k| !k.is_empty())
                .map(str::to_string)
                .collect();

            for window in matching_windows {
                let Some(remaining) = window.remaining_percent.filter(|value| value.is_finite()) else {
                    continue;
                };
                let remaining = remaining.clamp(0.0, 100.0).round() as u8;
                let period = window.resets_at.as_deref().unwrap_or(&usage.fetched_at);
                let notification_key = format!("{}:{}:{}", window.id, period, setting.threshold_percent);
                let legacy_key = format!("{period}:{}", setting.threshold_percent);

                if remaining <= setting.threshold_percent {
                    if !notified_keys.contains(&notification_key) && !notified_keys.contains(&legacy_key) {
                        notified_keys.insert(notification_key);
                        changed = true;

                        let base_label = display_window_label(&setting.window_id);
                        let window_label = if let Some((group, _)) = window.label.split_once(" · ") {
                            let clean_group = group.trim();
                            if !clean_group.is_empty() {
                                format!("{base_label} ({clean_group})")
                            } else {
                                base_label.into()
                            }
                        } else {
                            base_label.into()
                        };

                        notifications.push(AlertNotification {
                            window_label,
                            remaining_percent: remaining,
                            threshold_percent: setting.threshold_percent,
                        });
                    }
                } else if notified_keys.remove(&notification_key) || notified_keys.remove(&legacy_key) {
                    changed = true;
                }
            }

            let updated_key = if notified_keys.is_empty() {
                None
            } else {
                let mut keys: Vec<String> = notified_keys.into_iter().collect();
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

    fn persist_locked(
        &self,
        accounts: &HashMap<String, Vec<StoredUsageAlertSetting>>,
    ) -> Result<(), String> {
        let file = AlertFile {
            version: 1,
            accounts: accounts.clone(),
        };
        let payload = serde_json::to_vec_pretty(&file).map_err(|error| error.to_string())?;
        atomic_write_private(&self.path, &payload)
    }
}

pub fn canonical_window_id(window: &UsageWindow) -> Option<&'static str> {
    let id = window.id.to_ascii_lowercase().replace('-', "_");
    let label = window.label.to_ascii_lowercase();
    if id == "five_hour"
        || id.starts_with("five_hour")
        || id == "rolling"
        || window.window_seconds == Some(18_000)
        || label.contains("5 hour")
        || label.contains("five hour")
        || label.contains("5h")
        || label.contains("5-hour")
    {
        Some("five_hour")
    } else if id == "weekly"
        || id.starts_with("weekly")
        || window.window_seconds == Some(604_800)
        || label.contains("weekly")
        || label.contains("7 day")
        || label.contains("seven day")
        || label.contains("7d")
        || label.contains("7-day")
    {
        Some("weekly")
    } else if id == "monthly"
        || id.starts_with("monthly")
        || id == "thirty_day"
        || id.starts_with("thirty_day")
        || id.contains("30d")
        || id.contains("30-day")
        || id.contains("30_day")
        || window
            .window_seconds
            .map_or(false, |s| s >= 2_000_000 && s <= 2_700_000)
        || label.contains("monthly")
        || label.contains("30 day")
        || label.contains("thirty day")
        || label.contains("30d")
        || label.contains("30-day")
    {
        Some("monthly")
    } else {
        None
    }
}

fn display_window_label(window_id: &str) -> &'static str {
    match window_id {
        "five_hour" => "5 hour",
        "weekly" => "Weekly",
        "monthly" => "30-day",
        _ => "Usage",
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
mod tests {
    use super::*;
    use crate::model::{now_rfc3339, Provider, UsageFreshness, UsageSnapshot};

    fn account_with_weekly(remaining: f64) -> Account {
        let now = now_rfc3339();
        Account {
            id: "account-1".into(),
            label: "Test account".into(),
            provider: Provider::Openai,
            email: None,
            provider_account_id: None,
            chatgpt_account_id: None,
            plan: None,
            created_at: now.clone(),
            updated_at: now.clone(),
            last_usage: Some(UsageSnapshot {
                plan: None,
                email: None,
                windows: vec![UsageWindow {
                    id: "weekly".into(),
                    label: "Weekly".into(),
                    used_percent: Some(100.0 - remaining),
                    remaining_percent: Some(remaining),
                    resets_at: Some("2026-07-20T00:00:00Z".into()),
                    window_seconds: Some(604_800),
                }],
                credits_usd: None,
                unlimited_credits: false,
                fetched_at: now,
                freshness: UsageFreshness::Live,
                source: "test".into(),
            }),
            last_error: None,
            auth_required: false,
        }
    }

    #[test]
    fn notifies_once_per_period_below_threshold() {
        let directory = tempfile::tempdir().unwrap();
        let store = AlertStore::load(directory.path()).unwrap();
        store
            .save(
                "account-1",
                vec![UsageAlertSetting {
                    window_id: "weekly".into(),
                    enabled: true,
                    threshold_percent: 20,
                }],
            )
            .unwrap();
        let account = account_with_weekly(18.0);
        assert_eq!(store.evaluate(&account).unwrap().len(), 1);
        assert!(store.evaluate(&account).unwrap().is_empty());
    }

    #[test]
    fn rejects_unknown_windows() {
        let directory = tempfile::tempdir().unwrap();
        let store = AlertStore::load(directory.path()).unwrap();
        assert!(store
            .save(
                "account-1",
                vec![UsageAlertSetting {
                    window_id: "daily".into(),
                    enabled: true,
                    threshold_percent: 20,
                }],
            )
            .is_err());
    }

    #[test]
    fn canonical_window_id_recognizes_aliases_and_sub_windows() {
        let w1 = UsageWindow {
            id: "five_hour_2".into(),
            label: "Gemini models · 5-Hour Limit".into(),
            used_percent: Some(85.0),
            remaining_percent: Some(15.0),
            resets_at: None,
            window_seconds: Some(18_000),
        };
        let w2 = UsageWindow {
            id: "weekly_2".into(),
            label: "Gemini models · 7-Day Limit".into(),
            used_percent: Some(90.0),
            remaining_percent: Some(10.0),
            resets_at: None,
            window_seconds: Some(604_800),
        };
        let w3 = UsageWindow {
            id: "window-5h".into(),
            label: "5h Limit".into(),
            used_percent: None,
            remaining_percent: None,
            resets_at: None,
            window_seconds: None,
        };
        let w4 = UsageWindow {
            id: "window-7d".into(),
            label: "7d Limit".into(),
            used_percent: None,
            remaining_percent: None,
            resets_at: None,
            window_seconds: None,
        };

        assert_eq!(canonical_window_id(&w1), Some("five_hour"));
        assert_eq!(canonical_window_id(&w2), Some("weekly"));
        assert_eq!(canonical_window_id(&w3), Some("five_hour"));
        assert_eq!(canonical_window_id(&w4), Some("weekly"));
    }

    #[test]
    fn antigravity_multi_window_evaluation_triggers_alert_for_depleted_window() {
        let directory = tempfile::tempdir().unwrap();
        let store = AlertStore::load(directory.path()).unwrap();
        store
            .save(
                "antigravity-1",
                vec![
                    UsageAlertSetting {
                        window_id: "five_hour".into(),
                        enabled: true,
                        threshold_percent: 20,
                    },
                    UsageAlertSetting {
                        window_id: "weekly".into(),
                        enabled: true,
                        threshold_percent: 20,
                    },
                ],
            )
            .unwrap();

        let now = now_rfc3339();
        let mut account = Account {
            id: "antigravity-1".into(),
            label: "Work Antigravity".into(),
            provider: Provider::Antigravity,
            email: None,
            provider_account_id: None,
            chatgpt_account_id: None,
            plan: None,
            created_at: now.clone(),
            updated_at: now.clone(),
            last_usage: Some(UsageSnapshot {
                plan: None,
                email: None,
                windows: vec![
                    UsageWindow {
                        id: "five_hour_1".into(),
                        label: "Claude models · 5-Hour Limit".into(),
                        used_percent: Some(5.0),
                        remaining_percent: Some(95.0),
                        resets_at: Some("2026-09-05T06:00:00Z".into()),
                        window_seconds: Some(18_000),
                    },
                    UsageWindow {
                        id: "weekly_1".into(),
                        label: "Claude models · Weekly Limit".into(),
                        used_percent: Some(10.0),
                        remaining_percent: Some(90.0),
                        resets_at: Some("2026-09-12T00:00:00Z".into()),
                        window_seconds: Some(604_800),
                    },
                    UsageWindow {
                        id: "five_hour_2".into(),
                        label: "Gemini models · 5-Hour Limit".into(),
                        used_percent: Some(85.0),
                        remaining_percent: Some(15.0),
                        resets_at: Some("2026-09-05T07:00:00Z".into()),
                        window_seconds: Some(18_000),
                    },
                    UsageWindow {
                        id: "weekly_2".into(),
                        label: "Gemini models · Weekly Limit".into(),
                        used_percent: Some(92.0),
                        remaining_percent: Some(8.0),
                        resets_at: Some("2026-09-12T00:00:00Z".into()),
                        window_seconds: Some(604_800),
                    },
                ],
                credits_usd: None,
                unlimited_credits: false,
                fetched_at: now.clone(),
                freshness: UsageFreshness::Live,
                source: "antigravity".into(),
            }),
            last_error: None,
            auth_required: false,
        };

        // First evaluation: Gemini 5h and Gemini weekly are below 20%
        let alerts = store.evaluate(&account).unwrap();
        assert_eq!(alerts.len(), 2);
        assert!(alerts.iter().any(|a| a.window_label == "5 hour (Gemini models)" && a.remaining_percent == 15));
        assert!(alerts.iter().any(|a| a.window_label == "Weekly (Gemini models)" && a.remaining_percent == 8));

        // Second evaluation with identical usage: no duplicate alerts
        let alerts_second = store.evaluate(&account).unwrap();
        assert!(alerts_second.is_empty());

        // Now Claude 5h also drops below threshold (to 10%)
        if let Some(usage) = account.last_usage.as_mut() {
            usage.windows[0].remaining_percent = Some(10.0);
            usage.windows[0].used_percent = Some(90.0);
        }

        let alerts_third = store.evaluate(&account).unwrap();
        assert_eq!(alerts_third.len(), 1);
        assert_eq!(alerts_third[0].window_label, "5 hour (Claude models)");
        assert_eq!(alerts_third[0].remaining_percent, 10);
    }

    #[test]
    fn canonical_window_id_recognizes_thirty_day_windows() {
        let w1 = UsageWindow {
            id: "monthly".into(),
            label: "GPT · 30-Day Limit".into(),
            used_percent: Some(90.0),
            remaining_percent: Some(10.0),
            resets_at: None,
            window_seconds: Some(2_592_000),
        };
        let w2 = UsageWindow {
            id: "session".into(),
            label: "Session".into(),
            used_percent: Some(85.0),
            remaining_percent: Some(15.0),
            resets_at: None,
            window_seconds: Some(2_592_000),
        };
        let w3 = UsageWindow {
            id: "window-30d".into(),
            label: "30d window".into(),
            used_percent: None,
            remaining_percent: None,
            resets_at: None,
            window_seconds: None,
        };
        let w4 = UsageWindow {
            id: "thirty_day".into(),
            label: "Monthly Limit".into(),
            used_percent: None,
            remaining_percent: None,
            resets_at: None,
            window_seconds: None,
        };

        assert_eq!(canonical_window_id(&w1), Some("monthly"));
        assert_eq!(canonical_window_id(&w2), Some("monthly"));
        assert_eq!(canonical_window_id(&w3), Some("monthly"));
        assert_eq!(canonical_window_id(&w4), Some("monthly"));
    }

    #[test]
    fn thirty_day_alert_triggers_and_formats_label() {
        let directory = tempfile::tempdir().unwrap();
        let store = AlertStore::load(directory.path()).unwrap();
        store
            .save(
                "openai-1",
                vec![UsageAlertSetting {
                    window_id: "monthly".into(),
                    enabled: true,
                    threshold_percent: 20,
                }],
            )
            .unwrap();

        let now = now_rfc3339();
        let account = Account {
            id: "openai-1".into(),
            label: "Free ChatGPT".into(),
            provider: Provider::Openai,
            email: None,
            provider_account_id: None,
            chatgpt_account_id: None,
            plan: None,
            created_at: now.clone(),
            updated_at: now.clone(),
            last_usage: Some(UsageSnapshot {
                plan: None,
                email: None,
                windows: vec![UsageWindow {
                    id: "monthly".into(),
                    label: "GPT · 30-Day Limit".into(),
                    used_percent: Some(85.0),
                    remaining_percent: Some(15.0),
                    resets_at: Some("2026-10-01T00:00:00Z".into()),
                    window_seconds: Some(2_592_000),
                }],
                credits_usd: None,
                unlimited_credits: false,
                fetched_at: now,
                freshness: UsageFreshness::Live,
                source: "wham".into(),
            }),
            last_error: None,
            auth_required: false,
        };

        let alerts = store.evaluate(&account).unwrap();
        assert_eq!(alerts.len(), 1);
        assert_eq!(alerts[0].window_label, "30-day (GPT)");
        assert_eq!(alerts[0].remaining_percent, 15);
        assert_eq!(alerts[0].threshold_percent, 20);

        // Deduplication
        assert!(store.evaluate(&account).unwrap().is_empty());
    }
}

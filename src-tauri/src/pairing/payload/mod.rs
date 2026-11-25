//! The accounts payload two devices exchange: its shape and limits here, building it in
//! `export`, and checking and applying a received one in `import`.

mod export;
mod import;

pub use export::create_export_payload;
pub use import::import_sync_payload;
pub(crate) use import::validate_payload;

use crate::{
    limits::{
        clamp_chars, MAX_SIDEBAR_WIDTH, MAX_UI_LIST_ENTRIES, MAX_UI_PAGES, MAX_UI_TEXT_CHARS,
    },
    model::{Account, AccountBucket, ProviderSecret},
};
use serde::{Deserialize, Serialize};

pub const PAYLOAD_FORMAT: &str = "ai-usage-tracker-pairing-v1";
pub const MAX_ACCOUNTS: usize = 64;
pub const MAX_SECRET_BYTES: usize = 256 * 1024; // 256 KB

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SyncAccountEntry {
    pub account: Account,
    pub secret: ProviderSecret,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AppSettingsSyncPayload {
    pub account_refresh_minutes: u64,
    pub automatic_updates_enabled: bool,
    #[serde(default)]
    pub include_beta_updates: bool,
    pub autostart_enabled: bool,
    pub paseo_bridge_enabled: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AccountOrderSyncPayload {
    pub account_ids: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AlertSyncEntry {
    pub account_id: String,
    pub settings: Vec<crate::store::alerts::UsageAlertSetting>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct UiStateSyncPayload {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sidebar_group_order: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_order: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sidebar_window: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub collapsed_account_ids: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub collapsed_cards: Option<std::collections::BTreeMap<String, Vec<String>>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub page_account_order: Option<std::collections::BTreeMap<String, Vec<String>>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sidebar_width: Option<u32>,
    /// Appearance theme ("dark" | "oled" | "light" | "system"). Older peers ignore it,
    /// and peers from before "oled" drop that value (their allowlist below lacks it).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub theme: Option<String>,
    /// Theme accent color as lowercase `#rrggbb`. Older peers ignore it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accent_color: Option<String>,
    /// Whether usage percentages show the quota left or used ("left" | "used"). Older peers ignore it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage_display_mode: Option<String>,
    /// Whether the phone's bottom bar shows page names ("on" | "off"). Older peers ignore it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bottom_nav_labels: Option<String>,
}

impl UiStateSyncPayload {
    /// Bounds what a peer (or the local frontend) can hand over: list lengths,
    /// text lengths, and the number of pages. Ordinary UI state is far below
    /// these limits, so nothing legitimate is cut.
    pub fn clamp(&mut self) {
        fn clamp_list(list: &mut Vec<String>) {
            list.truncate(MAX_UI_LIST_ENTRIES);
            list.iter_mut()
                .for_each(|entry| clamp_chars(entry, MAX_UI_TEXT_CHARS));
        }
        fn clamp_pages(pages: &mut std::collections::BTreeMap<String, Vec<String>>) {
            let mut clamped = std::collections::BTreeMap::new();
            for (mut page, mut ids) in std::mem::take(pages) {
                if clamped.len() >= MAX_UI_PAGES {
                    break;
                }
                clamp_chars(&mut page, MAX_UI_TEXT_CHARS);
                clamp_list(&mut ids);
                clamped.insert(page, ids);
            }
            *pages = clamped;
        }
        if let Some(list) = self.sidebar_group_order.as_mut() {
            clamp_list(list);
        }
        if let Some(list) = self.provider_order.as_mut() {
            clamp_list(list);
        }
        if let Some(list) = self.collapsed_account_ids.as_mut() {
            clamp_list(list);
        }
        if let Some(window) = self.sidebar_window.as_mut() {
            clamp_chars(window, MAX_UI_TEXT_CHARS);
        }
        if let Some(pages) = self.collapsed_cards.as_mut() {
            clamp_pages(pages);
        }
        if let Some(pages) = self.page_account_order.as_mut() {
            clamp_pages(pages);
        }
        if let Some(width) = self.sidebar_width.as_mut() {
            *width = (*width).min(MAX_SIDEBAR_WIDTH);
        }
        // Theme is an allowlist, not free text: anything else is dropped.
        if self
            .theme
            .as_deref()
            .is_some_and(|theme| !matches!(theme, "dark" | "oled" | "light" | "system"))
        {
            self.theme = None;
        }
        // Accent color must be a strict `#rrggbb` hex value; normalized to lowercase.
        if let Some(color) = self.accent_color.as_deref() {
            if crate::platform::tray::parse_hex_rgb(color).is_some() {
                self.accent_color = Some(color.to_ascii_lowercase());
            } else {
                self.accent_color = None;
            }
        }
        // Same for the usage display mode.
        if self
            .usage_display_mode
            .as_deref()
            .is_some_and(|mode| !matches!(mode, "left" | "used"))
        {
            self.usage_display_mode = None;
        }
        // Same for the bottom-bar labels. Anything else is dropped, and a missing
        // field stays missing so an older sender does not reset the receiver.
        if self
            .bottom_nav_labels
            .as_deref()
            .is_some_and(|labels| !matches!(labels, "on" | "off"))
        {
            self.bottom_nav_labels = None;
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SyncPayload {
    pub format: String,
    pub exported_at: String,
    pub accounts: Vec<SyncAccountEntry>,
    pub buckets: Vec<AccountBucket>,
    /// Ids of accounts deleted on the sender since the last sync. Older peers
    /// will not send this field; receivers that do not understand it ignore it.
    #[serde(default)]
    pub deleted_account_ids: Vec<String>,
    /// Optional app settings sync (per-transfer opt-in). Older peers ignore.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub settings: Option<AppSettingsSyncPayload>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_order: Option<AccountOrderSyncPayload>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alerts: Option<Vec<AlertSyncEntry>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ui_state: Option<UiStateSyncPayload>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct SyncSummary {
    pub added: u16,
    pub updated: u16,
    pub skipped: u16,
    /// Short, fixed sentences about parts of the transfer that could not be saved on this
    /// device (never payload contents). Only the importing device fills this in; the
    /// sender's summary comes from the 6-byte acknowledgement and has none.
    #[serde(default)]
    pub warnings: Vec<String>,
}

impl SyncSummary {
    /// Notes a failed save: logs `log` and keeps `warning` for the user, once per sentence.
    /// Both are fixed text, because the error behind them can carry what the peer sent.
    fn warn(&mut self, log: &str, warning: &str) {
        crate::diagnostics::warn(log);
        if !self.warnings.iter().any(|existing| existing == warning) {
            self.warnings.push(warning.to_string());
        }
    }
}

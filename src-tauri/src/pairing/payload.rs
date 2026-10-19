use crate::{
    limits::{
        clamp_chars, sanitize_imported_account, MAX_BUCKETS, MAX_SIDEBAR_WIDTH,
        MAX_UI_LIST_ENTRIES, MAX_UI_PAGES, MAX_UI_TEXT_CHARS,
    },
    model::{Account, AccountBucket, ProviderSecret},
    state::AppState,
    store::load_provider_secret,
};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

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
    pub settings: Vec<crate::alerts::UsageAlertSetting>,
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
    /// Appearance theme ("dark" | "light" | "system"). Older peers ignore it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub theme: Option<String>,
    /// Whether usage percentages show the quota left or used ("left" | "used"). Older peers ignore it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage_display_mode: Option<String>,
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
            .is_some_and(|theme| !matches!(theme, "dark" | "light" | "system"))
        {
            self.theme = None;
        }
        // Same for the usage display mode.
        if self
            .usage_display_mode
            .as_deref()
            .is_some_and(|mode| !matches!(mode, "left" | "used"))
        {
            self.usage_display_mode = None;
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

fn remap_ui_page_id(
    page: &str,
    bucket_id_map: &std::collections::HashMap<String, String>,
) -> String {
    if let Some(bucket_id) = page.strip_prefix("bucket:") {
        if let Some(mapped) = bucket_id_map.get(bucket_id) {
            return format!("bucket:{mapped}");
        }
    }
    page.to_string()
}

pub fn create_export_payload(state: &AppState) -> Result<Vec<u8>, String> {
    let accounts = state.store.list();
    if accounts.len() > MAX_ACCOUNTS {
        return Err(format!(
            "Account count {} exceeds maximum allowed {}",
            accounts.len(),
            MAX_ACCOUNTS
        ));
    }

    let mut entries = Vec::with_capacity(accounts.len());
    for account in accounts {
        match load_provider_secret(&account.id) {
            Ok(secret) => {
                entries.push(SyncAccountEntry { account, secret });
            }
            Err(e) => {
                // If an individual account has no stored secret, skip it cleanly
                crate::diagnostics::warn(&format!(
                    "Warning: skipping account without secret during pairing: {e}"
                ));
            }
        }
    }

    let buckets = state.buckets.list();

    let (include_settings, pending_ui_state) = {
        let options = state.pairing_options.read();
        (options.include_settings, options.pending_ui_state.clone())
    };

    let (settings, account_order, alerts, ui_state) = if include_settings {
        let app = state.settings.get();
        let settings_payload = AppSettingsSyncPayload {
            account_refresh_minutes: app.account_refresh_minutes,
            automatic_updates_enabled: app.automatic_updates_enabled,
            include_beta_updates: app.include_beta_updates,
            autostart_enabled: app.autostart_enabled,
            paseo_bridge_enabled: app.paseo_bridge_enabled,
        };

        // Account order: snapshot of current ordered ids (only ids that still exist)
        let raw_order = state.account_order.snapshot_ids();
        let account_order_payload = if raw_order.is_empty() {
            None
        } else {
            Some(AccountOrderSyncPayload {
                account_ids: raw_order,
            })
        };

        // Alerts: export all non-empty per-account settings
        let exported = state.alerts.export_all();
        let alerts_payload = if exported.is_empty() {
            None
        } else {
            Some(
                exported
                    .into_iter()
                    .map(|(account_id, settings)| AlertSyncEntry {
                        account_id,
                        settings,
                    })
                    .collect(),
            )
        };

        // UI state: pending value supplied by frontend (localStorage snapshot)
        let ui_state_payload = pending_ui_state
            .and_then(|value| serde_json::from_value::<UiStateSyncPayload>(value).ok())
            .filter(|ui| {
                ui.sidebar_group_order.is_some()
                    || ui.provider_order.is_some()
                    || ui.sidebar_window.is_some()
                    || ui.collapsed_account_ids.is_some()
                    || ui.collapsed_cards.is_some()
                    || ui.page_account_order.is_some()
                    || ui.sidebar_width.is_some()
                    || ui.theme.is_some()
                    || ui.usage_display_mode.is_some()
            });

        (
            Some(settings_payload),
            account_order_payload,
            alerts_payload,
            ui_state_payload,
        )
    } else {
        (None, None, None, None)
    };

    let payload = SyncPayload {
        format: PAYLOAD_FORMAT.to_string(),
        exported_at: Utc::now().to_rfc3339(),
        accounts: entries,
        buckets,
        deleted_account_ids: Vec::new(),
        settings,
        account_order,
        alerts,
        ui_state,
    };

    let serialized = serde_json::to_vec(&payload)
        .map_err(|e| format!("Failed to serialize sync payload: {e}"))?;

    Ok(serialized)
}

/// Imports a payload received from the paired device and says what happened.
///
/// Pairing never replaces credentials: an account this device already has keeps its local
/// secret and metadata (it is counted as skipped, and the sender's layout is mapped onto it). A
/// transfer therefore cannot overwrite a sign-in, however the other device is set up.
pub async fn import_sync_payload(
    state: &Arc<AppState>,
    payload_bytes: &[u8],
) -> Result<SyncSummary, String> {
    let mut payload = validate_payload(payload_bytes)?;
    let mut summary = SyncSummary::default();
    let planned = plan_account_ids(std::mem::take(&mut payload.accounts), &mut summary)?;
    apply_import(state, planned, payload, summary).await
}

/// The payload as sent, once its shape is accepted: JSON of the expected format, within the
/// account limit. Nothing is read from the device's own state here.
fn validate_payload(payload_bytes: &[u8]) -> Result<SyncPayload, String> {
    let payload: SyncPayload = serde_json::from_slice(payload_bytes)
        .map_err(|e| format!("Invalid sync payload JSON: {e}"))?;

    if payload.format != PAYLOAD_FORMAT {
        return Err(format!(
            "Unsupported payload format '{}'. Expected '{}'",
            payload.format, PAYLOAD_FORMAT
        ));
    }

    if payload.accounts.len() > MAX_ACCOUNTS {
        return Err(format!(
            "Payload accounts count {} exceeds limit {}",
            payload.accounts.len(),
            MAX_ACCOUNTS
        ));
    }
    Ok(payload)
}

/// An incoming account with the id this device will use for it.
struct PlannedAccount {
    /// The id the sender used, which buckets, ordering and layout refer to.
    sender_id: String,
    entry: SyncAccountEntry,
}

/// Decides which incoming accounts are acceptable and what id each gets on this device. An
/// account whose secret is larger than `MAX_SECRET_BYTES` is dropped (counted as skipped). Whether
/// an account already exists here is decided later, one account at a time, so that two entries
/// for the same account in one payload collapse into one.
fn plan_account_ids(
    accounts: Vec<SyncAccountEntry>,
    summary: &mut SyncSummary,
) -> Result<Vec<PlannedAccount>, String> {
    let mut planned = Vec::with_capacity(accounts.len());
    for mut entry in accounts {
        let sender_id = entry.account.id.clone();
        // The sender's id becomes a credential file/keychain name here, so an
        // id that is not a plain token (e.g. `../accounts`) is never used
        // as-is. Mint a local id; `id_map` still maps the sender's id for
        // buckets and ordering.
        if !crate::store::is_valid_account_id(&entry.account.id) {
            entry.account.id = uuid::Uuid::new_v4().to_string();
        }
        sanitize_imported_account(&mut entry.account);

        // Enforce per-secret serialized size limit
        let secret_bytes = serde_json::to_vec(&entry.secret)
            .map_err(|e| format!("Failed to serialize secret for size check: {e}"))?;
        if secret_bytes.len() > MAX_SECRET_BYTES {
            summary.skipped += 1;
            continue;
        }

        planned.push(PlannedAccount { sender_id, entry });
    }
    Ok(planned)
}

/// Saves the planned accounts, then the groups, settings, order, alerts and layout that refer to
/// them. A part that cannot be saved is reported in the summary's warnings; the transfer goes on.
async fn apply_import(
    state: &Arc<AppState>,
    planned: Vec<PlannedAccount>,
    payload: SyncPayload,
    mut summary: SyncSummary,
) -> Result<SyncSummary, String> {
    let mut id_map: std::collections::HashMap<String, String> = std::collections::HashMap::new();

    // Transfers only add or update accounts on the receiver. Deletions on
    // the sender are not applied here, so existing accounts on this device
    // stay until the user removes them.

    for PlannedAccount { sender_id, entry } in planned {
        let existing = state
            .store
            .find_duplicate(
                &entry.account.provider,
                entry.account.effective_account_id(),
                entry.account.email.as_deref(),
            )
            .or_else(|| state.store.get(&sender_id));

        if let Some(existing_acc) = existing {
            let receiver_id = existing_acc.id;
            id_map.insert(sender_id, receiver_id.clone());
            // Keep the local credentials, but map the ids so groups and ordering remap onto the
            // account already here.
            state.store.clear_tombstone(&receiver_id);
            summary.skipped += 1;
        } else {
            // New account
            match state
                .persist_connected_account(entry.account, &entry.secret)
                .await
            {
                Ok(saved) => {
                    state.store.clear_tombstone(&saved.id);
                    // Also clear sender id in case it differs (id remapped)
                    state.store.clear_tombstone(&sender_id);
                    id_map.insert(sender_id, saved.id);
                    summary.added += 1;
                }
                Err(e) => {
                    crate::diagnostics::warn(&format!("Failed to persist new account: {e}"));
                    summary.skipped += 1;
                }
            }
        }
    }

    // Import buckets if present with remapped account IDs and build bucket id map
    let mut bucket_id_map: std::collections::HashMap<String, String> =
        std::collections::HashMap::new();
    for mut incoming_bucket in payload.buckets.into_iter().take(MAX_BUCKETS) {
        let sender_bucket_id = incoming_bucket.id.clone();
        // Bucket ids end up in stored data and UI page keys; keep them plain.
        if !crate::store::is_valid_account_id(&incoming_bucket.id) {
            incoming_bucket.id = format!("bucket_{}", uuid::Uuid::new_v4().simple());
        }
        let mut mapped_ids: Vec<String> = Vec::new();
        for sid in incoming_bucket
            .account_ids
            .iter()
            .take(MAX_ACCOUNTS)
            .cloned()
        {
            let target_id = id_map.get(&sid).cloned().unwrap_or(sid);
            if state.store.get(&target_id).is_some() && !mapped_ids.contains(&target_id) {
                mapped_ids.push(target_id);
            }
        }
        incoming_bucket.account_ids = mapped_ids;
        // Determine if this bucket will merge into an existing one by name+provider
        let before = state.buckets.list();
        let existing_match = before.iter().find(|b| {
            b.id == incoming_bucket.id
                || (b
                    .name
                    .trim()
                    .eq_ignore_ascii_case(incoming_bucket.name.trim())
                    && b.provider == incoming_bucket.provider)
        });
        let expected_receiver_id = existing_match
            .map(|b| b.id.clone())
            .unwrap_or_else(|| incoming_bucket.id.clone());
        // Only a saved group can be the target of the sender's layout (page ids, group order).
        match state.buckets.upsert_imported(incoming_bucket) {
            Ok(()) => {
                bucket_id_map.insert(sender_bucket_id, expected_receiver_id);
            }
            Err(_) => summary.warn(
                "Pairing import: an account group could not be saved.",
                "Some account groups couldn't be saved.",
            ),
        }
    }

    // Apply optional settings if present (opt-in per transfer)
    if let Some(settings) = payload.settings {
        let mut settings_failed = false;
        if let Some(minutes) =
            crate::settings::snap_refresh_minutes(settings.account_refresh_minutes)
        {
            settings_failed |= state.settings.set_account_refresh_minutes(minutes).is_err();
        }
        settings_failed |= state
            .settings
            .set_automatic_updates_enabled(settings.automatic_updates_enabled)
            .is_err();
        settings_failed |= state
            .settings
            .set_include_beta_updates(settings.include_beta_updates)
            .is_err();
        settings_failed |= state
            .settings
            .set_autostart_enabled(settings.autostart_enabled)
            .is_err();
        // The local API only exists on desktop; a phone must not carry the flag.
        #[cfg(desktop)]
        {
            settings_failed |= state
                .settings
                .set_paseo_bridge_enabled(settings.paseo_bridge_enabled)
                .is_err();
        }
        if settings_failed {
            summary.warn(
                "Pairing import: some settings could not be saved.",
                "Some settings couldn't be applied.",
            );
        }
        // Try to apply system autostart when possible
        if let Some(handle) = state.app_handle.read().clone() {
            #[cfg(desktop)]
            {
                use tauri_plugin_autostart::ManagerExt;
                let result = if settings.autostart_enabled {
                    handle.autolaunch().enable()
                } else {
                    handle.autolaunch().disable()
                };
                if result.is_err() {
                    summary.warn(
                        "Pairing import: the start-at-login setting could not be applied.",
                        "Start at login couldn't be updated.",
                    );
                }
            }
            #[cfg(not(desktop))]
            {
                let _ = handle;
            }
        }
    }

    // Apply optional account order if present
    if let Some(order) = payload.account_order {
        // Remap sender ids -> receiver ids
        let mut remapped: Vec<String> = Vec::new();
        for sid in order.account_ids.into_iter().take(MAX_ACCOUNTS) {
            let rid = id_map.get(&sid).cloned().unwrap_or(sid);
            if state.store.get(&rid).is_some() && !remapped.contains(&rid) {
                remapped.push(rid);
            }
        }
        if !remapped.is_empty() {
            // Merge with receiver-only accounts that sender didn't have
            let all_accounts = state.store.list();
            let ordered_accounts = state
                .account_order
                .apply(all_accounts.clone())
                .unwrap_or(all_accounts);
            let ordered_ids: Vec<String> = ordered_accounts.iter().map(|a| a.id.clone()).collect();
            for rid in ordered_ids {
                if !remapped.contains(&rid) {
                    remapped.push(rid);
                }
            }
            // Only save if length matches
            if remapped.len() == state.store.list().len()
                && state
                    .account_order
                    .save(remapped, state.store.list())
                    .is_err()
            {
                summary.warn(
                    "Pairing import: the account order could not be saved.",
                    "The account order couldn't be saved.",
                );
            }
        }
    }

    // Apply optional alerts if present
    if let Some(alert_entries) = payload.alerts {
        for entry in alert_entries.into_iter().take(MAX_ACCOUNTS) {
            let target_id = id_map
                .get(&entry.account_id)
                .cloned()
                .unwrap_or(entry.account_id);
            if state.store.get(&target_id).is_some()
                && state.alerts.save(&target_id, entry.settings).is_err()
            {
                summary.warn(
                    "Pairing import: usage alerts could not be saved.",
                    "Some usage alerts couldn't be saved.",
                );
            }
        }
    }

    // Emit optional UI state to frontend for localStorage sync
    if let Some(ui_state) = payload.ui_state {
        // Remap collapsed ids and bucket refs in group order
        let mut remapped_ui = ui_state;
        remapped_ui.clamp();
        if let Some(ids) = remapped_ui.collapsed_account_ids.take() {
            let mapped: Vec<String> = ids
                .into_iter()
                .map(|sid| id_map.get(&sid).cloned().unwrap_or(sid))
                .filter(|rid| state.store.get(rid).is_some())
                .collect();
            if !mapped.is_empty() {
                remapped_ui.collapsed_account_ids = Some(mapped);
            }
        }
        if let Some(cards) = remapped_ui.collapsed_cards.take() {
            let mut mapped = std::collections::BTreeMap::new();
            for (page, ids) in cards {
                let page = remap_ui_page_id(&page, &bucket_id_map);
                let mapped_ids: Vec<String> = ids
                    .into_iter()
                    .map(|sid| id_map.get(&sid).cloned().unwrap_or(sid))
                    .filter(|rid| state.store.get(rid).is_some())
                    .collect();
                if !mapped_ids.is_empty() {
                    mapped.insert(page, mapped_ids);
                }
            }
            if !mapped.is_empty() {
                remapped_ui.collapsed_cards = Some(mapped);
            }
        }
        if let Some(orders) = remapped_ui.page_account_order.take() {
            let mut mapped = std::collections::BTreeMap::new();
            for (page, ids) in orders {
                let page = remap_ui_page_id(&page, &bucket_id_map);
                let mapped_ids: Vec<String> = ids
                    .into_iter()
                    .map(|sid| id_map.get(&sid).cloned().unwrap_or(sid))
                    .filter(|rid| state.store.get(rid).is_some())
                    .collect();
                if !mapped_ids.is_empty() {
                    mapped.insert(page, mapped_ids);
                }
            }
            if !mapped.is_empty() {
                remapped_ui.page_account_order = Some(mapped);
            }
        }
        if let Some(order) = remapped_ui.sidebar_group_order.take() {
            let mapped_order: Vec<String> = order
                .into_iter()
                .map(|entry| {
                    if let Some(bucket_id) = entry.strip_prefix("bucket:") {
                        if let Some(mapped) = bucket_id_map.get(bucket_id) {
                            format!("bucket:{}", mapped)
                        } else {
                            entry
                        }
                    } else {
                        entry
                    }
                })
                .collect();
            remapped_ui.sidebar_group_order = Some(mapped_order);
        }
        if let Some(handle) = state.app_handle.read().clone() {
            use tauri::Emitter;
            let _ = handle.emit("pairing-ui-state", remapped_ui);
        }
    }

    state.wakeup_refresh();

    Ok(summary)
}

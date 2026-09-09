use crate::{
    model::{Account, AccountBucket, ProviderSecret},
    state::AppState,
    store::load_provider_secret,
};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::{collections::HashSet, sync::Arc};

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
}

fn remap_ui_page_id(page: &str, bucket_id_map: &std::collections::HashMap<String, String>) -> String {
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
                // If an individual account has no secret in keychain, skip it cleanly
                eprintln!("Warning: skipping account without secret during pairing: {e}");
            }
        }
    }

    let buckets = state.buckets.list();

    // Prune tombstones that are still live on this device before exporting
    // to avoid poisoning the receiver (wipe-fix for upgrade path).
    let live_ids: std::collections::HashSet<String> =
        state.store.list().iter().map(|a| a.id.clone()).collect();
    let tombstones = state
        .store
        .tombstones()
        .into_iter()
        .filter(|id| !live_ids.contains(id))
        .collect::<Vec<String>>();

    let include_settings = *state.pairing_include_settings.read();

    let (settings, account_order, alerts, ui_state) = if include_settings {
        let app = state.settings.get();
        let settings_payload = AppSettingsSyncPayload {
            account_refresh_minutes: app.account_refresh_minutes,
            automatic_updates_enabled: app.automatic_updates_enabled,
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
        let ui_state_payload = state
            .pairing_pending_ui_state
            .read()
            .clone()
            .and_then(|value| serde_json::from_value::<UiStateSyncPayload>(value).ok())
            .filter(|ui| {
                ui.sidebar_group_order.is_some()
                    || ui.provider_order.is_some()
                    || ui.sidebar_window.is_some()
                    || ui.collapsed_account_ids.is_some()
                    || ui.collapsed_cards.is_some()
                    || ui.page_account_order.is_some()
                    || ui.sidebar_width.is_some()
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
        deleted_account_ids: tombstones,
        settings,
        account_order,
        alerts,
        ui_state,
    };

    let serialized = serde_json::to_vec(&payload)
        .map_err(|e| format!("Failed to serialize sync payload: {e}"))?;

    Ok(serialized)
}

pub async fn import_sync_payload(
    state: &Arc<AppState>,
    payload_bytes: &[u8],
) -> Result<SyncSummary, String> {
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

    let mut summary = SyncSummary::default();
    let mut id_map: std::collections::HashMap<String, String> = std::collections::HashMap::new();

    // Apply deletions from the peer: remove accounts the sender deleted so
    // they don't linger as ghosts, then remember the ids locally so a later
    // re-transfer of this payload (or any peer still holding the account)
    // cannot resurrect them. Filter out live ids to avoid poisoning
    // the receiver when sender's tombstones incorrectly contain live ids
    // (wipe-fix for upgrade path).
    let incoming: HashSet<String> = payload
        .accounts
        .iter()
        .map(|e| e.account.id.clone())
        .collect();
    let filtered_deleted: Vec<String> = payload
        .deleted_account_ids
        .into_iter()
        .filter(|id| !incoming.contains(id))
        .collect();
    let pre_tombstones = state.store.tombstones();
    state.store.merge_tombstones(&filtered_deleted);
    for deleted_id in &filtered_deleted {
        if state.store.get(deleted_id).is_some() {
            // store::remove deletes the credential, drops the metadata, and
            // records the tombstone locally.
            let _ = state.store.remove(deleted_id);
            let _ = state.buckets.cleanup_account(deleted_id);
        }
    }

    for entry in payload.accounts {
        let sender_id = entry.account.id.clone();

        // Never re-add an account that was explicitly deleted on this device
        // (pre-transfer snapshot only - do not use post-merge poisoned set).
        if pre_tombstones.iter().any(|t| t == &sender_id)
            || filtered_deleted.iter().any(|t| t == &sender_id)
        {
            summary.skipped += 1;
            continue;
        }

        // Enforce per-secret serialized size limit
        let secret_bytes = serde_json::to_vec(&entry.secret)
            .map_err(|e| format!("Failed to serialize secret for size check: {e}"))?;
        if secret_bytes.len() > MAX_SECRET_BYTES {
            summary.skipped += 1;
            continue;
        }

        let existing = state
            .store
            .find_duplicate(
                &entry.account.provider,
                entry.account.effective_account_id(),
                entry.account.email.as_deref(),
            )
            .or_else(|| state.store.get(&sender_id));

        if let Some(mut existing_acc) = existing {
            let receiver_id = existing_acc.id.clone();
            id_map.insert(sender_id, receiver_id.clone());

            // Merge into existing account
            let lock = state.account_lock(&receiver_id);
            let _guard = lock.lock().await;

            // Update secret in native store
            if let Err(e) = crate::store::save_provider_secret(&receiver_id, &entry.secret) {
                eprintln!("Failed to save updated secret for account: {e}");
                summary.skipped += 1;
                continue;
            }

            // Update metadata
            existing_acc.label = entry.account.label;
            if entry.account.plan.is_some() {
                existing_acc.plan = entry.account.plan;
            }
            existing_acc.touch();

            if let Err(e) = state.store.upsert(existing_acc) {
                eprintln!("Failed to update account metadata: {e}");
                summary.skipped += 1;
                continue;
            }

            let _ = state.store.clear_tombstone(&receiver_id);
            summary.updated += 1;
        } else {
            // New account
            match state
                .persist_connected_account(entry.account, &entry.secret)
                .await
            {
                Ok(saved) => {
                    let _ = state.store.clear_tombstone(&saved.id);
                    // Also clear sender id in case it differs (id remapped)
                    let _ = state.store.clear_tombstone(&sender_id);
                    id_map.insert(sender_id, saved.id);
                    summary.added += 1;
                }
                Err(e) => {
                    eprintln!("Failed to persist new account: {e}");
                    summary.skipped += 1;
                }
            }
        }
    }

    // Import buckets if present with remapped account IDs and build bucket id map
    let mut bucket_id_map: std::collections::HashMap<String, String> =
        std::collections::HashMap::new();
    for mut incoming_bucket in payload.buckets {
        let sender_bucket_id = incoming_bucket.id.clone();
        let mut mapped_ids: Vec<String> = Vec::new();
        for sid in incoming_bucket.account_ids.clone() {
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
                || (b.name.trim().eq_ignore_ascii_case(incoming_bucket.name.trim())
                    && b.provider == incoming_bucket.provider)
        });
        let expected_receiver_id = existing_match
            .map(|b| b.id.clone())
            .unwrap_or_else(|| incoming_bucket.id.clone());
        let _ = state.buckets.upsert_imported(incoming_bucket);
        if let Some(existing) = existing_match {
            bucket_id_map.insert(sender_bucket_id, existing.id.clone());
        } else {
            bucket_id_map.insert(sender_bucket_id.clone(), expected_receiver_id);
        }
    }

    // Apply optional settings if present (opt-in per transfer)
    if let Some(settings) = payload.settings {
        let _ = state
            .settings
            .set_account_refresh_minutes(settings.account_refresh_minutes);
        let _ = state
            .settings
            .set_automatic_updates_enabled(settings.automatic_updates_enabled);
        let _ = state.settings.set_autostart_enabled(settings.autostart_enabled);
        let _ = state
            .settings
            .set_paseo_bridge_enabled(settings.paseo_bridge_enabled);
        // Try to apply system autostart when possible
        if let Some(handle) = state.app_handle.read().clone() {
            #[cfg(desktop)]
            {
                use tauri_plugin_autostart::ManagerExt;
                let _ = if settings.autostart_enabled {
                    handle.autolaunch().enable()
                } else {
                    handle.autolaunch().disable()
                };
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
        for sid in order.account_ids {
            let rid = id_map.get(&sid).cloned().unwrap_or(sid);
            if state.store.get(&rid).is_some() && !remapped.contains(&rid) {
                remapped.push(rid);
            }
        }
        if !remapped.is_empty() {
            // Merge with receiver-only accounts that sender didn't have
            let all_accounts = state.store.list();
            let ordered_accounts = state.account_order.apply(all_accounts.clone()).unwrap_or(all_accounts);
            let ordered_ids: Vec<String> = ordered_accounts.iter().map(|a| a.id.clone()).collect();
            for rid in ordered_ids {
                if !remapped.contains(&rid) {
                    remapped.push(rid);
                }
            }
            // Only save if length matches
            if remapped.len() == state.store.list().len() {
                let _ = state.account_order.save(remapped, state.store.list());
            }
        }
    }

    // Apply optional alerts if present
    if let Some(alert_entries) = payload.alerts {
        for entry in alert_entries {
            let target_id = id_map
                .get(&entry.account_id)
                .cloned()
                .unwrap_or(entry.account_id);
            if state.store.get(&target_id).is_some() {
                let _ = state.alerts.save(&target_id, entry.settings);
            }
        }
    }

    // Emit optional UI state to frontend for localStorage sync
    if let Some(ui_state) = payload.ui_state {
        // Remap collapsed ids and bucket refs in group order
        let mut remapped_ui = ui_state;
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

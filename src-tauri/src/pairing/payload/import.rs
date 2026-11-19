//! Checking a received payload and adding what it holds to this device.

use super::{
    AccountOrderSyncPayload, AlertSyncEntry, AppSettingsSyncPayload, SyncAccountEntry, SyncPayload,
    SyncSummary, UiStateSyncPayload, MAX_ACCOUNTS, MAX_SECRET_BYTES, PAYLOAD_FORMAT,
};
use crate::{
    limits::{sanitize_imported_account, MAX_BUCKETS},
    model::AccountBucket,
    state::AppState,
};
use std::sync::Arc;

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

/// Imports a payload received from the paired device and says what happened.
///
/// Pairing never replaces credentials: an account this device already has keeps its local
/// secret and metadata (it is counted as skipped, and the sender's layout is mapped onto it). A
/// transfer therefore cannot overwrite a sign-in, however the other device is set up.
///
/// `accept_settings` is the receiving user's own choice ("Also Transfer Settings & Layout" on this
/// device). Without it the sender's app settings, account order, alerts and layout are dropped,
/// whatever the sender chose to include: a sender cannot change this device's settings alone.
pub async fn import_sync_payload(
    state: &Arc<AppState>,
    payload_bytes: &[u8],
    accept_settings: bool,
) -> Result<SyncSummary, String> {
    let mut payload = validate_payload(payload_bytes)?;
    if !accept_settings {
        payload.settings = None;
        payload.account_order = None;
        payload.alerts = None;
        payload.ui_state = None;
    }
    let mut summary = SyncSummary::default();
    let planned = plan_account_ids(std::mem::take(&mut payload.accounts), &mut summary)?;
    // One import at a time: each checks which accounts this device already has
    // and then saves the rest, and that check must still hold when it saves.
    let _import = state.import_lock.lock().await;
    apply_import(state, planned, payload, summary).await
}

/// The payload as sent, once its shape is accepted: JSON of the expected format, within the
/// account limit. Nothing is read from the device's own state here.
pub(crate) fn validate_payload(payload_bytes: &[u8]) -> Result<SyncPayload, String> {
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
        // The sender may still hold text this version rewrote at its own start.
        usage_core::legacy::normalize_account(&mut entry.account);

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

/// Sender id to the id the same thing has on this device.
type IdMap = std::collections::HashMap<String, String>;

/// Saves the planned accounts, then the groups, settings, order, alerts and layout that refer to
/// them. A part that cannot be saved is reported in the summary's warnings; the transfer goes on.
async fn apply_import(
    state: &Arc<AppState>,
    planned: Vec<PlannedAccount>,
    payload: SyncPayload,
    mut summary: SyncSummary,
) -> Result<SyncSummary, String> {
    // Transfers only add or update accounts on the receiver. Deletions on
    // the sender are not applied here, so existing accounts on this device
    // stay until the user removes them.
    let id_map = import_accounts(state, planned, &mut summary).await;
    let bucket_id_map = import_buckets(state, payload.buckets, &id_map, &mut summary);

    // Apply optional settings if present (opt-in per transfer)
    if let Some(settings) = payload.settings {
        apply_settings(state, &settings, &mut summary);
    }
    if let Some(order) = payload.account_order {
        apply_account_order(state, order, &id_map, &mut summary);
    }
    if let Some(alert_entries) = payload.alerts {
        apply_alerts(state, alert_entries, &id_map, &mut summary);
    }
    if let Some(ui_state) = payload.ui_state {
        emit_ui_state(state, ui_state, &id_map, &bucket_id_map);
    }

    state.wakeup_refresh();

    Ok(summary)
}

/// Saves each planned account that is not already on this device, and returns the sender's id
/// for every account mapped to the id it has here.
async fn import_accounts(
    state: &Arc<AppState>,
    planned: Vec<PlannedAccount>,
    summary: &mut SyncSummary,
) -> IdMap {
    let mut id_map = IdMap::new();
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
    id_map
}

/// Saves the sender's account groups with their account ids remapped, and returns the sender's
/// group id for every saved group mapped to the id it has here.
fn import_buckets(
    state: &Arc<AppState>,
    buckets: Vec<AccountBucket>,
    id_map: &IdMap,
    summary: &mut SyncSummary,
) -> IdMap {
    let mut bucket_id_map = IdMap::new();
    for mut incoming_bucket in buckets.into_iter().take(MAX_BUCKETS) {
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
    bucket_id_map
}

/// Saves the sender's app settings, then asks the system to follow the start-at-login choice.
fn apply_settings(
    state: &Arc<AppState>,
    settings: &AppSettingsSyncPayload,
    summary: &mut SyncSummary,
) {
    let mut settings_failed = false;
    if let Some(minutes) =
        crate::store::settings::snap_refresh_minutes(settings.account_refresh_minutes)
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

/// Saves the sender's account order, with the accounts only this device has kept after it.
fn apply_account_order(
    state: &Arc<AppState>,
    order: AccountOrderSyncPayload,
    id_map: &IdMap,
    summary: &mut SyncSummary,
) {
    // Remap sender ids -> receiver ids
    let mut remapped: Vec<String> = Vec::new();
    for sid in order.account_ids.into_iter().take(MAX_ACCOUNTS) {
        let rid = id_map.get(&sid).cloned().unwrap_or(sid);
        if state.store.get(&rid).is_some() && !remapped.contains(&rid) {
            remapped.push(rid);
        }
    }
    if remapped.is_empty() {
        return;
    }
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

/// Saves the sender's usage alerts for the accounts that exist on this device.
fn apply_alerts(
    state: &Arc<AppState>,
    alert_entries: Vec<AlertSyncEntry>,
    id_map: &IdMap,
    summary: &mut SyncSummary,
) {
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

/// The sender's account ids as this device knows them, without the accounts it does not have.
fn remap_account_ids(state: &Arc<AppState>, ids: Vec<String>, id_map: &IdMap) -> Vec<String> {
    ids.into_iter()
        .map(|sid| id_map.get(&sid).cloned().unwrap_or(sid))
        .filter(|rid| state.store.get(rid).is_some())
        .collect()
}

/// A per-page list of account ids with both the page ids and the account ids remapped. Pages
/// left with no account are dropped.
fn remap_ui_pages(
    state: &Arc<AppState>,
    pages: std::collections::BTreeMap<String, Vec<String>>,
    id_map: &IdMap,
    bucket_id_map: &IdMap,
) -> std::collections::BTreeMap<String, Vec<String>> {
    let mut mapped = std::collections::BTreeMap::new();
    for (page, ids) in pages {
        let page = remap_ui_page_id(&page, bucket_id_map);
        let mapped_ids = remap_account_ids(state, ids, id_map);
        if !mapped_ids.is_empty() {
            mapped.insert(page, mapped_ids);
        }
    }
    mapped
}

/// Hands the sender's layout to the frontend (which keeps it in localStorage), with account and
/// group ids remapped to this device's.
fn emit_ui_state(
    state: &Arc<AppState>,
    ui_state: UiStateSyncPayload,
    id_map: &IdMap,
    bucket_id_map: &IdMap,
) {
    let mut remapped_ui = ui_state;
    remapped_ui.clamp();
    if let Some(ids) = remapped_ui.collapsed_account_ids.take() {
        let mapped = remap_account_ids(state, ids, id_map);
        if !mapped.is_empty() {
            remapped_ui.collapsed_account_ids = Some(mapped);
        }
    }
    if let Some(cards) = remapped_ui.collapsed_cards.take() {
        let mapped = remap_ui_pages(state, cards, id_map, bucket_id_map);
        if !mapped.is_empty() {
            remapped_ui.collapsed_cards = Some(mapped);
        }
    }
    if let Some(orders) = remapped_ui.page_account_order.take() {
        let mapped = remap_ui_pages(state, orders, id_map, bucket_id_map);
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

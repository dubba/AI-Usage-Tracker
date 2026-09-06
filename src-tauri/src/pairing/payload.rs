use crate::{
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
pub struct SyncPayload {
    pub format: String,
    pub exported_at: String,
    pub accounts: Vec<SyncAccountEntry>,
    pub buckets: Vec<AccountBucket>,
    /// Ids of accounts deleted on the sender since the last sync. Older peers
    /// will not send this field; receivers that do not understand it ignore it.
    #[serde(default)]
    pub deleted_account_ids: Vec<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncSummary {
    pub added: u16,
    pub updated: u16,
    pub skipped: u16,
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

    let payload = SyncPayload {
        format: PAYLOAD_FORMAT.to_string(),
        exported_at: Utc::now().to_rfc3339(),
        accounts: entries,
        buckets,
        deleted_account_ids: state.store.tombstones(),
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
    // cannot resurrect them.
    state.store.merge_tombstones(&payload.deleted_account_ids);
    for deleted_id in &payload.deleted_account_ids {
        if state.store.get(deleted_id).is_some() {
            // store::remove deletes the credential, drops the metadata, and
            // records the tombstone locally.
            let _ = state.store.remove(deleted_id);
            let _ = state.buckets.cleanup_account(deleted_id);
        }
    }
    let tombstones = state.store.tombstones();

    for entry in payload.accounts {
        let sender_id = entry.account.id.clone();

        // Never re-add an account that was explicitly deleted on this device.
        if tombstones.iter().any(|t| t == &sender_id) {
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

            summary.updated += 1;
        } else {
            // New account
            match state
                .persist_connected_account(entry.account, &entry.secret)
                .await
            {
                Ok(saved) => {
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

    // Import buckets if present with remapped account IDs
    for mut incoming_bucket in payload.buckets {
        let mut mapped_ids: Vec<String> = Vec::new();
        for sid in incoming_bucket.account_ids {
            let target_id = id_map.get(&sid).cloned().unwrap_or(sid);
            if state.store.get(&target_id).is_some() && !mapped_ids.contains(&target_id) {
                mapped_ids.push(target_id);
            }
        }
        incoming_bucket.account_ids = mapped_ids;
        let _ = state.buckets.upsert_imported(incoming_bucket);
    }

    state.wakeup_refresh();

    Ok(summary)
}

//! Building the payload this device sends.

use super::{
    AccountOrderSyncPayload, AlertSyncEntry, AppSettingsSyncPayload, SyncAccountEntry, SyncPayload,
    UiStateSyncPayload, MAX_ACCOUNTS, PAYLOAD_FORMAT,
};
use crate::{state::AppState, store::load_provider_secret};
use chrono::Utc;

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

    let (include_settings, pending_ui_state) = state.pairing_options.read().exported_extras();

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
                    || ui.bottom_nav_labels.is_some()
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

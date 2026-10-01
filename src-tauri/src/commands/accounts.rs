use super::{bridge::bridge_status, validate_label};
use crate::{
    model::{Account, DashboardSnapshot},
    state::AppState,
    usage,
};
use std::sync::Arc;
use tauri::State;

#[tauri::command]
pub async fn get_dashboard_snapshot(
    state: State<'_, Arc<AppState>>,
) -> Result<DashboardSnapshot, String> {
    let accounts = state.account_order.apply(state.store.list())?;
    let buckets = state.buckets.list();
    Ok(DashboardSnapshot {
        accounts,
        buckets,
        bridge: bridge_status(state.inner().as_ref()),
        unprotected_credentials: retry_credential_sealing(state.inner()).await,
    })
}

/// How many saved sign-ins are still stored unencrypted. While any are, each
/// dashboard refresh tries to seal them again, so a keystore that was briefly
/// unavailable at startup fixes itself and the UI warning clears.
pub async fn retry_credential_sealing(state: &Arc<AppState>) -> usize {
    let remaining = state.unprotected_credentials();
    if remaining == 0 {
        return 0;
    }
    let report = tauri::async_runtime::spawn_blocking(crate::store::upgrade_plaintext_credentials)
        .await
        .ok()
        .map_or(remaining, |report| report.failed);
    state.set_unprotected_credentials(report);
    report
}

#[tauri::command]
pub async fn refresh_account(
    state: State<'_, Arc<AppState>>,
    account_id: String,
) -> Result<Account, String> {
    usage::refresh_account(state.inner().clone(), &account_id).await
}

#[tauri::command]
pub async fn refresh_all(state: State<'_, Arc<AppState>>) -> Result<Vec<Account>, String> {
    Ok(usage::refresh_all(state.inner().clone()).await)
}

#[tauri::command]
pub fn reorder_accounts(
    state: State<'_, Arc<AppState>>,
    account_ids: Vec<String>,
) -> Result<Vec<Account>, String> {
    state.account_order.save(account_ids, state.store.list())
}

#[tauri::command]
pub fn rename_account(
    state: State<'_, Arc<AppState>>,
    account_id: String,
    label: String,
) -> Result<Account, String> {
    let label = validate_label(&label)?;
    state
        .store
        .mutate(&account_id, |account| account.label = label)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn remove_account(
    state: State<'_, Arc<AppState>>,
    account_id: String,
) -> Result<(), String> {
    state.remove_account(&account_id).await
}

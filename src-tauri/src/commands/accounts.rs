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
    let protection = retry_credential_sealing(state.inner()).await;
    let unprotected_account_ids = accounts
        .iter()
        .filter(|account| protection.account_ids.iter().any(|id| id == &account.id))
        .map(|account| account.id.clone())
        .collect();
    Ok(DashboardSnapshot {
        accounts,
        buckets,
        bridge: bridge_status(state.inner().as_ref()),
        unprotected_credentials: protection.failed,
        unprotected_account_ids,
    })
}

/// Sign-ins still stored unencrypted, and which accounts they belong to.
struct CredentialProtection {
    failed: usize,
    account_ids: Vec<String>,
}

/// While any saved sign-in is still unencrypted, each dashboard refresh tries
/// to seal it again. A keystore that was briefly unavailable at startup then
/// fixes itself, and the account note clears. A failed seal leaves the plain
/// file in place so the sign-in keeps working.
async fn retry_credential_sealing(state: &Arc<AppState>) -> CredentialProtection {
    let remaining = state.unprotected_credentials();
    if remaining == 0 {
        return CredentialProtection {
            failed: 0,
            account_ids: Vec::new(),
        };
    }
    let report = tauri::async_runtime::spawn_blocking(crate::store::upgrade_plaintext_credentials)
        .await
        .ok();
    let (failed, account_ids) = match report {
        Some(report) => (report.failed, report.failed_accounts),
        None => (remaining, state.unprotected_account_ids()),
    };
    state.set_unprotected_credentials(failed, account_ids.clone());
    CredentialProtection {
        failed,
        account_ids,
    }
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

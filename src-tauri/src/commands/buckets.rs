use crate::{
    model::{AccountBucket, Provider},
    state::AppState,
};
use std::str::FromStr;
use std::sync::Arc;
use tauri::State;

#[tauri::command]
pub fn get_account_buckets(state: State<'_, Arc<AppState>>) -> Result<Vec<AccountBucket>, String> {
    Ok(state.buckets.list())
}

#[tauri::command]
pub fn save_account_bucket(
    state: State<'_, Arc<AppState>>,
    id: Option<String>,
    name: String,
    provider: Option<String>,
    account_ids: Vec<String>,
) -> Result<AccountBucket, String> {
    let provider = match provider {
        Some(p) if !p.trim().is_empty() => Some(Provider::from_str(&p)?),
        _ => None,
    };
    state.buckets.save(id, name, provider, account_ids)
}

#[tauri::command]
pub fn delete_account_bucket(state: State<'_, Arc<AppState>>, id: String) -> Result<(), String> {
    state.buckets.delete(&id)
}

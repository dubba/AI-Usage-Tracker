use super::error::CommandResult;
use crate::{
    model::{AccountBucket, Provider},
    state::AppState,
};
use std::str::FromStr;
use std::sync::Arc;
use tauri::State;

#[tauri::command]
pub fn save_account_bucket(
    state: State<'_, Arc<AppState>>,
    id: Option<String>,
    name: String,
    provider: Option<String>,
    account_ids: Vec<String>,
) -> CommandResult<AccountBucket> {
    let provider = match provider {
        Some(p) if !p.trim().is_empty() => Some(Provider::from_str(&p)?),
        _ => None,
    };
    state
        .buckets
        .save(id, name, provider, account_ids)
        .map_err(crate::diagnostics::command_error)
        .map_err(Into::into)
}

#[tauri::command]
pub fn delete_account_bucket(state: State<'_, Arc<AppState>>, id: String) -> CommandResult<()> {
    state
        .buckets
        .delete(&id)
        .map_err(crate::diagnostics::command_error)
        .map_err(Into::into)
}

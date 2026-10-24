use crate::{
    history::report::{weekly_activity, WeeklyActivity},
    state::AppState,
};
use std::sync::Arc;
use tauri::State;

/// Weekly usage per day for every account with a weekly limit.
///
/// `day_starts` are the local midnights of the days to show, plus the one after the last, as RFC 3339
/// instants (N days need N + 1 values). The page works them out, so daylight saving time is its
/// concern; the backend only checks that they look like days (see `validate_day_starts`).
#[tauri::command]
pub async fn get_weekly_activity(
    state: State<'_, Arc<AppState>>,
    day_starts: Vec<String>,
) -> Result<WeeklyActivity, String> {
    let app = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        weekly_activity(&app, &day_starts, chrono::Utc::now().timestamp())
    })
    .await
    .map_err(|_| "Activity could not be loaded.".to_string())?
}

/// Deletes the recorded weekly readings of every account. Accounts and their current usage stay.
#[tauri::command]
pub async fn clear_activity_history(state: State<'_, Arc<AppState>>) -> Result<(), String> {
    let app = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || app.history.clear())
        .await
        .map_err(|_| "Activity history could not be cleared.".to_string())?
        .map_err(crate::diagnostics::command_error)
}

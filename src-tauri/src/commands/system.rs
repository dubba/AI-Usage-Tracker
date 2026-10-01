use crate::backend::initialize_backend;
use crate::{diagnostics, startup, state::AppState};
use std::sync::Arc;
use tauri::Manager;
use tauri::{AppHandle, State};

/// A redacted report for bug reports: versions, settings, per-account status,
/// and the recent log. Works even when startup failed.
#[tauri::command]
pub fn get_diagnostics(app: AppHandle) -> String {
    let state = app.try_state::<Arc<AppState>>();
    let issue = app
        .try_state::<startup::StartupStatus>()
        .and_then(|status| status.get())
        .map(|issue| issue.message);
    diagnostics::build_report(
        &app.package_info().version.to_string(),
        state.as_deref().map(|state| state.as_ref()),
        issue.as_deref(),
    )
}

#[tauri::command]
pub fn get_startup_issue(
    status: State<'_, startup::StartupStatus>,
) -> Option<startup::StartupIssue> {
    status.get()
}

/// Runs backend initialization again after a startup failure. Returns the
/// remaining problem, or `None` once the app is running.
#[tauri::command]
pub async fn retry_startup(app: AppHandle) -> Result<Option<startup::StartupIssue>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let status = app.state::<startup::StartupStatus>();
        match initialize_backend(&app) {
            Ok(()) => status.clear(),
            Err(issue) => status.set(issue),
        }
        status.get()
    })
    .await
    .map_err(|error| format!("Startup retry failed: {error}"))
}

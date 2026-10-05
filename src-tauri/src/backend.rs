use crate::{
    commands::pairing::GLOBAL_APP_HANDLE, migrations::migrate_google_ai_studio_accounts,
    refresh_loop::run_account_refresh_loop,
};
use crate::{diagnostics, startup, state::AppState, store::load_or_create_bridge_token};
use std::sync::Arc;
use tauri::AppHandle;
use tauri::Manager;

/// Serializes startup and retries so the backend is never built twice.
pub(crate) static BACKEND_INIT: parking_lot::Mutex<()> = parking_lot::Mutex::new(());

/// Loads saved data, manages the shared state, and starts the background
/// tasks. Safe to call again after a failure, and a no-op once it succeeded.
pub(crate) fn initialize_backend(app: &AppHandle) -> Result<(), startup::StartupIssue> {
    let _guard = BACKEND_INIT.lock();
    if app.try_state::<Arc<AppState>>().is_some() {
        return Ok(());
    }

    let data_dir = app.path().app_data_dir().map_err(|error| {
        startup::StartupIssue::new("Couldn't find the app data folder", error, None)
    })?;
    let issue = |what: &str, detail: String| {
        startup::StartupIssue::new(what, detail, Some(data_dir.as_path()))
    };
    crate::store::set_data_dir(data_dir.clone());
    diagnostics::init(&data_dir);
    // Crash-safe cleanup: remove stale private Grok login profiles left
    // by a previous crash/kill before any new login window opens.
    #[cfg(desktop)]
    crate::grok_login::sweep_stale_grok_profiles();

    // Seal plaintext credential files from earlier versions (Android only:
    // there is no platform cipher elsewhere, so this does nothing).
    #[cfg(target_os = "android")]
    let unprotected_credentials = crate::store::upgrade_plaintext_credentials().failed;

    // A token that cannot be read (locked keychain, denied prompt) only turns
    // the local API off; everything else keeps working.
    let (token, bridge_unavailable) = startup::bridge_token_or_fallback(
        load_or_create_bridge_token(),
        crate::store::generate_bridge_token,
    );
    let state = Arc::new(AppState::new(data_dir.clone(), token).map_err(|error| {
        issue(
            "AI Usage Tracker couldn't load its saved data. Nothing was deleted",
            error,
        )
    })?);
    state.set_bridge_unavailable(bridge_unavailable);
    #[cfg(target_os = "android")]
    state.set_unprotected_credentials(unprotected_credentials);
    migrate_google_ai_studio_accounts(state.as_ref());
    state.set_app_handle(app.clone());
    *GLOBAL_APP_HANDLE.lock() = Some(app.clone());
    app.manage(state.clone());
    // Paseo runs on the desktop, so a phone has nobody to serve on loopback.
    #[cfg(desktop)]
    tauri::async_runtime::spawn(crate::bridge_api::run_controller(state.clone()));
    tauri::async_runtime::spawn(run_account_refresh_loop(state.clone()));
    Ok(())
}

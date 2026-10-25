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

/// The shared state, kept here as well as in Tauri's managed state so a
/// background refresh that starts before any window (Android's WorkManager job)
/// and the UI that opens later use one `AppState`, never two writers on the
/// same files. Only read or written while holding `BACKEND_INIT`.
static SHARED_STATE: parking_lot::Mutex<Option<Arc<AppState>>> = parking_lot::Mutex::new(None);

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
    let state = shared_state(&data_dir)?;
    state.set_app_handle(app.clone());
    *GLOBAL_APP_HANDLE.lock() = Some(app.clone());
    app.manage(state.clone());
    // Paseo runs on the desktop, so a phone has nobody to serve on loopback.
    #[cfg(desktop)]
    tauri::async_runtime::spawn(crate::bridge_api::run_controller(state.clone()));
    tauri::async_runtime::spawn(run_account_refresh_loop(state.clone()));
    Ok(())
}

/// The state for a refresh that runs without a window. It has no app handle, so
/// it cannot emit events to the page.
#[cfg(any(target_os = "android", target_os = "ios"))]
pub(crate) fn background_state(
    data_dir: &std::path::Path,
) -> Result<Arc<AppState>, startup::StartupIssue> {
    let _guard = BACKEND_INIT.lock();
    shared_state(data_dir)
}

/// The existing shared state, or a new one built from the saved data. The
/// caller holds `BACKEND_INIT`.
fn shared_state(data_dir: &std::path::Path) -> Result<Arc<AppState>, startup::StartupIssue> {
    if let Some(state) = SHARED_STATE.lock().clone() {
        return Ok(state);
    }
    let state = build_state(data_dir)?;
    *SHARED_STATE.lock() = Some(state.clone());
    Ok(state)
}

fn build_state(data_dir: &std::path::Path) -> Result<Arc<AppState>, startup::StartupIssue> {
    let data_dir = data_dir.to_path_buf();
    let issue = |what: &str, detail: String| {
        startup::StartupIssue::new(what, detail, Some(data_dir.as_path()))
    };
    crate::store::set_data_dir(data_dir.clone());
    diagnostics::init(&data_dir);
    // Crash-safe cleanup: remove stale private Grok, OpenCode and provider OAuth login
    // profiles left by a previous crash/kill before any new login window opens.
    #[cfg(desktop)]
    crate::auth::login_profile::sweep_all_stale_profiles();

    // Ensure a fresh install or reinstall starts clean without inheriting stale credentials.
    crate::store::ensure_clean_installation(&data_dir);

    // Seal plaintext credential files from earlier versions (Android only:
    // there is no platform cipher elsewhere, so this does nothing).
    #[cfg(target_os = "android")]
    let credential_upgrade = crate::store::upgrade_plaintext_credentials();

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
    // Sign-ins saved before the background refresh existed are readable only while
    // the phone is unlocked. Converting them needs an unlocked phone, which the
    // app has whenever the user opens it.
    #[cfg(all(target_os = "ios", not(debug_assertions)))]
    crate::store::allow_background_credential_access();
    #[cfg(target_os = "android")]
    state.set_unprotected_credentials(
        credential_upgrade.failed,
        credential_upgrade.failed_accounts,
    );
    migrate_google_ai_studio_accounts(state.as_ref());
    Ok(state)
}

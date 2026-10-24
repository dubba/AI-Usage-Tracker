use crate::{
    state::AppState,
    store::{rotate_bridge_token, settings::AppSettings},
};
use std::sync::Arc;
use tauri::{AppHandle, State};

#[tauri::command]
pub fn get_app_settings(state: State<'_, Arc<AppState>>) -> Result<AppSettings, String> {
    Ok(state.settings.get())
}

#[tauri::command]
pub fn set_account_refresh_minutes(
    state: State<'_, Arc<AppState>>,
    minutes: u64,
) -> Result<AppSettings, String> {
    state.settings.set_account_refresh_minutes(minutes)
}

#[tauri::command]
pub fn set_automatic_updates_enabled(
    state: State<'_, Arc<AppState>>,
    enabled: bool,
) -> Result<AppSettings, String> {
    state.settings.set_automatic_updates_enabled(enabled)
}

#[tauri::command]
pub fn set_include_beta_updates(
    state: State<'_, Arc<AppState>>,
    enabled: bool,
) -> Result<AppSettings, String> {
    state.settings.set_include_beta_updates(enabled)
}

#[tauri::command]
pub fn get_autostart(app: AppHandle, state: State<'_, Arc<AppState>>) -> Result<bool, String> {
    #[cfg(desktop)]
    {
        use tauri_plugin_autostart::ManagerExt;
        let enabled = app
            .autolaunch()
            .is_enabled()
            .map_err(crate::diagnostics::command_error)?;
        let _ = state.settings.set_autostart_enabled(enabled);
        Ok(enabled)
    }
    #[cfg(not(desktop))]
    {
        let _ = app;
        Ok(state.settings.autostart_enabled())
    }
}

#[tauri::command]
pub fn set_autostart(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    enabled: bool,
) -> Result<bool, String> {
    #[cfg(desktop)]
    {
        use tauri_plugin_autostart::ManagerExt;
        if enabled {
            app.autolaunch()
                .enable()
                .map_err(crate::diagnostics::command_error)?;
            crate::platform::autostart::quote_windows_run_value(&app.package_info().name);
        } else {
            app.autolaunch()
                .disable()
                .map_err(crate::diagnostics::command_error)?;
        }
    }
    #[cfg(not(desktop))]
    let _ = app;

    state.settings.set_autostart_enabled(enabled)?;
    Ok(enabled)
}

/// Drops every account's saved usage snapshot. Accounts, sign-ins and settings are untouched; the
/// page refreshes usage afterwards.
#[tauri::command]
pub fn clear_cached_usage(state: State<'_, Arc<AppState>>) -> Result<(), String> {
    state
        .store
        .clear_cached_usage()
        .map_err(crate::diagnostics::command_error)?;
    Ok(())
}

/// Deletes everything the app keeps on this device: accounts, saved sign-ins, usage snapshots,
/// groups, alert settings, and settings. The local API token is replaced and launch at startup is
/// turned off. The page asks for the user's confirmation first; nothing here is recoverable.
#[tauri::command]
pub async fn delete_all_local_data(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    #[cfg(desktop)]
    {
        use tauri_plugin_autostart::ManagerExt;
        let autolaunch = app.autolaunch();
        if autolaunch.is_enabled().unwrap_or(false) {
            if let Err(error) = autolaunch.disable() {
                crate::diagnostics::warn(&format!(
                    "Could not turn off launch at startup while deleting local data: {}",
                    crate::diagnostics::command_error(error)
                ));
            }
        }
    }
    #[cfg(not(desktop))]
    let _ = app;

    state.delete_all_local_data().await?;
    let token = rotate_bridge_token().map_err(crate::diagnostics::command_error)?;
    *state.bridge_token.write() = token;
    Ok(())
}

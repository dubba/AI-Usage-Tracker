use crate::{settings::AppSettings, state::AppState};
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
            .map_err(|error| error.to_string())?;
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
                .map_err(|error| error.to_string())?;
        } else {
            app.autolaunch()
                .disable()
                .map_err(|error| error.to_string())?;
        }
    }
    #[cfg(not(desktop))]
    let _ = app;

    state.settings.set_autostart_enabled(enabled)?;
    Ok(enabled)
}

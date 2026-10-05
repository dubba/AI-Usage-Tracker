use crate::{
    model::{BridgeInfo, BridgeStatus},
    state::AppState,
    store::rotate_bridge_token,
};
use std::sync::Arc;
use tauri::Manager;
use tauri::{AppHandle, State, WebviewUrl, WebviewWindowBuilder};

pub(crate) const API_INTEGRATION_WINDOW_LABEL: &str = "api-integration";

#[tauri::command]
pub(crate) fn get_bridge_info(state: State<'_, Arc<AppState>>) -> Result<BridgeInfo, String> {
    Ok(bridge_info(state.inner().as_ref()))
}

#[tauri::command]
pub(crate) async fn set_api_integration_enabled(
    state: State<'_, Arc<AppState>>,
    enabled: bool,
) -> Result<BridgeStatus, String> {
    if cfg!(mobile) {
        return Err("The Paseo Bridge is only available on desktop.".into());
    }

    state.settings.set_paseo_bridge_enabled(enabled)?;

    for _ in 0..20 {
        let status = bridge_status(state.inner().as_ref());
        if (!enabled && !status.running) || (enabled && (status.running || status.error.is_some()))
        {
            return Ok(status);
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }

    Ok(bridge_status(state.inner().as_ref()))
}

#[tauri::command]
pub(crate) async fn open_api_integration_window(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    if !state.settings.paseo_bridge_enabled() {
        return Err("Enable the Paseo Bridge before opening its configuration.".into());
    }

    if let Some(window) = app.get_webview_window(API_INTEGRATION_WINDOW_LABEL) {
        #[cfg(desktop)]
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        return Ok(());
    }

    #[allow(unused_mut)]
    let mut builder = WebviewWindowBuilder::new(
        &app,
        API_INTEGRATION_WINDOW_LABEL,
        WebviewUrl::App("index.html".into()),
    )
    .title("Paseo Bridge")
    .inner_size(780.0, 760.0)
    .min_inner_size(640.0, 560.0);

    #[cfg(desktop)]
    {
        builder = builder.center();
        if let Some(icon) = app.default_window_icon() {
            builder = builder
                .icon(icon.clone())
                .map_err(|error| error.to_string())?;
        }
    }

    builder.build().map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
pub(crate) fn regenerate_bridge_token(
    state: State<'_, Arc<AppState>>,
) -> Result<BridgeInfo, String> {
    let token = rotate_bridge_token().map_err(|error| error.to_string())?;
    *state.bridge_token.write() = token;
    // Return masked info only; the UI must call reveal_bridge_token after
    // explicit user confirmation to display or copy the new value once.
    Ok(bridge_info(state.inner().as_ref()))
}

/// Explicit user-confirmed reveal of the full bridge bearer token.
/// The frontend must call this only from a Reveal/Copy click handler — never
/// on a timer — so the full token crosses IPC once per user action instead of
/// on every `get_bridge_info` poll.
#[tauri::command]
pub(crate) fn reveal_bridge_token(state: State<'_, Arc<AppState>>) -> Result<String, String> {
    Ok(state.bridge_token.read().clone())
}

pub(crate) fn bridge_status(state: &AppState) -> BridgeStatus {
    let runtime = state.api_runtime.read();
    BridgeStatus {
        endpoint: runtime.endpoint.clone(),
        enabled: state.settings.paseo_bridge_enabled(),
        running: runtime.running,
        error: runtime.error.clone(),
    }
}

pub(crate) fn bridge_info(state: &AppState) -> BridgeInfo {
    let status = bridge_status(state);
    let token = state.bridge_token.read().clone();
    let token_last4 = if token.len() >= 4 {
        token[token.len() - 4..].to_string()
    } else {
        String::new()
    };
    BridgeInfo {
        endpoint: status.endpoint,
        token: crate::model::mask_bridge_token(&token),
        token_last4,
        enabled: status.enabled,
        running: status.running,
        error: status.error,
    }
}

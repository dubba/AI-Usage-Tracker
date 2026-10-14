use crate::{
    model::{BridgeInfo, BridgeStatus},
    state::AppState,
    store::rotate_bridge_token,
};
use std::sync::Arc;
use tauri::Manager;
use tauri::{AppHandle, State, WebviewUrl, WebviewWindowBuilder};

pub(crate) const API_INTEGRATION_WINDOW_LABEL: &str = "api-integration";

/// Inner size that shows the Paseo Bridge page without scrolling.
/// The page is about 833px tall at this width, so the previous 760px height
/// cut off the connection details. An already-open window smaller than this
/// is grown to it; a larger size the user chose is left alone.
const API_INTEGRATION_WINDOW_WIDTH: f64 = 780.0;
const API_INTEGRATION_WINDOW_HEIGHT: f64 = 900.0;

/// Logical size to apply, or `None` when `current` is already large enough.
fn api_integration_window_size(current: Option<(f64, f64)>) -> Option<(f64, f64)> {
    let (width, height) = current.unwrap_or((0.0, 0.0));
    let next = (
        width.max(API_INTEGRATION_WINDOW_WIDTH),
        height.max(API_INTEGRATION_WINDOW_HEIGHT),
    );
    match current {
        Some((width, height)) if next.0 - width < 1.0 && next.1 - height < 1.0 => None,
        _ => Some(next),
    }
}

#[cfg(desktop)]
fn logical_inner_size(window: &tauri::WebviewWindow) -> Option<(f64, f64)> {
    let size = window.inner_size().ok()?;
    let scale = window.scale_factor().unwrap_or(1.0).max(0.1);
    Some((size.width as f64 / scale, size.height as f64 / scale))
}

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
        {
            let _ = window.unminimize();
            // A maximized window already fills the screen. Growing it would
            // pull it back down to the default size.
            if !window.is_maximized().unwrap_or(false) {
                if let Some((width, height)) =
                    api_integration_window_size(logical_inner_size(&window))
                {
                    let _ = window.set_size(tauri::LogicalSize::new(width, height));
                }
            }
        }
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
    .inner_size(API_INTEGRATION_WINDOW_WIDTH, API_INTEGRATION_WINDOW_HEIGHT)
    .min_inner_size(640.0, 560.0);

    #[cfg(desktop)]
    {
        builder = builder.center();
        if let Some(icon) = app.default_window_icon() {
            builder = builder
                .icon(icon.clone())
                .map_err(crate::diagnostics::command_error)?;
        }
    }

    builder.build().map_err(crate::diagnostics::command_error)?;
    Ok(())
}

#[tauri::command]
pub(crate) fn regenerate_bridge_token(
    state: State<'_, Arc<AppState>>,
) -> Result<BridgeInfo, String> {
    let token = rotate_bridge_token().map_err(crate::diagnostics::command_error)?;
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
pub(crate) async fn reveal_bridge_token(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
) -> Result<String, String> {
    // A native dialog, outside the page, decides: page code cannot answer it.
    crate::confirm::after_confirmation(
        &crate::confirm::REVEAL_BRIDGE_TOKEN,
        crate::confirm::ask(&app, &crate::confirm::REVEAL_BRIDGE_TOKEN),
        || Ok(state.bridge_token.read().clone()),
    )
    .await
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

#[cfg(test)]
mod tests {
    use super::api_integration_window_size;

    #[test]
    fn new_window_is_tall_enough_for_the_bridge_page() {
        assert_eq!(api_integration_window_size(None), Some((780.0, 900.0)));
    }

    #[test]
    fn a_short_open_window_grows_without_shrinking_a_wider_one() {
        assert_eq!(
            api_integration_window_size(Some((780.0, 760.0))),
            Some((780.0, 900.0))
        );
        assert_eq!(
            api_integration_window_size(Some((900.0, 760.0))),
            Some((900.0, 900.0))
        );
        assert_eq!(
            api_integration_window_size(Some((640.0, 800.0))),
            Some((780.0, 900.0))
        );
    }

    #[test]
    fn a_window_the_user_already_made_larger_is_left_alone() {
        assert_eq!(api_integration_window_size(Some((900.0, 1000.0))), None);
        assert_eq!(api_integration_window_size(Some((780.0, 900.0))), None);
        assert_eq!(api_integration_window_size(Some((779.2, 899.4))), None);
    }
}

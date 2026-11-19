use super::error::CommandResult;
use crate::{limits, pairing, state::AppState};
use std::sync::Arc;
use tauri::{AppHandle, State};

#[tauri::command]
pub async fn pairing_start_host(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    accept_settings: bool,
) -> CommandResult<crate::pairing::PairingHostInit> {
    crate::platform::capture_protection::release(&app);
    crate::platform::lan_binding::configure_pairing_network(true);
    state
        .pairing
        .start_host(state.inner().clone(), accept_settings)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn ensure_camera_permission() -> CommandResult<()> {
    tauri::async_runtime::spawn_blocking(crate::platform::camera_permission::ensure)
        .await
        .map_err(|e| {
            format!(
                "Camera permission check failed: {}",
                crate::diagnostics::command_error(e)
            )
        })?
        .map_err(Into::into)
}

#[tauri::command]
pub async fn pairing_wifi_enabled() -> CommandResult<bool> {
    tauri::async_runtime::spawn_blocking(crate::platform::wifi::is_enabled)
        .await
        .map_err(|e| {
            format!(
                "Wi-Fi check failed: {}",
                crate::diagnostics::command_error(e)
            )
        })?
        .map_err(Into::into)
}

#[tauri::command]
pub async fn pairing_open_wifi_settings() -> CommandResult<()> {
    tauri::async_runtime::spawn_blocking(crate::platform::wifi::open_settings)
        .await
        .map_err(|e| {
            format!(
                "Couldn't open Wi-Fi settings: {}",
                crate::diagnostics::command_error(e)
            )
        })?
        .map_err(Into::into)
}

#[tauri::command]
pub async fn pairing_start_client_by_code(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    code: String,
    accept_settings: bool,
) -> CommandResult<()> {
    crate::platform::capture_protection::release(&app);
    crate::platform::lan_binding::configure_pairing_network(true);
    state
        .pairing
        .start_client_by_code(state.inner().clone(), code, accept_settings)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn pairing_select_role(
    state: State<'_, Arc<AppState>>,
    role: String,
) -> CommandResult<()> {
    state.pairing.select_role(&role).await.map_err(Into::into)
}

#[tauri::command]
pub async fn pairing_confirm_transfer(
    state: State<'_, Arc<AppState>>,
    session_id: String,
    confirmed: bool,
) -> CommandResult<()> {
    state
        .pairing
        .confirm_transfer(&session_id, confirmed, &state.pairing_options)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn pairing_cancel(app: AppHandle, state: State<'_, Arc<AppState>>) -> CommandResult<()> {
    // The transfer codes, if any were showing, are gone once the flow is left.
    crate::platform::capture_protection::release(&app);
    state.pairing.cancel().await;
    state.pairing_options.write().reset();
    crate::platform::lan_binding::configure_pairing_network(false);
    Ok(())
}

#[tauri::command]
pub async fn pairing_status(
    state: State<'_, Arc<AppState>>,
) -> CommandResult<crate::pairing::PairingStatus> {
    Ok(state.pairing.get_status().await)
}

#[tauri::command]
pub fn pairing_set_include_settings(
    state: State<'_, Arc<AppState>>,
    include: bool,
) -> CommandResult<()> {
    state.pairing_options.write().include_settings = include;
    Ok(())
}

#[tauri::command]
pub fn pairing_set_pending_ui_state(
    state: State<'_, Arc<AppState>>,
    ui_state: serde_json::Value,
) -> CommandResult<()> {
    // Validate that it's an object with expected optional fields
    if !ui_state.is_object() && !ui_state.is_null() {
        return Err("UI state must be an object".into());
    }
    limits::check_ui_state_size(&ui_state)?;
    state.pairing_options.write().pending_ui_state = Some(ui_state);
    Ok(())
}

#[tauri::command]
pub fn pairing_clear_pending_ui_state(state: State<'_, Arc<AppState>>) -> CommandResult<()> {
    let mut options = state.pairing_options.write();
    options.pending_ui_state = None;
    options.include_settings = false;
    Ok(())
}

#[tauri::command]
pub async fn pairing_prepare_airgap_export(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    include_settings: bool,
    ui_state: Option<serde_json::Value>,
) -> CommandResult<pairing::airgap::AirgapExport> {
    if let Some(ui) = ui_state.as_ref() {
        limits::check_ui_state_size(ui)?;
    }
    // The frames decrypt to every stored sign-in, so a native dialog, outside
    // the page, decides whether to build them: page code cannot answer it.
    crate::confirm::after_confirmation(
        &crate::confirm::AIRGAP_EXPORT,
        crate::confirm::ask(&app, &crate::confirm::AIRGAP_EXPORT),
        || {
            let mut options = state.pairing_options.write();
            // Confirming a LAN transfer freezes that transfer's choice. This dialog
            // is a separate choice, so that snapshot must not override it.
            options.unfreeze();
            options.include_settings = include_settings;
            if let Some(ui) = ui_state {
                options.pending_ui_state = Some(ui);
            } else if !include_settings {
                options.pending_ui_state = None;
            }
            drop(options);
            // Before the codes exist, so they are never on a capturable window.
            crate::platform::capture_protection::protect(&app);
            let export = pairing::airgap::prepare_airgap_export(state.inner().as_ref());
            if export.is_err() {
                crate::platform::capture_protection::release(&app);
            }
            export
        },
    )
    .await
    .map_err(Into::into)
}

#[tauri::command]
pub fn pairing_verify_airgap(
    state: State<'_, Arc<AppState>>,
    chunks: Vec<String>,
) -> CommandResult<pairing::airgap::AirgapPreview> {
    pairing::airgap::preview_airgap_frames(state.inner(), chunks).map_err(Into::into)
}

#[tauri::command]
pub async fn pairing_import_airgap(
    state: State<'_, Arc<AppState>>,
    chunks: Vec<String>,
    ticket: String,
    accept_settings: bool,
) -> CommandResult<pairing::payload::SyncSummary> {
    pairing::airgap::import_airgap_payload(state.inner(), chunks, &ticket, accept_settings)
        .await
        .map_err(Into::into)
}

pub static GLOBAL_APP_HANDLE: parking_lot::Mutex<Option<AppHandle>> = parking_lot::Mutex::new(None);

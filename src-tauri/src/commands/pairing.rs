use crate::{limits, pairing, state::AppState};
use std::sync::Arc;
use tauri::{AppHandle, State};

#[tauri::command]
pub async fn pairing_start_host(
    state: State<'_, Arc<AppState>>,
) -> Result<crate::pairing::PairingHostInit, String> {
    crate::lan_binding::configure_pairing_network(true);
    state.pairing.start_host(state.inner().clone()).await
}

#[tauri::command]
pub async fn pairing_start_receiver(
    state: State<'_, Arc<AppState>>,
) -> Result<crate::pairing::PairingReceiverInit, String> {
    state.pairing.start_receiver(state.inner().clone()).await
}

#[tauri::command]
pub async fn ensure_camera_permission() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(crate::camera_permission::ensure)
        .await
        .map_err(|e| format!("Camera permission check failed: {e}"))?
}

#[tauri::command]
pub async fn pairing_start_client(
    state: State<'_, Arc<AppState>>,
    qr_uri: String,
) -> Result<(), String> {
    crate::lan_binding::configure_pairing_network(true);
    state
        .pairing
        .start_client(state.inner().clone(), qr_uri)
        .await
}

#[tauri::command]
pub async fn pairing_start_sender(
    state: State<'_, Arc<AppState>>,
    qr_uri: String,
) -> Result<(), String> {
    state
        .pairing
        .start_sender(state.inner().clone(), qr_uri)
        .await
}

#[tauri::command]
pub async fn pairing_start_client_by_code(
    state: State<'_, Arc<AppState>>,
    code: String,
) -> Result<(), String> {
    crate::lan_binding::configure_pairing_network(true);
    state
        .pairing
        .start_client_by_code(state.inner().clone(), code)
        .await
}

#[tauri::command]
pub async fn pairing_select_role(
    state: State<'_, Arc<AppState>>,
    role: String,
) -> Result<(), String> {
    state.pairing.select_role(&role).await
}

#[tauri::command]
pub async fn pairing_confirm_sas(
    state: State<'_, Arc<AppState>>,
    session_id: String,
    confirmed: bool,
) -> Result<(), String> {
    state.pairing.confirm_sas(&session_id, confirmed).await
}

#[tauri::command]
pub async fn pairing_cancel(state: State<'_, Arc<AppState>>) -> Result<(), String> {
    state.pairing.cancel().await;
    *state.pairing_include_settings.write() = false;
    *state.pairing_pending_ui_state.write() = None;
    *state.pairing_allow_credential_replace.write() = false;
    crate::lan_binding::configure_pairing_network(false);
    Ok(())
}

#[tauri::command]
pub async fn pairing_status(
    state: State<'_, Arc<AppState>>,
) -> Result<crate::pairing::PairingStatus, String> {
    Ok(state.pairing.get_status().await)
}

#[tauri::command]
pub fn pairing_set_include_settings(
    state: State<'_, Arc<AppState>>,
    include: bool,
) -> Result<(), String> {
    *state.pairing_include_settings.write() = include;
    Ok(())
}

#[tauri::command]
pub fn pairing_set_allow_credential_replace(
    state: State<'_, Arc<AppState>>,
    allow: bool,
) -> Result<(), String> {
    // Explicit per-transfer opt-in to overwrite credentials of existing local
    // accounts during the next pairing import. Defaults to false (preserve).
    *state.pairing_allow_credential_replace.write() = allow;
    Ok(())
}

#[tauri::command]
pub fn pairing_set_pending_ui_state(
    state: State<'_, Arc<AppState>>,
    ui_state: serde_json::Value,
) -> Result<(), String> {
    // Validate that it's an object with expected optional fields
    if !ui_state.is_object() && !ui_state.is_null() {
        return Err("UI state must be an object".into());
    }
    limits::check_ui_state_size(&ui_state)?;
    *state.pairing_pending_ui_state.write() = Some(ui_state);
    Ok(())
}

#[tauri::command]
pub fn pairing_clear_pending_ui_state(state: State<'_, Arc<AppState>>) -> Result<(), String> {
    *state.pairing_pending_ui_state.write() = None;
    *state.pairing_include_settings.write() = false;
    Ok(())
}

#[tauri::command]
pub fn pairing_prepare_airgap_export(
    state: State<'_, Arc<AppState>>,
    include_settings: bool,
    ui_state: Option<serde_json::Value>,
) -> Result<pairing::airgap::AirgapExport, String> {
    if let Some(ui) = ui_state.as_ref() {
        limits::check_ui_state_size(ui)?;
    }
    *state.pairing_include_settings.write() = include_settings;
    if let Some(ui) = ui_state {
        *state.pairing_pending_ui_state.write() = Some(ui);
    } else if !include_settings {
        *state.pairing_pending_ui_state.write() = None;
    }
    pairing::airgap::prepare_airgap_export(state.inner().as_ref())
}

#[tauri::command]
pub fn pairing_verify_airgap(
    chunks: Vec<String>,
) -> Result<pairing::airgap::AirgapVerifyResult, String> {
    pairing::airgap::verify_airgap_frames(chunks)
}

#[tauri::command]
pub async fn pairing_import_airgap(
    state: State<'_, Arc<AppState>>,
    chunks: Vec<String>,
) -> Result<pairing::payload::SyncSummary, String> {
    pairing::airgap::import_airgap_payload(state.inner(), chunks).await
}

pub static PENDING_PAIRING_URI: parking_lot::Mutex<Option<String>> = parking_lot::Mutex::new(None);

pub static GLOBAL_APP_HANDLE: parking_lot::Mutex<Option<AppHandle>> = parking_lot::Mutex::new(None);

#[cfg(target_os = "android")]
#[no_mangle]
pub extern "C" fn Java_com_yajinni_paseousagebridge_MainActivity_setPendingPairingUri(
    mut env: jni::JNIEnv,
    _class: jni::objects::JClass,
    uri: jni::objects::JString,
) {
    if let Ok(uri_str) = env.get_string(&uri) {
        let uri_val = uri_str.to_string_lossy().into_owned();
        // Validate before storing: any app can fire a VIEW intent, and the
        // URI carries key material. Never log its contents.
        if !is_valid_incoming_pairing_uri(&uri_val) {
            return;
        }
        *PENDING_PAIRING_URI.lock() = Some(uri_val.clone());
        if let Some(app) = GLOBAL_APP_HANDLE.lock().as_ref() {
            use tauri::Emitter;
            let _ = app.emit("pairing-uri-received", uri_val);
        }
    }
}

/// Length-bounded allowlist check for pairing URIs arriving from Android
/// intents. Full cryptographic validation happens in
/// `pairing::protocol::ParsedQrPayload::parse` before any connection.
#[cfg(target_os = "android")]
pub fn is_valid_incoming_pairing_uri(uri: &str) -> bool {
    if uri.len() > limits::MAX_PAIRING_URI_CHARS {
        return false;
    }
    uri.starts_with("aiusage-pair:") || uri.starts_with("aiusage:")
}

#[tauri::command]
pub async fn get_pending_pairing_uri() -> Result<Option<String>, String> {
    Ok(PENDING_PAIRING_URI.lock().take())
}

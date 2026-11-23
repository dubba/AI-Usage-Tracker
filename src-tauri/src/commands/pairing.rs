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

// ---- Transfer by file (pairing::file_transfer) ----------------------------------------------
// The page never names a path: Rust shows the native open and save dialogs and reads and writes
// the files itself, so the page only ever sees counts and a ticket.

/// The extension of both transfer files; which one a file is, is inside it.
const TRANSFER_FILE_EXTENSION: &str = "aiutpair";
const REQUEST_FILE_NAME: &str = "AI Usage Tracker request.aiutpair";
const REPLY_FILE_NAME: &str = "AI Usage Tracker reply.aiutpair";
const FILE_READ_FAILED: &str = "Couldn't read that file. Choose it again.";
const FILE_SAVE_FAILED: &str = "Couldn't save the file. Choose another place and try again.";

fn file_error(message: impl Into<String>) -> super::error::CommandError {
    super::error::CommandError::new(super::error::ErrorCode::Pairing, message.into())
}

/// Shows the native save dialog; `None` when the user cancels.
async fn choose_save_path(
    app: &AppHandle,
    title: &str,
    file_name: &str,
) -> Option<std::path::PathBuf> {
    use tauri_plugin_dialog::DialogExt;
    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title(title)
        .set_file_name(file_name)
        .add_filter("AI Usage Tracker transfer", &[TRANSFER_FILE_EXTENSION])
        .save_file(move |path| {
            let _ = sender.send(path);
        });
    receiver.await.ok().flatten()?.into_path().ok()
}

/// Shows the native open dialog and reads the chosen file, refusing one larger than `max_len`
/// before reading it. `None` when the user cancels.
async fn pick_transfer_file(
    app: &AppHandle,
    title: &str,
    max_len: usize,
) -> CommandResult<Option<Vec<u8>>> {
    use tauri_plugin_dialog::DialogExt;
    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title(title)
        .add_filter("AI Usage Tracker transfer", &[TRANSFER_FILE_EXTENSION])
        .pick_file(move |path| {
            let _ = sender.send(path);
        });
    let Some(path) = receiver.await.ok().flatten() else {
        return Ok(None);
    };
    let path = path.into_path().map_err(|_| file_error(FILE_READ_FAILED))?;
    tauri::async_runtime::spawn_blocking(move || read_capped(&path, max_len))
        .await
        .map_err(|_| file_error(FILE_READ_FAILED))?
        .map(Some)
}

/// Reads at most `max_len` bytes; a longer file is not a transfer file.
fn read_capped(path: &std::path::Path, max_len: usize) -> CommandResult<Vec<u8>> {
    use std::io::Read;
    let read_failed = |error: std::io::Error| {
        crate::diagnostics::warn(&format!(
            "Reading a transfer file failed: {}",
            crate::diagnostics::command_error(error)
        ));
        file_error(FILE_READ_FAILED)
    };
    let file = std::fs::File::open(path).map_err(read_failed)?;
    let mut bytes = Vec::new();
    file.take(max_len as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(read_failed)?;
    if bytes.len() > max_len {
        return Err(file_error(pairing::file_transfer::NOT_A_PAIRING_FILE));
    }
    Ok(bytes)
}

async fn write_transfer_file(path: std::path::PathBuf, bytes: Vec<u8>) -> CommandResult<()> {
    tauri::async_runtime::spawn_blocking(move || std::fs::write(&path, bytes))
        .await
        .map_err(|_| file_error(FILE_SAVE_FAILED))?
        .map_err(|error| {
            crate::diagnostics::warn(&format!(
                "Saving a transfer file failed: {}",
                crate::diagnostics::command_error(error)
            ));
            file_error(FILE_SAVE_FAILED)
        })
}

/// Receiver: makes the request for the device showing `code` and saves it where the user
/// chooses. False when the save dialog was cancelled (no request is kept then).
#[tauri::command]
pub async fn pairing_file_save_request(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    code: String,
) -> CommandResult<bool> {
    let Some(path) = choose_save_path(&app, "Save the request", REQUEST_FILE_NAME).await else {
        return Ok(false);
    };
    let request =
        pairing::file_transfer::create_request(state.inner(), &code).map_err(file_error)?;
    if let Err(error) = write_transfer_file(path, request).await {
        state.pairing_file_receiver.lock().take();
        return Err(error);
    }
    Ok(true)
}

/// Sender: opens a request file for the code this device shows, and says how many accounts it
/// would send. `None` when the open dialog was cancelled.
#[tauri::command]
pub async fn pairing_file_open_request(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
) -> CommandResult<Option<pairing::file_transfer::FileRequestInfo>> {
    let Some(request) = pick_transfer_file(
        &app,
        "Open the request",
        pairing::file_transfer::REQUEST_LEN,
    )
    .await?
    else {
        return Ok(None);
    };
    pairing::file_transfer::open_request(state.inner(), request)
        .await
        .map(Some)
        .map_err(file_error)
}

/// Sender, after its user agreed: answers the opened request and saves the reply where the user
/// chooses. The place is chosen first, so cancelling the dialog does not use the code up. False
/// when it was cancelled. `include_settings` and `ui_state` are this transfer's extras, as for the
/// QR export.
#[tauri::command]
pub async fn pairing_file_save_reply(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    include_settings: bool,
    ui_state: Option<serde_json::Value>,
) -> CommandResult<bool> {
    if let Some(ui) = ui_state.as_ref() {
        limits::check_ui_state_size(ui)?;
    }
    let Some(path) = choose_save_path(&app, "Save the reply", REPLY_FILE_NAME).await else {
        return Ok(false);
    };
    {
        let mut options = state.pairing_options.write();
        options.unfreeze();
        options.include_settings = include_settings;
        options.pending_ui_state = if include_settings { ui_state } else { None };
    }
    let reply = pairing::file_transfer::answer_request(state.inner())
        .await
        .map_err(file_error)?;
    write_transfer_file(path, reply).await?;
    Ok(true)
}

/// Receiver: opens the reply file and says how many accounts it holds, importing nothing.
/// `None` when the open dialog was cancelled.
#[tauri::command]
pub async fn pairing_file_open_reply(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
) -> CommandResult<Option<pairing::file_transfer::FilePreview>> {
    let Some(reply) = pick_transfer_file(
        &app,
        "Open the reply",
        pairing::file_transfer::MAX_REPLY_LEN,
    )
    .await?
    else {
        return Ok(None);
    };
    pairing::file_transfer::preview_reply(state.inner(), reply)
        .map(Some)
        .map_err(file_error)
}

/// Receiver, after its user agreed: imports the reply the preview opened. `ticket` is the
/// preview's; `accept_settings` is this device's own choice.
#[tauri::command]
pub async fn pairing_file_import_reply(
    state: State<'_, Arc<AppState>>,
    ticket: String,
    accept_settings: bool,
) -> CommandResult<pairing::payload::SyncSummary> {
    pairing::file_transfer::import_reply(state.inner(), &ticket, accept_settings)
        .await
        .map_err(file_error)
}

pub static GLOBAL_APP_HANDLE: parking_lot::Mutex<Option<AppHandle>> = parking_lot::Mutex::new(None);

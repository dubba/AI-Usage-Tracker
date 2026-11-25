use super::error::CommandResult;
use crate::{limits, pairing, pairing::sync_log, state::AppState};
use std::sync::Arc;
use tauri::{AppHandle, State};

#[tauri::command]
pub async fn pairing_start_host(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    accept_settings: bool,
    legacy_code: bool,
) -> CommandResult<crate::pairing::PairingHostInit> {
    crate::platform::capture_protection::release(&app);
    crate::platform::lan_binding::prepare_pairing_network().await;
    state
        .pairing
        .start_host(state.inner().clone(), accept_settings, legacy_code)
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

/// Whether the phone is on Wi-Fi, for the Sync Devices log only: nothing waits on the answer.
#[tauri::command]
pub async fn pairing_wifi_enabled() -> CommandResult<bool> {
    let on_wifi = tauri::async_runtime::spawn_blocking(crate::platform::wifi::is_enabled)
        .await
        .map_err(|e| {
            format!(
                "Wi-Fi check failed: {}",
                crate::diagnostics::command_error(e)
            )
        })??;
    sync_log::wifi_check(on_wifi);
    Ok(on_wifi)
}

#[tauri::command]
pub async fn pairing_start_client_by_code(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    code: String,
    accept_settings: bool,
) -> CommandResult<()> {
    crate::platform::capture_protection::release(&app);
    crate::platform::lan_binding::prepare_pairing_network().await;
    state
        .pairing
        .start_client_by_code(state.inner().clone(), code, accept_settings)
        .await
        .map_err(join_error)
}

/// A failed join as the page gets it: a search that found no one is `not_found`, for which the
/// page offers AirDrop or Quick Share; anything else is shown as it is.
fn join_error(error: String) -> super::error::CommandError {
    if error == pairing::discovery::NOT_FOUND {
        super::error::CommandError::new(super::error::ErrorCode::NotFound, error)
    } else {
        error.into()
    }
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
    // A transfer file that opened but was not added: its accounts go too.
    *state.pairing_file_received.lock() = None;
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
            match &export {
                Ok(export) => sync_log::note(&format!(
                    "QR codes: showing {} code(s) to send",
                    export.total_chunks
                )),
                Err(error) => {
                    sync_log::failed_text("QR codes: making the codes to send", error);
                    crate::platform::capture_protection::release(&app);
                }
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
    let preview = pairing::airgap::preview_airgap_frames(state.inner(), chunks);
    match &preview {
        Ok(preview) => sync_log::note(&format!(
            "QR codes: scanned all {} code(s), {}",
            preview.total_chunks,
            sync_log::accounts(preview.account_count)
        )),
        Err(error) => sync_log::failed_text("QR codes: reading the scanned codes", error),
    }
    preview.map_err(Into::into)
}

#[tauri::command]
pub async fn pairing_import_airgap(
    state: State<'_, Arc<AppState>>,
    chunks: Vec<String>,
    ticket: String,
    accept_settings: bool,
) -> CommandResult<pairing::payload::SyncSummary> {
    let summary =
        pairing::airgap::import_airgap_payload(state.inner(), chunks, &ticket, accept_settings)
            .await;
    match &summary {
        Ok(summary) => sync_log::note(&format!(
            "QR codes: imported, {}",
            sync_log::describe_summary(summary)
        )),
        Err(error) => sync_log::failed_text("QR codes: importing", error),
    }
    summary.map_err(Into::into)
}

// ---- Transfer by file (pairing::file_transfer) ----------------------------------------------
// The page never names a path: Rust shows the native open and save dialogs and reads and writes
// the files itself, so the page only ever sees counts and a ticket.

/// The transfer file's extension.
const TRANSFER_FILE_EXTENSION: &str = "aiutpair";
const TRANSFER_FILE_NAME: &str = "AI Usage Tracker accounts.aiutpair";
const FILE_READ_FAILED: &str = "Couldn't read that file. Choose it again.";
const FILE_SAVE_FAILED: &str = "Couldn't save the file. Choose another place and try again.";
const NOTHING_TO_SEND: &str = "There's no transfer file to send. Start again.";

fn file_error(message: impl Into<String>) -> super::error::CommandError {
    super::error::CommandError::new(super::error::ErrorCode::Pairing, message.into())
}

/// The open and save dialogs, filtered to transfer files where the system knows file types by
/// extension. Android filters by MIME type and iOS may receive `.aiutpair 2` duplicates or generic
/// binary types from Android Quick Share, so mobile leaves the picker unfiltered and validates the
/// header on read.
fn transfer_dialog(
    app: &AppHandle,
    title: &str,
) -> tauri_plugin_dialog::FileDialogBuilder<tauri::Wry> {
    use tauri_plugin_dialog::DialogExt;
    let dialog = app.dialog().file().set_title(title);
    if cfg!(any(target_os = "android", target_os = "ios")) {
        dialog
    } else {
        dialog.add_filter("AI Usage Tracker transfer", &[TRANSFER_FILE_EXTENSION])
    }
}

/// Shows the native open dialog and reads the chosen file, refusing one larger than `max_len`
/// before reading it. `None` when the user cancels.
async fn pick_transfer_file(
    app: &AppHandle,
    title: &str,
    max_len: usize,
) -> CommandResult<Option<Vec<u8>>> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    transfer_dialog(app, title).pick_file(move |path| {
        let _ = sender.send(path);
    });
    let Some(path) = receiver.await.ok().flatten() else {
        return Ok(None);
    };
    tauri::async_runtime::spawn_blocking(move || read_picked(path, max_len))
        .await
        .map_err(|_| file_error(FILE_READ_FAILED))?
        .map(Some)
}

/// Reads a picked file, at most `max_len` bytes: a path, or on Android a `content://` address.
fn read_picked(path: tauri_plugin_dialog::FilePath, max_len: usize) -> CommandResult<Vec<u8>> {
    match path {
        tauri_plugin_dialog::FilePath::Path(path) => read_capped(&path, max_len),
        #[cfg(target_os = "android")]
        tauri_plugin_dialog::FilePath::Url(url) => {
            let bytes =
                crate::platform::android_files::read(url.as_str(), max_len).map_err(file_error)?;
            if bytes.len() > max_len {
                return Err(file_error(pairing::file_transfer::NOT_A_PAIRING_FILE));
            }
            Ok(bytes)
        }
        // iOS hands back a copy of the picked file (`asCopy: true`) as a `file://` address in the
        // app's temporary inbox. It is deleted once read so it is never re-offered as a tapped file.
        #[cfg(not(target_os = "android"))]
        tauri_plugin_dialog::FilePath::Url(url) => match url.to_file_path() {
            Ok(path) => {
                let read = read_capped(&path, max_len);
                #[cfg(target_os = "ios")]
                let _ = std::fs::remove_file(&path);
                read
            }
            Err(()) => Err(file_error(FILE_READ_FAILED)),
        },
    }
}

/// Shows the native save dialog; `None` when the user cancels. A path on desktop, a
/// `content://` address on Android.
async fn choose_save_path(
    app: &AppHandle,
    title: &str,
    file_name: &str,
) -> Option<tauri_plugin_dialog::FilePath> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    transfer_dialog(app, title)
        .set_file_name(file_name)
        .save_file(move |path| {
            let _ = sender.send(path);
        });
    receiver.await.ok().flatten()
}

/// Copies the file at `source` to where the save dialog pointed.
fn write_saved(
    source: &std::path::Path,
    target: tauri_plugin_dialog::FilePath,
) -> std::io::Result<()> {
    match target {
        tauri_plugin_dialog::FilePath::Path(target) => std::fs::copy(source, target).map(|_| ()),
        #[cfg(target_os = "android")]
        tauri_plugin_dialog::FilePath::Url(url) => {
            let bytes = std::fs::read(source)?;
            crate::platform::android_files::write(url.as_str(), &bytes)
                .map_err(std::io::Error::other)
        }
        #[cfg(not(target_os = "android"))]
        tauri_plugin_dialog::FilePath::Url(_) => Err(std::io::Error::other("not a file path")),
    }
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

/// Puts `bytes` in the app's cache folder as the file to share or save next, replacing the last
/// one. Returns whether this platform has a share menu (otherwise the page offers Save only).
async fn keep_outgoing(app: &AppHandle, state: &AppState, bytes: Vec<u8>) -> CommandResult<bool> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|_| file_error(FILE_SAVE_FAILED))?
        .join("transfer-files");
    let path = dir.join(TRANSFER_FILE_NAME);
    let len = bytes.len();
    let written = tauri::async_runtime::spawn_blocking(move || {
        // Only the newest file is kept.
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir)?;
        std::fs::write(&path, bytes).map(|()| path)
    })
    .await
    .map_err(|_| file_error(FILE_SAVE_FAILED))?
    .map_err(|error| {
        crate::diagnostics::warn(&format!(
            "Keeping a transfer file failed: {}",
            crate::diagnostics::command_error(error)
        ));
        file_error(FILE_SAVE_FAILED)
    })?;
    *state.pairing_file_outgoing.lock() = Some(written);
    sync_log::note(&format!(
        "file: made the transfer file ({}), ready to share or save",
        sync_log::size(len)
    ));
    Ok(crate::platform::share_sheet::AVAILABLE)
}

/// Sender: makes the transfer file for the device showing `code`, ready to share or save, and
/// stops looking for that device on the network (one way per code). `include_settings` and
/// `ui_state` are this transfer's extras, as for the QR export. Returns whether a share menu is
/// available.
#[tauri::command]
pub async fn pairing_file_send(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    code: String,
    include_settings: bool,
    ui_state: Option<serde_json::Value>,
) -> CommandResult<bool> {
    if let Some(ui) = ui_state.as_ref() {
        limits::check_ui_state_size(ui)?;
    }
    state.pairing.cancel().await;
    {
        let mut options = state.pairing_options.write();
        options.reset();
        options.include_settings = include_settings;
        options.pending_ui_state = if include_settings { ui_state } else { None };
    }
    let file = pairing::file_transfer::seal(state.inner(), &code)
        .await
        .map_err(|error| {
            sync_log::failed_text("file: making the transfer file", &error);
            file_error(error)
        })?;
    keep_outgoing(&app, state.inner(), file).await
}

/// Opens the system share menu (AirDrop, Quick Share, Messages, …) for the file made last.
#[tauri::command]
pub async fn pairing_file_share(
    window: tauri::WebviewWindow,
    state: State<'_, Arc<AppState>>,
) -> CommandResult<()> {
    let Some(path) = state.pairing_file_outgoing.lock().clone() else {
        return Err(file_error(NOTHING_TO_SEND));
    };
    let shared = crate::platform::share_sheet::share_file(&window, &path).await;
    match &shared {
        Ok(()) => sync_log::note("file: opened the share menu (Quick Share, AirDrop, …)"),
        Err(error) => sync_log::failed_text("file: opening the share menu", error),
    }
    shared.map_err(file_error)
}

/// Saves a copy of the file made last where the user chooses. False when the dialog was
/// cancelled.
#[tauri::command]
pub async fn pairing_file_save(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
) -> CommandResult<bool> {
    let Some(source) = state.pairing_file_outgoing.lock().clone() else {
        return Err(file_error(NOTHING_TO_SEND));
    };
    let Some(target) = choose_save_path(&app, "Save the file", TRANSFER_FILE_NAME).await else {
        sync_log::note("file: save cancelled");
        return Ok(false);
    };
    tauri::async_runtime::spawn_blocking(move || write_saved(&source, target))
        .await
        .map_err(|_| file_error(FILE_SAVE_FAILED))?
        .map_err(|error| {
            crate::diagnostics::warn(&format!(
                "Saving a transfer file failed: {}",
                crate::diagnostics::command_error(error)
            ));
            file_error(FILE_SAVE_FAILED)
        })?;
    sync_log::note("file: saved a copy");
    Ok(true)
}

/// Receiver: opens a transfer file chosen in the native open dialog (e.g. iOS Files → Downloads
/// when AirDrop from Android Quick Share saves the file to Files) with the code this device shows,
/// and says how many accounts it holds, importing nothing. `None` when the dialog was cancelled.
#[tauri::command]
pub async fn pairing_file_open(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
) -> CommandResult<Option<pairing::file_transfer::FilePreview>> {
    let Some(file) =
        pick_transfer_file(&app, "Open the file", pairing::file_transfer::MAX_FILE_LEN)
            .await
            .inspect_err(|error| sync_log::failed("file: reading the chosen file", error))?
    else {
        sync_log::note("file: choosing a file cancelled");
        return Ok(None);
    };
    open_received(state.inner(), file, CHOSEN).await.map(Some)
}

/// Android, iOS, and macOS: whether a transfer file was opened from another app (Quick Share's
/// notification, AirDrop, Files, Finder) and not opened in Sync Devices yet. Always false elsewhere.
#[tauri::command]
pub async fn pairing_file_tapped_pending() -> CommandResult<bool> {
    #[cfg(target_os = "android")]
    let pending = tauri::async_runtime::spawn_blocking(crate::platform::android_files::has_tapped)
        .await
        .map_err(|_| file_error(FILE_READ_FAILED))?;
    #[cfg(any(target_os = "ios", target_os = "macos"))]
    let pending = tauri::async_runtime::spawn_blocking(crate::platform::ios_files::has_tapped)
        .await
        .map_err(|_| file_error(FILE_READ_FAILED))?;
    #[cfg(not(any(target_os = "android", target_os = "ios", target_os = "macos")))]
    let pending = false;
    Ok(pending)
}

/// Android, iOS, and macOS: opens the file opened from another app with the code this device shows,
/// and says how many accounts it holds, importing nothing. `None` when no file is waiting. Always
/// `None` elsewhere.
#[tauri::command]
pub async fn pairing_file_open_tapped(
    state: State<'_, Arc<AppState>>,
) -> CommandResult<Option<pairing::file_transfer::FilePreview>> {
    #[cfg(target_os = "android")]
    let opened = open_tapped_on_android(state.inner()).await?;
    #[cfg(any(target_os = "ios", target_os = "macos"))]
    let opened = open_tapped_on_ios(state.inner()).await?;
    #[cfg(not(any(target_os = "android", target_os = "ios", target_os = "macos")))]
    let opened = {
        let _ = state;
        None
    };
    Ok(opened)
}

#[cfg(any(target_os = "ios", target_os = "macos"))]
async fn open_tapped_on_ios(
    state: &AppState,
) -> CommandResult<Option<pairing::file_transfer::FilePreview>> {
    use pairing::file_transfer::MAX_FILE_LEN;
    let read = tauri::async_runtime::spawn_blocking(|| {
        crate::platform::ios_files::take_tapped(MAX_FILE_LEN)
    })
    .await
    .map_err(|_| file_error(FILE_READ_FAILED))
    .and_then(|read| {
        read.map_err(|error| {
            crate::diagnostics::warn(&format!(
                "Reading an opened transfer file failed: {}",
                crate::diagnostics::command_error(error)
            ));
            file_error(FILE_READ_FAILED)
        })
    })
    .inspect_err(|error| sync_log::failed("file: reading a file opened from another app", error))?;
    // The page can ask twice at once: the one that finds nothing logs nothing.
    let Some(bytes) = read else {
        return Ok(None);
    };
    if bytes.len() > MAX_FILE_LEN {
        let error = file_error(pairing::file_transfer::NOT_A_PAIRING_FILE);
        sync_log::failed("file: opening a file opened from another app", &error);
        return Err(error);
    }
    open_received(state, bytes, TAPPED).await.map(Some)
}

#[cfg(target_os = "android")]
async fn open_tapped_on_android(
    state: &AppState,
) -> CommandResult<Option<pairing::file_transfer::FilePreview>> {
    use crate::platform::android_files;
    use pairing::file_transfer::MAX_FILE_LEN;
    let read =
        tauri::async_runtime::spawn_blocking(|| -> CommandResult<Option<(String, Vec<u8>)>> {
            let Some(uri) = android_files::take_tapped().map_err(file_error)? else {
                return Ok(None);
            };
            let bytes = android_files::read(&uri, MAX_FILE_LEN).map_err(file_error)?;
            if bytes.len() > MAX_FILE_LEN {
                return Err(file_error(pairing::file_transfer::NOT_A_PAIRING_FILE));
            }
            Ok(Some((uri, bytes)))
        })
        .await
        .map_err(|_| file_error(FILE_READ_FAILED))
        .and_then(|read| read)
        .inspect_err(|error| {
            sync_log::failed("file: reading a file tapped in another app", error)
        })?;
    // The page can ask twice at once (Android's event and the page coming back into view): the
    // one that finds nothing logs nothing.
    let Some((uri, bytes)) = read else {
        return Ok(None);
    };
    let opened = open_received(state, bytes, TAPPED).await?;
    // The accounts are in memory now and the code is used up: the file is spent.
    tauri::async_runtime::spawn_blocking(move || android_files::delete(&uri));
    Ok(Some(opened))
}

/// Where a received file came from, for the sync log.
const CHOSEN: &str = "chosen in the open dialog";
#[cfg(any(target_os = "android", target_os = "ios", target_os = "macos"))]
const TAPPED: &str = "tapped in another app";
const PICKED_UP: &str = "picked up from Downloads";

/// Opens a transfer file, already read, with the code this device shows, logging how it went.
/// `source` is [`CHOSEN`], [`TAPPED`] or [`PICKED_UP`].
async fn open_received(
    state: &AppState,
    bytes: Vec<u8>,
    source: &str,
) -> CommandResult<pairing::file_transfer::FilePreview> {
    let len = bytes.len();
    let opened = pairing::file_transfer::open(state, bytes)
        .await
        .map_err(|error| {
            sync_log::failed_text(
                &format!("file: opening a file {source} ({})", sync_log::size(len)),
                &error,
            );
            file_error(error)
        })?;
    sync_log::note(&format!(
        "file: opened a file {source} ({}), holding {}",
        sync_log::size(len),
        sync_log::accounts(opened.account_count)
    ));
    Ok(opened)
}

/// What the page learns when it starts waiting for a transfer file.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct IncomingWatchInfo {
    /// Files arriving in Downloads are picked up by themselves ([`pairing_file_poll`]).
    pub watching: bool,
    /// Android: picking them up needs the user to allow file access first
    /// ([`pairing_file_request_access`]).
    pub needs_access: bool,
}

/// Receiver: starts (or restarts) looking in Downloads for the transfer file. Files already there
/// are left alone. On Android and iPhone, picking them up automatically needs the user's one-time
/// Downloads folder access ([`pairing_file_request_access`]).
#[tauri::command]
pub async fn pairing_file_watch(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
) -> CommandResult<IncomingWatchInfo> {
    use pairing::incoming_files::IncomingWatch;
    #[cfg(target_os = "android")]
    {
        let allowed =
            tauri::async_runtime::spawn_blocking(crate::platform::android_files::downloads_access)
                .await
                .unwrap_or(false);
        if !allowed {
            *state.pairing_incoming.lock() = None;
            return Ok(IncomingWatchInfo {
                watching: false,
                needs_access: true,
            });
        }
    }
    #[cfg(target_os = "ios")]
    {
        use tauri::Manager;
        let data_dir = app.path().app_data_dir().ok();
        let watch = tauri::async_runtime::spawn_blocking(move || {
            let dir = data_dir?;
            let scope = crate::platform::ios_files::open_downloads_dir(&dir)?;
            let watch = IncomingWatch::start(vec![scope.path().to_path_buf()]);
            Some(watch)
        })
        .await
        .map_err(|_| file_error(FILE_READ_FAILED))?;
        let watching = watch.is_some();
        *state.pairing_incoming.lock() = watch;
        if watching {
            sync_log::note("file: watching Downloads for the transfer file");
        }
        return Ok(IncomingWatchInfo {
            watching,
            needs_access: !watching,
        });
    }
    #[cfg(not(target_os = "ios"))]
    {
        use pairing::incoming_files::watched_dirs;
        let (watch, denied) = tauri::async_runtime::spawn_blocking(move || {
            let dirs = watched_dirs(&app);
            let denied = dirs.iter().any(|dir| {
                matches!(
                    std::fs::read_dir(dir),
                    Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied
                )
            });
            let watch = (!dirs.is_empty()).then(|| IncomingWatch::start(dirs));
            (watch, denied)
        })
        .await
        .map_err(|_| file_error(FILE_READ_FAILED))?;
        let watching = watch.is_some();
        *state.pairing_incoming.lock() = watch;
        if denied {
            sync_log::note("file: Downloads folder access was denied by the OS");
        } else if watching {
            sync_log::note("file: watching Downloads for the transfer file");
        }
        Ok(IncomingWatchInfo {
            watching,
            needs_access: false,
        })
    }
}

/// Stops looking in Downloads (the page left the step that waits for a file).
#[tauri::command]
pub fn pairing_file_watch_stop(state: State<'_, Arc<AppState>>) -> CommandResult<()> {
    *state.pairing_incoming.lock() = None;
    Ok(())
}

/// Android / iOS: asks the user for one-time Downloads folder access so transfer files saved by
/// Quick Share or AirDrop are picked up automatically. Does nothing elsewhere.
#[tauri::command]
pub async fn pairing_file_request_access(
    #[allow(unused_variables)] app: AppHandle,
    #[allow(unused_variables)] window: tauri::WebviewWindow,
) -> CommandResult<()> {
    #[cfg(target_os = "android")]
    tauri::async_runtime::spawn_blocking(crate::platform::android_files::request_downloads_access)
        .await
        .map_err(|_| file_error(FILE_READ_FAILED))?
        .map_err(file_error)?;
    #[cfg(target_os = "ios")]
    {
        use tauri::Manager;
        let data_dir = app
            .path()
            .app_data_dir()
            .map_err(|_| file_error(FILE_READ_FAILED))?;
        crate::platform::ios_files::request_downloads_access(&window, data_dir)
            .await
            .map_err(file_error)?;
    }
    Ok(())
}

/// Opens the setting that decides who may send this device files by AirDrop or Quick Share, so a
/// device on another Google or Apple account can send here; apps cannot change it themselves.
/// Mac: Finder's AirDrop window (or System Settings). Windows: Nearby Sharing in Settings.
/// Elsewhere there is nothing an app can open: iPhone gets the steps, and Android (where no app
/// reaches Quick Share's settings) is not asked.
#[tauri::command]
pub async fn pairing_open_receive_settings(
    #[allow(unused_variables)] app: AppHandle,
) -> CommandResult<()> {
    #[cfg(target_os = "macos")]
    {
        use tauri_plugin_opener::OpenerExt;
        /// Finder's AirDrop window, with "Allow me to be discovered by" at its foot.
        const AIRDROP_APP: &str =
            "/System/Library/CoreServices/Finder.app/Contents/Applications/AirDrop.app";
        /// System Settings → General → AirDrop & Handoff.
        const AIRDROP_SETTINGS: &str =
            "x-apple.systempreferences:com.apple.AirDrop-Handoff-Settings.extension";
        let opener = app.opener();
        let opened = if opener.open_path(AIRDROP_APP, None::<&str>).is_ok() {
            "the AirDrop window"
        } else if opener.open_url(AIRDROP_SETTINGS, None::<&str>).is_ok() {
            "AirDrop & Handoff settings"
        } else {
            let error = file_error(
                "Couldn't open AirDrop. Open Finder, choose AirDrop, and set who can discover this Mac.",
            );
            sync_log::failed("file: opening AirDrop", &error);
            return Err(error);
        };
        sync_log::note(&format!("file: opened {opened} for AirDrop visibility"));
    }
    #[cfg(windows)]
    {
        use tauri_plugin_opener::OpenerExt;
        /// Settings → System → Nearby sharing.
        const NEARBY_SHARING: &str = "ms-settings:crossdevice";
        app.opener()
            .open_url(NEARBY_SHARING, None::<&str>)
            .map_err(|_| {
                let error = file_error(
                    "Couldn't open Nearby sharing. Open Settings → System → Nearby sharing.",
                );
                sync_log::failed("file: opening Nearby sharing settings", &error);
                error
            })?;
        sync_log::note("file: opened Nearby sharing settings for Quick Share visibility");
    }
    Ok(())
}

/// The transfer file that arrived in Downloads since [`pairing_file_watch`], opened as a file
/// tapped in another app is. `None` while nothing new has arrived; a file that is not a transfer
/// file is skipped (and logged), so the watch goes on. One that opened is deleted.
#[tauri::command]
pub async fn pairing_file_poll(
    #[allow(unused_variables)] app: AppHandle,
    state: State<'_, Arc<AppState>>,
) -> CommandResult<Option<pairing::file_transfer::FilePreview>> {
    use pairing::file_transfer::{check, MAX_FILE_LEN, NOT_A_PAIRING_FILE};
    let shared = state.inner().clone();
    #[cfg(target_os = "ios")]
    let data_dir = {
        use tauri::Manager;
        app.path().app_data_dir().ok()
    };
    #[cfg(target_os = "ios")]
    let remove_data_dir = data_dir.clone();
    let found = tauri::async_runtime::spawn_blocking(move || {
        #[cfg(target_os = "ios")]
        let _scope = data_dir
            .as_deref()
            .and_then(crate::platform::ios_files::open_downloads_dir);
        let path = shared.pairing_incoming.lock().as_mut()?.next_ready()?;
        let bytes = read_capped(&path, MAX_FILE_LEN);
        Some((path, bytes))
    })
    .await
    .map_err(|_| file_error(FILE_READ_FAILED))?;
    let Some((path, read)) = found else {
        return Ok(None);
    };
    let bytes = match read {
        Ok(bytes) => bytes,
        Err(error) => {
            sync_log::failed("file: reading a file that arrived in Downloads", &error);
            return Ok(None);
        }
    };
    match check(&bytes) {
        Ok(()) => {}
        Err(error) if error == NOT_A_PAIRING_FILE => {
            sync_log::failed_text("file: a file that arrived in Downloads", &error);
            return Ok(None);
        }
        // An older or newer version's file: say so, it won't open here.
        Err(error) => {
            sync_log::failed_text("file: a file that arrived in Downloads", &error);
            return Err(file_error(error));
        }
    }
    let opened = open_received(state.inner(), bytes, PICKED_UP).await?;
    // The accounts are in memory now and the code is used up: the file is spent.
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(target_os = "ios")]
        let _scope = remove_data_dir
            .as_deref()
            .and_then(crate::platform::ios_files::open_downloads_dir);
        let _ = std::fs::remove_file(path);
    });
    Ok(Some(opened))
}

/// Receiver: imports the file that opened. `ticket` is the one opening it gave;
/// `accept_settings` is this device's own choice.
#[tauri::command]
pub async fn pairing_file_import(
    state: State<'_, Arc<AppState>>,
    ticket: String,
    accept_settings: bool,
) -> CommandResult<pairing::payload::SyncSummary> {
    let summary = pairing::file_transfer::import(state.inner(), &ticket, accept_settings)
        .await
        .map_err(|error| {
            sync_log::failed_text("file: importing the accounts", &error);
            file_error(error)
        })?;
    sync_log::note(&format!(
        "file: imported the accounts, {}",
        sync_log::describe_summary(&summary)
    ));
    Ok(summary)
}

pub static GLOBAL_APP_HANDLE: parking_lot::Mutex<Option<AppHandle>> = parking_lot::Mutex::new(None);

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::error::ErrorCode;

    #[test]
    fn only_a_search_that_found_no_one_is_not_found() {
        let found_no_one = join_error(pairing::discovery::NOT_FOUND.to_string());
        assert_eq!(found_no_one.code, ErrorCode::NotFound);
        assert!(found_no_one.message.contains("VPN"));
        for other in [
            pairing::discovery::OLDER_VERSION,
            pairing::discovery::INVALID_CODE,
            "mDNS unavailable: no network interface",
        ] {
            assert_ne!(
                join_error(other.to_string()).code,
                ErrorCode::NotFound,
                "{other}"
            );
        }
    }
}

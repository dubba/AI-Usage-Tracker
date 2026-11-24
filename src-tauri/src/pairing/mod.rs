pub mod airgap;
pub mod crypto;
pub mod discovery;
pub mod file_transfer;
pub mod incoming_files;
// Bonjour discovery for iOS; also built into macOS tests to check it
// interoperates with mdns-sd.
#[cfg(any(target_os = "ios", all(test, target_os = "macos")))]
pub mod dnssd;
pub mod payload;
pub mod protocol;
pub(crate) mod sync_log;
pub mod transport;

#[cfg(test)]
pub mod tests;

use crate::{
    commands::error::{CommandError, ErrorCode},
    pairing::{
        payload::SyncSummary,
        transport::{
            get_local_lan_ip, run_client_connector, run_host_listener, ClientEvent, HostEvent,
            HostSession, RoleChannels, SessionChannels, SESSION_TIMEOUT_SECS,
        },
    },
    state::AppState,
};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use std::{
    net::IpAddr,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::Emitter;
use tokio::{
    net::TcpListener,
    sync::{mpsc, oneshot, RwLock},
};
use uuid::Uuid;

const INTERRUPTED: &str =
    "Pairing session was interrupted. Please try starting the transfer again.";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "status", content = "data", rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS))]
pub enum PairingStatus {
    Idle,
    #[serde(rename_all = "camelCase")]
    HostWaiting {
        session_id: String,
        join_code: String,
        expires_at: u64,
    },
    #[serde(rename_all = "camelCase")]
    ClientConnecting {
        session_id: String,
    },
    #[serde(rename_all = "camelCase")]
    PeerConnected {
        session_id: String,
    },
    #[serde(rename_all = "camelCase")]
    RoleSelection {
        session_id: String,
    },
    /// Both devices proved they share the link code. The sending device asks its user to
    /// confirm; the receiving device waits.
    #[serde(rename_all = "camelCase")]
    ConfirmTransfer {
        session_id: String,
        #[cfg_attr(test, ts(type = r#""receiver" | "sender""#))]
        role: String,
        account_count: Option<usize>,
    },
    #[serde(rename_all = "camelCase")]
    Transferring {
        session_id: String,
    },
    #[serde(rename_all = "camelCase")]
    Completed {
        summary: SyncSummary,
    },
    #[serde(rename_all = "camelCase")]
    Failed {
        /// A sentence for the person: see [`failure`].
        error: CommandError,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct PairingHostInit {
    pub session_id: String,
    pub join_code: String,
    pub expires_at: u64,
}

/// What one pairing transfer carries beyond the accounts, chosen by the user for that transfer.
/// Everything defaults to "nothing extra" and goes back to it between transfers (`reset`).
/// Confirming the transfer freezes the choice, so a later write cannot change what it sends.
/// What the page shows when the link to the other device broke for a reason that is not one of
/// the sentences below.
pub(crate) const LINK_BROKE: &str =
    "The link to the other device broke. Keep both devices on this \
     screen and connected to the same Wi-Fi, then try again.";

/// A pairing failure as the page shows it. The sentences the pairing code writes for people
/// (`transport::WRONG_CODE` and the rest) are shown as written, with a code; anything else is
/// protocol detail (a frame, a handshake, a socket error), which goes to the log for Copy
/// Diagnostics while the page says the link broke.
pub(crate) fn failure(detail: String) -> CommandError {
    use transport::*;
    let code = match detail.as_str() {
        CANCELED_BY_USER
        | ROLE_SELECTION_CANCELED
        | DECLINED_HERE
        | OTHER_DEVICE_CANCELED
        | OTHER_DEVICE_DECLINED => ErrorCode::Cancelled,
        WRONG_CODE | TOO_MANY_WRONG_CODES | BAD_ADDRESS => ErrorCode::Invalid,
        NO_DEVICE => ErrorCode::NotFound,
        CONNECTION_REJECTED | ROLES_DISAGREE | SESSION_TIMED_OUT | MORE_ACCOUNTS_THAN_SHOWN => {
            ErrorCode::Pairing
        }
        _ => {
            crate::diagnostics::warn(&format!(
                "Pairing failed: {}",
                crate::diagnostics::redact(&detail)
            ));
            return CommandError::new(ErrorCode::Pairing, LINK_BROKE);
        }
    };
    CommandError::new(code, detail)
}

#[derive(Clone, Debug, Default)]
pub struct PairingTransferOptions {
    /// Also send the app settings, account order and alerts.
    pub include_settings: bool,
    /// This device's user agreed to take the settings, account order, alerts and layout a sender
    /// includes. Set when the session starts; without it an import keeps only the accounts.
    pub accept_incoming_settings: bool,
    /// The layout (localStorage snapshot) the frontend supplied for this transfer.
    pub pending_ui_state: Option<serde_json::Value>,
    /// Set once, when the user confirms the code. Export prefers this over the live fields.
    frozen: Option<FrozenExtras>,
}

#[derive(Clone, Debug)]
struct FrozenExtras {
    include_settings: bool,
    pending_ui_state: Option<serde_json::Value>,
}

impl PairingTransferOptions {
    /// Back to the defaults, so one transfer's choices never leak into the next.
    pub fn reset(&mut self) {
        *self = Self::default();
    }

    /// Remember the extras chosen at the moment the code is confirmed.
    /// A second call keeps the first snapshot.
    pub(crate) fn freeze(&mut self) {
        if self.frozen.is_none() {
            self.frozen = Some(FrozenExtras {
                include_settings: self.include_settings,
                pending_ui_state: self.pending_ui_state.clone(),
            });
        }
    }

    /// Drop a confirm-time snapshot so the next export reads the live fields.
    /// The air-gap dialog sets those fields itself, after its own confirmation.
    pub(crate) fn unfreeze(&mut self) {
        self.frozen = None;
    }

    /// What this transfer should send. A confirm-time snapshot wins over a later write.
    pub(crate) fn exported_extras(&self) -> (bool, Option<serde_json::Value>) {
        match &self.frozen {
            Some(frozen) => (frozen.include_settings, frozen.pending_ui_state.clone()),
            None => (self.include_settings, self.pending_ui_state.clone()),
        }
    }

    /// Forget this transfer's extras once its payload has been snapshotted.
    pub(crate) fn clear_after_export(&mut self) {
        self.include_settings = false;
        self.pending_ui_state = None;
        self.frozen = None;
    }
}

pub struct ActiveSession {
    pub session_id: String,
    pub cancel_tx: Option<oneshot::Sender<()>>,
    /// Installed when role selection starts. Absent until then, so an earlier answer is refused.
    pub role_select_tx: Option<oneshot::Sender<String>>,
    /// Installed when the transfer confirmation starts. Absent until then, so an earlier answer is refused.
    pub transfer_confirm_tx: Option<oneshot::Sender<bool>>,
    pub advertisement: Option<discovery::MdnsAdvertisement>,
    /// Whether a transfer file can be opened with this session's code (`file_transfer::open`).
    pub file_code: FileCode,
}

/// What a session's code can do for a transfer file.
pub enum FileCode {
    /// A joiner: it shows no code.
    NotShown,
    /// A six-digit code for an older version, too short to key a file.
    WifiOnly,
    /// A link code that has not opened a file yet.
    Ready(zeroize::Zeroizing<String>),
    /// A file opened with the code: one file per code.
    Used,
}

impl FileCode {
    fn for_code(code: &str) -> Self {
        if discovery::is_link_code(code) {
            Self::Ready(zeroize::Zeroizing::new(code.to_string()))
        } else {
            Self::WifiOnly
        }
    }
}

pub struct PairingSessionManager {
    status: Arc<RwLock<PairingStatus>>,
    active: Arc<RwLock<Option<ActiveSession>>>,
    epoch: AtomicU64,
}

impl Default for PairingSessionManager {
    fn default() -> Self {
        Self::new()
    }
}

impl PairingSessionManager {
    pub fn new() -> Self {
        Self {
            status: Arc::new(RwLock::new(PairingStatus::Idle)),
            active: Arc::new(RwLock::new(None)),
            epoch: AtomicU64::new(0),
        }
    }

    pub async fn get_status(&self) -> PairingStatus {
        self.status.read().await.clone()
    }

    /// Starts a new generation and returns it. A start installs its session
    /// only while the generation is still the one it began with.
    fn next_epoch(&self) -> u64 {
        self.epoch.fetch_add(1, Ordering::SeqCst) + 1
    }

    fn is_current(&self, epoch: u64) -> bool {
        self.epoch.load(Ordering::SeqCst) == epoch
    }

    pub async fn cancel(&self) {
        let mut active = self.active.write().await;
        // Under the session lock, so a start that is still discovering hosts
        // or binding its listener sees the cancel when it goes to install its
        // session, and gives up instead of starting after it (L-105).
        self.epoch.fetch_add(1, Ordering::SeqCst);
        if let Some(session) = active.take() {
            if let Some(cancel_tx) = session.cancel_tx {
                let _ = cancel_tx.send(());
            }
            if let Some(advertisement) = session.advertisement {
                advertisement.unregister();
            }
        }
        *self.status.write().await = PairingStatus::Idle;
    }

    pub async fn select_role(&self, role: &str) -> Result<(), String> {
        if role != "send" && role != "receive" {
            // A fixed sentence: the value comes from the page and is unbounded.
            return Err("Invalid role. Expected 'send' or 'receive'.".to_string());
        }
        let mut active = self.active.write().await;
        let Some(session) = active.as_mut() else {
            return Err("No active pairing session".into());
        };
        let Some(role_tx) = session.role_select_tx.take() else {
            return Err("Role selection already submitted or not in role selection state".into());
        };
        role_tx.send(role.to_string()).map_err(|_| {
            "This pairing session is no longer waiting for a choice. Start again.".to_string()
        })?;
        Ok(())
    }

    pub async fn confirm_transfer(
        &self,
        session_id: &str,
        confirmed: bool,
        options: &parking_lot::RwLock<PairingTransferOptions>,
    ) -> Result<(), String> {
        // Take the sender before touching the extras. A confirm that arrives
        // before this phase has no sender, and must not freeze a choice the
        // transfer will never use. The session lock is released before the
        // options lock: the settings command takes only the options lock.
        let confirm_tx = {
            let mut active = self.active.write().await;
            let Some(session) = active.as_mut() else {
                return Err("No active pairing session".into());
            };
            if session.session_id != session_id {
                return Err("Session ID mismatch".into());
            }
            let Some(confirm_tx) = session.transfer_confirm_tx.take() else {
                return Err("Confirmation already handled or not waiting for confirmation".into());
            };
            confirm_tx
        };
        if confirmed {
            options.write().freeze();
        }
        let _ = confirm_tx.send(confirmed);
        Ok(())
    }

    /// The code of the session showing it, for opening a transfer file: while it waits for the
    /// other device (not once a Wi-Fi transfer has started), if it is a link code not used yet.
    pub(crate) async fn file_code(&self) -> Result<zeroize::Zeroizing<String>, String> {
        let active = self.active.read().await;
        let Some(session) = active.as_ref() else {
            return Err(file_transfer::NO_CODE_SHOWN.into());
        };
        if !matches!(*self.status.read().await, PairingStatus::HostWaiting { .. }) {
            return Err(file_transfer::NO_CODE_SHOWN.into());
        }
        match &session.file_code {
            FileCode::Ready(code) => Ok(code.clone()),
            FileCode::NotShown => Err(file_transfer::NO_CODE_SHOWN.into()),
            FileCode::WifiOnly => Err(file_transfer::WIFI_ONLY_CODE.into()),
            FileCode::Used => Err(file_transfer::CODE_ALREADY_USED.into()),
        }
    }

    /// A file opened with `code`: uses the code up and ends the session, so the other device
    /// cannot also connect with it over Wi-Fi. Fails if the session moved on meanwhile.
    pub(crate) async fn use_file_code(&self, code: &str) -> Result<(), String> {
        {
            let mut active = self.active.write().await;
            let session = active
                .as_mut()
                .ok_or_else(|| file_transfer::NO_CODE_SHOWN.to_string())?;
            match &session.file_code {
                FileCode::Ready(shown) if shown.as_str() == code => {}
                FileCode::Ready(_) | FileCode::NotShown => {
                    return Err(file_transfer::NO_CODE_SHOWN.into())
                }
                FileCode::WifiOnly => return Err(file_transfer::WIFI_ONLY_CODE.into()),
                FileCode::Used => return Err(file_transfer::CODE_ALREADY_USED.into()),
            }
            session.file_code = FileCode::Used;
        }
        self.cancel().await;
        Ok(())
    }

    /// Publish the role answer channel once that phase is reached.
    /// A session that has moved on, or that already has a channel, drops `tx`
    /// so the waiter hears a disconnect and aborts.
    pub(crate) async fn offer_role_select(&self, session_id: &str, tx: oneshot::Sender<String>) {
        let mut active = self.active.write().await;
        if let Some(session) = active.as_mut() {
            if session.session_id == session_id && session.role_select_tx.is_none() {
                session.role_select_tx = Some(tx);
                return;
            }
        }
        drop(tx);
    }

    /// Publish the transfer-confirmation channel once that phase is reached.
    /// A session that has moved on, or that already has a channel, drops `tx`.
    pub(crate) async fn offer_transfer_confirm(&self, session_id: &str, tx: oneshot::Sender<bool>) {
        let mut active = self.active.write().await;
        if let Some(session) = active.as_mut() {
            if session.session_id == session_id && session.transfer_confirm_tx.is_none() {
                session.transfer_confirm_tx = Some(tx);
                return;
            }
        }
        drop(tx);
    }

    /// Starts hosting: shows a link code and waits for the device that types it, on the network
    /// or (a link code only) in a transfer file. `accept_settings` is this device's "Also Sync
    /// Settings and Layout" choice, used if it turns out to be the receiver. `legacy_code` shows
    /// six digits instead, for a device with an older version: Wi-Fi only.
    pub async fn start_host(
        &self,
        state: Arc<AppState>,
        accept_settings: bool,
        legacy_code: bool,
    ) -> Result<PairingHostInit, String> {
        self.cancel().await;
        // Reset per-transfer flags for the new session, so one transfer's
        // choices never carry into the next.
        {
            let mut options = state.pairing_options.write();
            options.reset();
            options.accept_incoming_settings = accept_settings;
        }
        let epoch = self.next_epoch();

        let session_id = Uuid::new_v4();
        let mut session_nonce = vec![0u8; 16];
        rand::rngs::OsRng.fill_bytes(&mut session_nonce);

        let (ip, listener, on_network) = bind_host_listener(get_local_lan_ip())
            .await
            .map_err(|e| format!("Failed to bind TCP listener: {e}"))?;
        let port = listener
            .local_addr()
            .map_err(|e| format!("Failed to get local port: {e}"))?
            .port();
        sync_log::note(if on_network {
            "link code: showing a code, listening on the local network"
        } else {
            "link code: showing a code, but this device has no local network address (Wi-Fi off or not connected); only a transfer file can use it"
        });

        // The link code is the pairing secret: it is shown on this screen and
        // typed on the other device, and never sent or announced.
        let join_code = if legacy_code {
            discovery::generate_legacy_code()
        } else {
            discovery::generate_link_code()
        };

        let expires_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs()
            + SESSION_TIMEOUT_SECS;

        let init = PairingHostInit {
            session_id: session_id.to_string(),
            join_code: join_code.clone(),
            expires_at,
        };

        let new_status = PairingStatus::HostWaiting {
            session_id: session_id.to_string(),
            join_code: join_code.clone(),
            expires_at,
        };

        let (cancel_tx, cancel_rx) = oneshot::channel();
        let (confirm_tx, confirm_rx) = oneshot::channel();
        let (status_tx, mut status_rx) = mpsc::channel(16);

        {
            // Checked and installed under the lock `cancel` takes, so a cancel
            // either lands before this check or cancels the installed session.
            let mut active = self.active.write().await;
            if !self.is_current(epoch) {
                // A concurrent start/cancel superseded this session. Never hand the
                // caller a code for a session that has no listener behind it.
                return Err(INTERRUPTED.to_string());
            }
            *self.status.write().await = new_status.clone();
            *active = Some(ActiveSession {
                session_id: session_id.to_string(),
                cancel_tx: Some(cancel_tx),
                role_select_tx: None,
                transfer_confirm_tx: None,
                advertisement: None,
                file_code: FileCode::for_code(&join_code),
            });
        }

        // mDNS advertise is best-effort and must not block returning the code:
        // ServiceDaemon::new() can hang on Android until multicast is ready.
        // A file-only session (no network address) is not announced at all.
        let advertise_ip = ip.clone();
        let advertise_nonce = session_nonce.clone();
        let advertise_active = self.active.clone();
        let advertise_sid = session_id.to_string();
        tokio::spawn(async move {
            if !on_network {
                return;
            }
            let advertised = tokio::task::spawn_blocking(move || {
                discovery::advertise(
                    &discovery::generate_instance_name(),
                    &advertise_ip,
                    port,
                    session_id,
                    &advertise_nonce,
                )
            })
            .await;
            // Logged either way: a code never announced and one announced but not heard look the
            // same from the other device ("not found").
            let adv = match advertised {
                Ok(Ok(adv)) => {
                    sync_log::note("link code: announced on the local network");
                    adv
                }
                Ok(Err(error)) => {
                    sync_log::failed_text("link code: announcing on the local network", &error);
                    return;
                }
                Err(_) => {
                    sync_log::failed_text(
                        "link code: announcing on the local network",
                        "the announcement task stopped",
                    );
                    return;
                }
            };
            let mut guard = advertise_active.write().await;
            match guard.as_mut() {
                Some(session) if session.session_id == advertise_sid => {
                    session.advertisement = Some(adv);
                }
                _ => adv.unregister(),
            }
        });

        let app_handle_opt = state.app_handle.read().clone();
        let state_for_listener = state.clone();

        // Spawn listener
        tokio::spawn(async move {
            run_host_listener(
                state_for_listener,
                HostSession {
                    session_id,
                    listener,
                    code: join_code,
                    session_nonce,
                },
                SessionChannels {
                    status_tx,
                    confirm_offer: Some(confirm_tx),
                    confirm_rx,
                    cancel_rx,
                },
            )
            .await;
        });

        // Spawn event handler
        let status_lock = self.status.clone();
        let active_lock = self.active.clone();
        let session_id_str = session_id.to_string();

        tokio::spawn(async move {
            while let Some(event) = status_rx.recv().await {
                let current_status = match event {
                    HostEvent::PeerConnected => PairingStatus::PeerConnected {
                        session_id: session_id_str.clone(),
                    },
                    HostEvent::ConfirmTransfer {
                        role,
                        account_count,
                    } => PairingStatus::ConfirmTransfer {
                        session_id: session_id_str.clone(),
                        role,
                        account_count: Some(account_count),
                    },
                    HostEvent::Transferring => PairingStatus::Transferring {
                        session_id: session_id_str.clone(),
                    },
                    HostEvent::Completed(summary) => PairingStatus::Completed { summary },
                    HostEvent::Cancelled => PairingStatus::Idle,
                    HostEvent::Expired => PairingStatus::Failed {
                        error: failure(transport::SESSION_TIMED_OUT.into()),
                    },
                    HostEvent::Failed(err) => PairingStatus::Failed {
                        error: failure(err),
                    },
                };

                *status_lock.write().await = current_status.clone();
                sync_log::status(sync_log::Side::Showing, &current_status);

                if let Some(app_handle) = &app_handle_opt {
                    let _ = app_handle.emit("pairing-status", &current_status);
                }

                match &current_status {
                    PairingStatus::Completed { .. }
                    | PairingStatus::Failed { .. }
                    | PairingStatus::Idle => {
                        crate::platform::lan_binding::configure_pairing_network(false);
                        let mut act = active_lock.write().await;
                        if act.as_ref().map(|s| &s.session_id) == Some(&session_id_str) {
                            if let Some(session) = act.take() {
                                if let Some(advertisement) = session.advertisement {
                                    advertisement.unregister();
                                }
                            }
                        }
                        break;
                    }
                    _ => {}
                }
            }
        });

        Ok(init)
    }

    /// Joins the device showing `code`: finds the pairing hosts on the network and tries the
    /// code against them. `accept_settings` is this device's "Also Sync Settings and Layout"
    /// choice, used if it turns out to be the receiver.
    pub async fn start_client_by_code(
        &self,
        state: Arc<AppState>,
        code: String,
        accept_settings: bool,
    ) -> Result<(), String> {
        let code = discovery::normalize_code(&code);
        if !discovery::is_valid_join_code(&code) {
            return Err(discovery::INVALID_CODE.into());
        }

        self.cancel().await;
        {
            let mut options = state.pairing_options.write();
            options.reset();
            options.accept_incoming_settings = accept_settings;
        }
        let epoch = self.next_epoch();

        // How long the search took goes in the log: a device found late is the one the file
        // route must not cut off.
        let started = std::time::Instant::now();
        let hosts = match discovery::discover().await {
            Ok(hosts) => hosts,
            Err(error) => {
                sync_log::failed_text(
                    &format!(
                        "link code: looking for the other device for {:.1} s",
                        started.elapsed().as_secs_f32()
                    ),
                    &error,
                );
                return Err(error);
            }
        };
        sync_log::note(&format!(
            "link code: entered a code, found {} device(s) showing a code on the network in {:.1} s",
            hosts.len(),
            started.elapsed().as_secs_f32()
        ));
        self.start_client(state, hosts, code, epoch).await
    }

    /// Runs the joining side against `hosts`. The session id is this device's own: the hosts'
    /// ids are theirs, and which host shares the code is not known yet.
    pub(crate) async fn start_client(
        &self,
        state: Arc<AppState>,
        hosts: Vec<protocol::DiscoveredHost>,
        code: String,
        epoch: u64,
    ) -> Result<(), String> {
        let session_id_str = Uuid::new_v4().to_string();

        let (cancel_tx, cancel_rx) = oneshot::channel();
        let (role_select_tx, role_select_rx) = oneshot::channel();
        let (confirm_tx, confirm_rx) = oneshot::channel();
        let (status_tx, mut status_rx) = mpsc::channel(16);

        {
            // A cancel during discovery moved the generation on: stop here,
            // before any status, session, or connection exists (L-105).
            let mut active = self.active.write().await;
            if !self.is_current(epoch) {
                return Err(INTERRUPTED.to_string());
            }
            *self.status.write().await = PairingStatus::ClientConnecting {
                session_id: session_id_str.clone(),
            };
            *active = Some(ActiveSession {
                session_id: session_id_str.clone(),
                cancel_tx: Some(cancel_tx),
                role_select_tx: None,
                transfer_confirm_tx: None,
                advertisement: None,
                file_code: FileCode::NotShown,
            });
        }

        let app_handle_opt = state.app_handle.read().clone();
        let state_for_client = state.clone();

        // Spawn client connector
        let sid = session_id_str.clone();
        tokio::spawn(async move {
            run_client_connector(
                state_for_client,
                session_id_str,
                hosts,
                code,
                SessionChannels {
                    status_tx,
                    confirm_offer: Some(confirm_tx),
                    confirm_rx,
                    cancel_rx,
                },
                RoleChannels {
                    role_offer: Some(role_select_tx),
                    role_select_rx,
                },
            )
            .await;
        });

        // Spawn event handler
        let status_lock = self.status.clone();
        let active_lock = self.active.clone();

        tokio::spawn(async move {
            while let Some(event) = status_rx.recv().await {
                let current_status = match event {
                    ClientEvent::RoleSelection => PairingStatus::RoleSelection {
                        session_id: sid.clone(),
                    },
                    ClientEvent::ConfirmTransfer {
                        role,
                        account_count,
                    } => PairingStatus::ConfirmTransfer {
                        session_id: sid.clone(),
                        role,
                        account_count: Some(account_count),
                    },
                    ClientEvent::Transferring => PairingStatus::Transferring {
                        session_id: sid.clone(),
                    },
                    ClientEvent::Completed(summary) => PairingStatus::Completed { summary },
                    ClientEvent::Cancelled => PairingStatus::Idle,
                    ClientEvent::Failed(err) => PairingStatus::Failed {
                        error: failure(err),
                    },
                };

                *status_lock.write().await = current_status.clone();
                sync_log::status(sync_log::Side::Entering, &current_status);

                if let Some(app_handle) = &app_handle_opt {
                    let _ = app_handle.emit("pairing-status", &current_status);
                }

                match &current_status {
                    PairingStatus::Completed { .. }
                    | PairingStatus::Failed { .. }
                    | PairingStatus::Idle => {
                        crate::platform::lan_binding::configure_pairing_network(false);
                        let mut act = active_lock.write().await;
                        if act.as_ref().map(|s| &s.session_id) == Some(&sid) {
                            *act = None;
                        }
                        break;
                    }
                    _ => {}
                }
            }
        });
        Ok(())
    }

    /// Begins a generation the way a start does, for tests of cancel races.
    #[cfg(test)]
    pub(crate) fn testing_begin_start(&self) -> u64 {
        self.next_epoch()
    }

    /// An open session with neither answer channel installed, for tests of the phase gate.
    #[cfg(test)]
    pub(crate) async fn testing_open_session(&self, session_id: &str) {
        *self.active.write().await = Some(ActiveSession {
            session_id: session_id.to_string(),
            cancel_tx: None,
            role_select_tx: None,
            transfer_confirm_tx: None,
            advertisement: None,
            file_code: FileCode::NotShown,
        });
    }

    /// A host session showing `code`, with no listener behind it, for tests of the file route.
    #[cfg(test)]
    pub(crate) async fn testing_show_code(&self, code: &str) {
        let session_id = Uuid::new_v4().to_string();
        *self.status.write().await = PairingStatus::HostWaiting {
            session_id: session_id.clone(),
            join_code: code.to_string(),
            expires_at: 0,
        };
        *self.active.write().await = Some(ActiveSession {
            session_id,
            cancel_tx: None,
            role_select_tx: None,
            transfer_confirm_tx: None,
            advertisement: None,
            file_code: FileCode::for_code(code),
        });
    }
}

/// Binds the host listener to the address the mDNS record advertises, and
/// only if that is a local-network address: private, link-local, CGNAT, or
/// loopback, the same rule joiners apply to the hosts they find.
/// There is no fallback to all interfaces. A public address, or one that
/// cannot be bound (it vanished since we read it), fails host mode with an
/// explanation instead of exposing the listener beyond the local network for
/// the life of the session.
/// The host's listener and the address it is on; `false` when this device has no local-network
/// address (Wi-Fi off, on a carrier that gives no private address). The session then listens on
/// loopback, which no other device can reach, and is not announced: the link code still works
/// for a transfer file (`file_transfer`), and the expiry, cancel and wrong-code limit run as usual.
pub(crate) async fn bind_host_listener(ip: String) -> std::io::Result<(String, TcpListener, bool)> {
    match bind_pairing_listener(&ip).await {
        Ok(listener) => Ok((ip, listener, true)),
        Err(e) if e.kind() == std::io::ErrorKind::AddrNotAvailable => {
            const LOOPBACK: &str = "127.0.0.1";
            let listener = bind_pairing_listener(LOOPBACK).await?;
            Ok((LOOPBACK.to_string(), listener, false))
        }
        Err(e) => Err(e),
    }
}

pub(crate) async fn bind_pairing_listener(ip: &str) -> std::io::Result<TcpListener> {
    let addr = ip
        .parse::<IpAddr>()
        .ok()
        .filter(|_| protocol::is_allowed_pairing_host(ip))
        .ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::AddrNotAvailable,
                "this device has no local network address to pair on; connect to Wi-Fi and try again",
            )
        })?;
    TcpListener::bind((addr, 0)).await
}

pub mod airgap;
pub mod crypto;
pub mod discovery;
// Bonjour discovery for iOS; also built into macOS tests to check it
// interoperates with mdns-sd.
#[cfg(any(target_os = "ios", all(test, target_os = "macos")))]
pub mod dnssd;
pub mod payload;
pub mod protocol;
pub mod transport;

#[cfg(test)]
pub mod tests;

use crate::{
    pairing::{
        payload::SyncSummary,
        transport::{
            get_local_lan_ip, run_client_connector, run_host_listener, ClientEvent, HostEvent,
            SESSION_TIMEOUT_SECS,
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "status", content = "data", rename_all = "camelCase")]
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
        role: String, // "receiver" | "sender"
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
        error: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingHostInit {
    pub session_id: String,
    pub join_code: String,
    pub expires_at: u64,
}

/// What one pairing transfer carries beyond the accounts, chosen by the user for that transfer.
/// Everything defaults to "nothing extra" and goes back to it between transfers (`reset`).
/// Confirming the transfer freezes the choice, so a later write cannot change what it sends.
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

    pub async fn cancel(&self) {
        let mut active = self.active.write().await;
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

    /// Starts hosting: shows a link code and waits for the device that types it.
    /// `accept_settings` is this device's "Also Transfer Settings & Layout" choice, used if it
    /// turns out to be the receiver.
    pub async fn start_host(
        &self,
        state: Arc<AppState>,
        accept_settings: bool,
    ) -> Result<PairingHostInit, String> {
        self.cancel().await;
        // Reset per-transfer flags for the new session, so one transfer's
        // choices never carry into the next.
        {
            let mut options = state.pairing_options.write();
            options.reset();
            options.accept_incoming_settings = accept_settings;
        }
        let epoch = self.epoch.fetch_add(1, Ordering::SeqCst) + 1;

        let session_id = Uuid::new_v4();
        let mut session_nonce = vec![0u8; 16];
        rand::rngs::OsRng.fill_bytes(&mut session_nonce);

        let ip = get_local_lan_ip();
        let listener = bind_pairing_listener(&ip)
            .await
            .map_err(|e| format!("Failed to bind TCP listener: {e}"))?;
        let port = listener
            .local_addr()
            .map_err(|e| format!("Failed to get local port: {e}"))?
            .port();

        // The link code is the pairing secret: it is shown on this screen and
        // typed on the other device, and never sent or announced.
        let join_code = discovery::generate_join_code();

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

        if self.epoch.load(Ordering::SeqCst) != epoch {
            // A concurrent start/cancel superseded this session. Never hand the
            // caller a code for a session that has no listener behind it.
            return Err(
                "Pairing session was interrupted. Please try starting the transfer again."
                    .to_string(),
            );
        }

        *self.status.write().await = new_status.clone();

        let (cancel_tx, cancel_rx) = oneshot::channel();
        let (confirm_tx, confirm_rx) = oneshot::channel();
        let (status_tx, mut status_rx) = mpsc::channel(16);

        *self.active.write().await = Some(ActiveSession {
            session_id: session_id.to_string(),
            cancel_tx: Some(cancel_tx),
            role_select_tx: None,
            transfer_confirm_tx: None,
            advertisement: None,
        });

        // mDNS advertise is best-effort and must not block returning the code:
        // ServiceDaemon::new() can hang on Android until multicast is ready.
        let advertise_ip = ip.clone();
        let advertise_nonce = session_nonce.clone();
        let advertise_active = self.active.clone();
        let advertise_sid = session_id.to_string();
        tokio::spawn(async move {
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
            let Ok(Ok(adv)) = advertised else {
                return;
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
                session_id,
                listener,
                join_code,
                session_nonce,
                status_tx,
                Some(confirm_tx),
                confirm_rx,
                cancel_rx,
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
                        error: "Pairing session timed out".into(),
                    },
                    HostEvent::Failed(err) => PairingStatus::Failed { error: err },
                };

                *status_lock.write().await = current_status.clone();

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
    /// code against them. `accept_settings` is this device's "Also Transfer Settings & Layout"
    /// choice, used if it turns out to be the receiver.
    pub async fn start_client_by_code(
        &self,
        state: Arc<AppState>,
        code: String,
        accept_settings: bool,
    ) -> Result<(), String> {
        let code = code.trim().to_string();
        if !discovery::is_valid_join_code(&code) {
            return Err("Enter the 6-digit code shown on the other device.".into());
        }

        self.cancel().await;
        {
            let mut options = state.pairing_options.write();
            options.reset();
            options.accept_incoming_settings = accept_settings;
        }
        let epoch = self.epoch.fetch_add(1, Ordering::SeqCst) + 1;

        let hosts = discovery::discover().await?;
        if self.epoch.load(Ordering::SeqCst) != epoch {
            return Err(
                "Pairing session was interrupted. Please try starting the transfer again."
                    .to_string(),
            );
        }
        self.start_client(state, hosts, code).await;
        Ok(())
    }

    /// Runs the joining side against `hosts`. The session id is this device's own: the hosts'
    /// ids are theirs, and which host shares the code is not known yet.
    pub(crate) async fn start_client(
        &self,
        state: Arc<AppState>,
        hosts: Vec<protocol::DiscoveredHost>,
        code: String,
    ) {
        let session_id_str = Uuid::new_v4().to_string();

        let (cancel_tx, cancel_rx) = oneshot::channel();
        let (role_select_tx, role_select_rx) = oneshot::channel();
        let (confirm_tx, confirm_rx) = oneshot::channel();
        let (status_tx, mut status_rx) = mpsc::channel(16);

        *self.status.write().await = PairingStatus::ClientConnecting {
            session_id: session_id_str.clone(),
        };

        *self.active.write().await = Some(ActiveSession {
            session_id: session_id_str.clone(),
            cancel_tx: Some(cancel_tx),
            role_select_tx: None,
            transfer_confirm_tx: None,
            advertisement: None,
        });

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
                status_tx,
                Some(role_select_tx),
                role_select_rx,
                Some(confirm_tx),
                confirm_rx,
                cancel_rx,
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
                    ClientEvent::Failed(err) => PairingStatus::Failed { error: err },
                };

                *status_lock.write().await = current_status.clone();

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

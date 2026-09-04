pub mod crypto;
pub mod discovery;
pub mod payload;
pub mod protocol;
pub mod transport;

#[cfg(test)]
pub mod tests;

use crate::{
    pairing::{
        crypto::EphemeralKeyPair,
        payload::SyncSummary,
        protocol::{compute_display_fingerprint, generate_qr_uri, parse_qr_uri},
        transport::{
            generate_qr_svg, get_local_lan_ip, run_client_connector, run_host_listener,
            ClientEvent, HostEvent, SESSION_TIMEOUT_SECS,
        },
    },
    state::AppState,
};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
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
    #[serde(rename_all = "camelCase", alias = "receiverWaiting")]
    HostWaiting {
        session_id: String,
        qr_svg: String,
        qr_uri: String,
        fingerprint: String,
        join_code: String,
        expires_at: u64,
    },
    #[serde(rename_all = "camelCase", alias = "senderConnecting")]
    ClientConnecting {
        session_id: String,
    },
    #[serde(rename_all = "camelCase")]
    PeerConnected {
        session_id: String,
        fingerprint: String,
        sas_code: String,
    },
    #[serde(rename_all = "camelCase")]
    RoleSelection {
        session_id: String,
        fingerprint: String,
        sas_code: String,
    },
    #[serde(rename_all = "camelCase")]
    SasVerification {
        session_id: String,
        sas_code: String,
        fingerprint: String,
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
    pub qr_svg: String,
    pub qr_uri: String,
    pub fingerprint: String,
    pub join_code: String,
    pub expires_at: u64,
}

pub type PairingReceiverInit = PairingHostInit;

pub struct ActiveSession {
    pub session_id: String,
    pub cancel_tx: Option<oneshot::Sender<()>>,
    pub role_select_tx: Option<oneshot::Sender<String>>,
    pub sas_confirm_tx: Option<oneshot::Sender<bool>>,
    pub advertisement: Option<discovery::MdnsAdvertisement>,
}

pub struct PairingSessionManager {
    status: Arc<RwLock<PairingStatus>>,
    active: Arc<RwLock<Option<ActiveSession>>>,
    /// Failed join-by-code lookups. The 6-digit code is a discovery handle,
    /// not a secret; this only slows LAN brute-force of advertised names.
    join_attempts: Arc<RwLock<HashMap<String, u8>>>,
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
            join_attempts: Arc::new(RwLock::new(HashMap::new())),
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

    pub async fn confirm_sas(&self, session_id: &str, confirmed: bool) -> Result<(), String> {
        let mut active = self.active.write().await;
        let Some(session) = active.as_mut() else {
            return Err("No active pairing session".into());
        };
        if session.session_id != session_id {
            return Err("Session ID mismatch".into());
        }
        let Some(confirm_tx) = session.sas_confirm_tx.take() else {
            return Err("Confirmation already handled or not waiting for SAS confirmation".into());
        };
        let _ = confirm_tx.send(confirmed);
        Ok(())
    }

    pub async fn start_host(&self, state: Arc<AppState>) -> Result<PairingHostInit, String> {
        self.cancel().await;
        let epoch = self.epoch.fetch_add(1, Ordering::SeqCst) + 1;

        let keypair = EphemeralKeyPair::generate();
        let session_id = Uuid::new_v4();
        let mut session_nonce = vec![0u8; 16];
        rand::thread_rng().fill_bytes(&mut session_nonce);

        let ip = get_local_lan_ip();
        let listener = TcpListener::bind("0.0.0.0:0")
            .await
            .map_err(|e| format!("Failed to bind TCP listener: {e}"))?;
        let port = listener
            .local_addr()
            .map_err(|e| format!("Failed to get local port: {e}"))?
            .port();

        let fingerprint = compute_display_fingerprint(
            &session_id,
            &keypair.public_bytes(),
            &session_nonce,
        );

        let qr_uri =
            generate_qr_uri(&ip, port, &keypair.public_bytes(), session_id, &session_nonce);
        let qr_svg = generate_qr_svg(&qr_uri)?;

        // Join code is generated immediately so the UI can render. mDNS
        // advertise is best-effort and must not block returning the QR/code —
        // ServiceDaemon::new() can hang on Android until multicast is ready.
        let join_code = discovery::generate_join_code();

        let expires_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs()
            + SESSION_TIMEOUT_SECS;

        let init = PairingHostInit {
            session_id: session_id.to_string(),
            qr_svg: qr_svg.clone(),
            qr_uri: qr_uri.clone(),
            fingerprint: fingerprint.clone(),
            join_code: join_code.clone(),
            expires_at,
        };

        let new_status = PairingStatus::HostWaiting {
            session_id: session_id.to_string(),
            qr_svg,
            qr_uri,
            fingerprint: fingerprint.clone(),
            join_code: join_code.clone(),
            expires_at,
        };

        if self.epoch.load(Ordering::SeqCst) != epoch {
            return Ok(init);
        }

        *self.status.write().await = new_status.clone();

        let (cancel_tx, cancel_rx) = oneshot::channel();
        let (sas_confirm_tx, sas_confirm_rx) = oneshot::channel();
        let (status_tx, mut status_rx) = mpsc::channel(16);

        *self.active.write().await = Some(ActiveSession {
            session_id: session_id.to_string(),
            cancel_tx: Some(cancel_tx),
            role_select_tx: None,
            sas_confirm_tx: Some(sas_confirm_tx),
            advertisement: None,
        });

        let advertise_ip = ip.clone();
        let advertise_pk = keypair.public_bytes();
        let advertise_nonce = session_nonce.clone();
        let advertise_active = self.active.clone();
        let advertise_sid = session_id.to_string();
        tokio::spawn(async move {
            let advertised = tokio::task::spawn_blocking(move || {
                discovery::advertise(
                    &join_code,
                    &advertise_ip,
                    port,
                    session_id,
                    &advertise_pk,
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
        let fp_clone = fingerprint.clone();

        // Spawn listener
        tokio::spawn(async move {
            run_host_listener(
                state_for_listener,
                session_id,
                listener,
                keypair,
                session_nonce,
                fp_clone,
                status_tx,
                sas_confirm_rx,
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
                    HostEvent::Connected(_) => continue, // Followed by PeerConnected
                    HostEvent::PeerConnected {
                        sas_code,
                        fingerprint,
                    } => PairingStatus::PeerConnected {
                        session_id: session_id_str.clone(),
                        sas_code,
                        fingerprint,
                    },
                    HostEvent::SasVerification {
                        sas_code,
                        fingerprint,
                        role,
                        account_count,
                    } => PairingStatus::SasVerification {
                        session_id: session_id_str.clone(),
                        sas_code,
                        fingerprint,
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

    pub async fn start_receiver(
        &self,
        state: Arc<AppState>,
    ) -> Result<PairingReceiverInit, String> {
        self.start_host(state).await
    }

    pub async fn start_client(&self, state: Arc<AppState>, qr_uri: String) -> Result<(), String> {
        self.cancel().await;
        self.epoch.fetch_add(1, Ordering::SeqCst);

        let parsed = parse_qr_uri(&qr_uri)?;
        let session_id_str = parsed.session_id.to_string();

        let (cancel_tx, cancel_rx) = oneshot::channel();
        let (role_select_tx, role_select_rx) = oneshot::channel();
        let (sas_confirm_tx, sas_confirm_rx) = oneshot::channel();
        let (status_tx, mut status_rx) = mpsc::channel(16);

        *self.status.write().await = PairingStatus::ClientConnecting {
            session_id: session_id_str.clone(),
        };

        *self.active.write().await = Some(ActiveSession {
            session_id: session_id_str.clone(),
            cancel_tx: Some(cancel_tx),
            role_select_tx: Some(role_select_tx),
            sas_confirm_tx: Some(sas_confirm_tx),
            advertisement: None,
        });

        let app_handle_opt = state.app_handle.read().clone();
        let state_for_client = state.clone();

        // Spawn client connector
        let sid = session_id_str.clone();
        tokio::spawn(async move {
            run_client_connector(
                state_for_client,
                parsed,
                status_tx,
                role_select_rx,
                sas_confirm_rx,
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
                    ClientEvent::Connected { .. } => continue, // Followed by RoleSelection
                    ClientEvent::RoleSelection {
                        sas_code,
                        fingerprint,
                    } => PairingStatus::RoleSelection {
                        session_id: sid.clone(),
                        sas_code,
                        fingerprint,
                    },
                    ClientEvent::SasVerification {
                        sas_code,
                        fingerprint,
                        role,
                        account_count,
                    } => PairingStatus::SasVerification {
                        session_id: sid.clone(),
                        sas_code,
                        fingerprint,
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

    pub async fn start_sender(&self, state: Arc<AppState>, qr_uri: String) -> Result<(), String> {
        self.start_client(state, qr_uri).await
    }

    pub async fn start_client_by_code(
        &self,
        state: Arc<AppState>,
        code: String,
    ) -> Result<(), String> {
        let code = code.trim().to_string();
        if !discovery::is_valid_join_code(&code) {
            return Err("Enter the 6-digit code shown on the other device.".into());
        }

        {
            let attempts = self.join_attempts.read().await;
            if attempts.get(&code).copied().unwrap_or(0) >= discovery::MAX_JOIN_ATTEMPTS {
                return Err(
                    "Too many attempts for this code. Ask the other device to start a new pairing session."
                        .into(),
                );
            }
        }

        match discovery::resolve(&code).await {
            Ok(parsed) => {
                self.join_attempts.write().await.remove(&code);
                self.start_client(state, parsed.to_uri()).await
            }
            Err(err) => {
                let mut attempts = self.join_attempts.write().await;
                *attempts.entry(code).or_insert(0) += 1;
                Err(err)
            }
        }
    }
}

use crate::{
    pairing::{
        crypto::{
            build_transcript, compute_confirmation_tag, compute_sas_code, decrypt_payload,
            encrypt_payload, verify_confirmation_tag, EphemeralKeyPair, CONFIRM_RECEIVER_INFO,
            CONFIRM_SENDER_INFO,
        },
        payload::{create_export_payload, import_sync_payload, SyncSummary},
        protocol::{
            read_frame, write_frame, ParsedQrPayload, MSG_ABORT, MSG_ACK, MSG_ENCRYPTED_PAYLOAD,
            MSG_HANDSHAKE_INIT, MSG_HANDSHAKE_RESP, MSG_ROLE_SELECT, MSG_ROLE_SELECT_RESP,
            MSG_SAS_CONFIRM,
        },
    },
    state::AppState,
};
use qrcode::{render::svg, QrCode};
use std::{
    net::UdpSocket,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::{
    io::AsyncWriteExt,
    net::{TcpListener, TcpStream},
    sync::{mpsc, oneshot},
    time::timeout,
};
use uuid::Uuid;
use zeroize::Zeroize;

pub const SESSION_TIMEOUT_SECS: u64 = 300; // 5 minutes
pub const SOCKET_TIMEOUT_SECS: u64 = 30; // 30 seconds
const MAX_FAILED_HANDSHAKES: u8 = 5;

pub fn get_local_lan_ip() -> String {
    if let Ok(interfaces) = if_addrs::get_if_addrs() {
        for iface in &interfaces {
            if !iface.is_loopback() {
                if let std::net::IpAddr::V4(ipv4) = iface.addr.ip() {
                    let octets = ipv4.octets();
                    let is_cgnat_tailscale =
                        octets[0] == 100 && (octets[1] >= 64 && octets[1] <= 127);
                    if !is_cgnat_tailscale
                        && ((octets[0] == 192 && octets[1] == 168)
                            || octets[0] == 10
                            || (octets[0] == 172 && (16..=31).contains(&octets[1])))
                    {
                        return ipv4.to_string();
                    }
                }
            }
        }
        for iface in &interfaces {
            if !iface.is_loopback() {
                if let std::net::IpAddr::V4(ipv4) = iface.addr.ip() {
                    let octets = ipv4.octets();
                    let is_cgnat_tailscale =
                        octets[0] == 100 && (octets[1] >= 64 && octets[1] <= 127);
                    if !ipv4.is_link_local() && !is_cgnat_tailscale {
                        return ipv4.to_string();
                    }
                }
            }
        }
    }
    if let Ok(socket) = UdpSocket::bind("0.0.0.0:0") {
        if socket.connect("8.8.8.8:80").is_ok() {
            if let Ok(addr) = socket.local_addr() {
                let ip = addr.ip();
                if !ip.is_loopback() && !ip.is_unspecified() {
                    return ip.to_string();
                }
            }
        }
    }
    "127.0.0.1".to_string()
}

pub fn generate_qr_svg(uri: &str) -> Result<String, String> {
    let code = QrCode::new(uri.as_bytes()).map_err(|e| format!("QR Code generation error: {e}"))?;
    let image = code
        .render::<svg::Color>()
        .min_dimensions(240, 240)
        .dark_color(svg::Color("#000000"))
        .light_color(svg::Color("#ffffff"))
        .build();
    Ok(image)
}

#[derive(Debug, Clone)]
pub enum HostEvent {
    #[allow(dead_code)]
    Connected(String),
    PeerConnected {
        sas_code: String,
        fingerprint: String,
    },
    SasVerification {
        sas_code: String,
        fingerprint: String,
        role: String, // "sender" | "receiver"
        account_count: usize,
    },
    Transferring,
    Completed(SyncSummary),
    Cancelled,
    Expired,
    Failed(String),
}

#[allow(dead_code)]
pub type ReceiverEvent = HostEvent;

#[derive(Debug, Clone)]
pub enum ClientEvent {
    #[allow(dead_code)]
    Connected {
        sas_code: String,
        fingerprint: String,
        account_count: usize,
    },
    RoleSelection {
        sas_code: String,
        fingerprint: String,
    },
    SasVerification {
        sas_code: String,
        fingerprint: String,
        role: String, // "sender" | "receiver"
        account_count: usize,
    },
    Transferring,
    Completed(SyncSummary),
    Cancelled,
    Failed(String),
}

#[allow(dead_code)]
pub type SenderEvent = ClientEvent;

/// Runs the host listener loop (displays QR code, accepts incoming peer connection)
pub async fn run_host_listener(
    state: Arc<AppState>,
    session_id: Uuid,
    listener: TcpListener,
    keypair: EphemeralKeyPair,
    session_nonce: Vec<u8>,
    fingerprint: String,
    status_tx: mpsc::Sender<HostEvent>,
    sas_confirm_rx: oneshot::Receiver<bool>,
    mut cancel_rx: oneshot::Receiver<()>,
) {
    let host_pubkey = keypair.public_bytes();
    let session_id_bytes = *session_id.as_bytes();
    let deadline = Instant::now() + Duration::from_secs(SESSION_TIMEOUT_SECS);
    let mut failed_handshakes = 0u8;

    let (mut stream, client_pubkey) = loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            let _ = status_tx.send(HostEvent::Expired).await;
            return;
        }

        let accepted = tokio::select! {
            _ = &mut cancel_rx => {
                let _ = status_tx.send(HostEvent::Cancelled).await;
                return;
            }
            res = timeout(remaining, listener.accept()) => {
                match res {
                    Ok(Ok((stream, _))) => stream,
                    Ok(Err(e)) => {
                        let _ = status_tx.send(HostEvent::Failed(format!("Socket accept error: {e}"))).await;
                        return;
                    }
                    Err(_) => {
                        let _ = status_tx.send(HostEvent::Expired).await;
                        return;
                    }
                }
            }
        };

        let mut stream = accepted;
        let handshake_res: Result<Result<[u8; 32], String>, _> =
            timeout(Duration::from_secs(SOCKET_TIMEOUT_SECS), async {
                let (msg_type, payload) = read_frame(&mut stream).await?;
                if msg_type != MSG_HANDSHAKE_INIT {
                    return Err("Expected MSG_HANDSHAKE_INIT".into());
                }
                if payload.len() != 48 {
                    return Err(format!("Invalid handshake length: {}", payload.len()));
                }

                let mut client_pubkey = [0u8; 32];
                client_pubkey.copy_from_slice(&payload[..32]);

                let mut received_session_id = [0u8; 16];
                received_session_id.copy_from_slice(&payload[32..48]);

                if received_session_id != session_id_bytes {
                    return Err("Session ID mismatch".into());
                }

                Ok(client_pubkey)
            })
            .await;

        match handshake_res {
            Ok(Ok(pk)) => break (stream, pk),
            Ok(Err(_)) | Err(_) => {
                let _ = write_frame(&mut stream, MSG_ABORT, &[0x01]).await;
                failed_handshakes += 1;
                if failed_handshakes >= MAX_FAILED_HANDSHAKES {
                    let _ = status_tx
                        .send(HostEvent::Failed(
                            "Too many failed pairing attempts. Start a new session.".into(),
                        ))
                        .await;
                    return;
                }
            }
        }
    };

    // Perform DH and key derivation
    let client_point = x25519_dalek::PublicKey::from(client_pubkey);
    let derived = keypair.diffie_hellman(&client_point);
    let mut encryption_key = match derived.derive_encryption_key(&session_nonce) {
        Ok(k) => k,
        Err(e) => {
            let _ = write_frame(&mut stream, MSG_ABORT, &[0x03]).await;
            let _ = status_tx.send(HostEvent::Failed(e)).await;
            return;
        }
    };

    let transcript = build_transcript(
        &session_id_bytes,
        &session_nonce,
        &host_pubkey,
        &client_pubkey,
    );

    let sas_code = compute_sas_code(&encryption_key, &transcript);

    // Send Handshake OK response
    if let Err(e) = write_frame(&mut stream, MSG_HANDSHAKE_RESP, &[0x00]).await {
        let _ = status_tx.send(HostEvent::Failed(e)).await;
        encryption_key.zeroize();
        return;
    }

    // Emit Connected events for backward-compat and peer connection status
    let _ = status_tx.send(HostEvent::Connected(sas_code.clone())).await;
    let _ = status_tx
        .send(HostEvent::PeerConnected {
            sas_code: sas_code.clone(),
            fingerprint: fingerprint.clone(),
        })
        .await;

    // Wait for the joiner to pick send/receive. This is a user action, so it
    // uses the session timeout rather than the short socket timeout.
    let role_res: Result<Result<(bool, usize), String>, _> =
        timeout(Duration::from_secs(SESSION_TIMEOUT_SECS), async {
            let (msg_type, payload) = read_frame(&mut stream).await?;
            if msg_type != MSG_ROLE_SELECT {
                return Err("Expected MSG_ROLE_SELECT".into());
            }
            if payload.is_empty() {
                return Err("Empty role selection payload".into());
            }

            match payload[0] {
                0x01 => {
                    // Client selected "Send accounts from this device" -> Host is Receiver
                    let count = if payload.len() >= 3 {
                        u16::from_be_bytes([payload[1], payload[2]]) as usize
                    } else {
                        0
                    };
                    write_frame(&mut stream, MSG_ROLE_SELECT_RESP, &[0x00]).await?;
                    Ok((false, count))
                }
                0x02 => {
                    // Client selected "Receive accounts on this device" -> Host is Sender
                    let host_count = state.store.list().len();
                    let count_bytes = (host_count as u16).to_be_bytes();
                    write_frame(&mut stream, MSG_ROLE_SELECT_RESP, &count_bytes).await?;
                    Ok((true, host_count))
                }
                other => Err(format!("Unknown role selection opcode: 0x{other:02X}")),
            }
        })
        .await;

    let (host_is_sender, account_count) = match role_res {
        Ok(Ok(res)) => res,
        Ok(Err(e)) => {
            let _ = write_frame(&mut stream, MSG_ABORT, &[0x04]).await;
            let _ = status_tx.send(HostEvent::Failed(e)).await;
            encryption_key.zeroize();
            return;
        }
        Err(_) => {
            let _ = write_frame(&mut stream, MSG_ABORT, &[0x05]).await;
            let _ = status_tx
                .send(HostEvent::Failed("Timed out waiting for role selection".into()))
                .await;
            encryption_key.zeroize();
            return;
        }
    };

    let host_role = if host_is_sender { "sender" } else { "receiver" };
    let _ = status_tx
        .send(HostEvent::SasVerification {
            sas_code: sas_code.clone(),
            fingerprint: fingerprint.clone(),
            role: host_role.to_string(),
            account_count,
        })
        .await;

    // Proceed to mutual confirmation and payload transfer
    run_authenticated_transfer(
        state,
        stream,
        host_is_sender,
        encryption_key,
        transcript,
        sas_code,
        sas_confirm_rx,
        cancel_rx,
        status_tx,
    )
    .await;
}

#[allow(dead_code)]
pub async fn run_receiver_listener(
    state: Arc<AppState>,
    session_id: Uuid,
    listener: TcpListener,
    keypair: EphemeralKeyPair,
    session_nonce: Vec<u8>,
    status_tx: mpsc::Sender<ReceiverEvent>,
    sas_confirm_rx: oneshot::Receiver<bool>,
    cancel_rx: oneshot::Receiver<()>,
) {
    let fp = crate::pairing::protocol::compute_display_fingerprint(
        &session_id,
        &keypair.public_bytes(),
        &session_nonce,
    );
    run_host_listener(
        state,
        session_id,
        listener,
        keypair,
        session_nonce,
        fp,
        status_tx,
        sas_confirm_rx,
        cancel_rx,
    )
    .await;
}

/// Runs the client connector loop (connects to host, selects role, verifies SAS, transfers)
pub async fn run_client_connector(
    state: Arc<AppState>,
    parsed: ParsedQrPayload,
    status_tx: mpsc::Sender<ClientEvent>,
    mut role_select_rx: oneshot::Receiver<String>,
    sas_confirm_rx: oneshot::Receiver<bool>,
    mut cancel_rx: oneshot::Receiver<()>,
) {
    let connect_addr = format!("{}:{}", parsed.host, parsed.port);
    let mut stream = match timeout(
        Duration::from_secs(10),
        TcpStream::connect(&connect_addr),
    )
    .await
    {
        Ok(Ok(s)) => s,
        Ok(Err(e)) => {
            let _ = status_tx
                .send(ClientEvent::Failed(format!("Connection failed to {connect_addr}: {e}")))
                .await;
            return;
        }
        Err(_) => {
            let _ = status_tx
                .send(ClientEvent::Failed(format!("Connection timed out to {connect_addr}")))
                .await;
            return;
        }
    };

    let keypair = EphemeralKeyPair::generate();
    let client_pubkey = keypair.public_bytes();
    let session_id_bytes = *parsed.session_id.as_bytes();

    // Send Handshake Init
    let mut init_payload = Vec::with_capacity(48);
    init_payload.extend_from_slice(&client_pubkey);
    init_payload.extend_from_slice(&session_id_bytes);

    if let Err(e) = write_frame(&mut stream, MSG_HANDSHAKE_INIT, &init_payload).await {
        let _ = status_tx.send(ClientEvent::Failed(e)).await;
        return;
    }

    // Read Handshake Resp
    let resp_res: Result<Result<(), String>, _> =
        timeout(Duration::from_secs(SOCKET_TIMEOUT_SECS), async {
            let (msg_type, payload) = read_frame(&mut stream).await?;
            if msg_type != MSG_HANDSHAKE_RESP {
                return Err("Expected MSG_HANDSHAKE_RESP".into());
            }
            if payload.is_empty() || payload[0] != 0x00 {
                return Err("Host rejected handshake".into());
            }
            Ok(())
        })
        .await;

    if let Err(e) = resp_res {
        let _ = status_tx
            .send(ClientEvent::Failed(format!("Handshake error: {e}")))
            .await;
        return;
    }

    // Derive encryption key & SAS code
    let host_point = x25519_dalek::PublicKey::from(parsed.peer_public_key);
    let derived = keypair.diffie_hellman(&host_point);
    let mut encryption_key = match derived.derive_encryption_key(&parsed.session_nonce) {
        Ok(k) => k,
        Err(e) => {
            let _ = status_tx.send(ClientEvent::Failed(e)).await;
            return;
        }
    };

    let transcript = build_transcript(
        &session_id_bytes,
        &parsed.session_nonce,
        &parsed.peer_public_key,
        &client_pubkey,
    );

    let sas_code = compute_sas_code(&encryption_key, &transcript);
    let local_account_count = state.store.list().len();

    // Emit Connected for backward compatibility and RoleSelection for UI
    let _ = status_tx
        .send(ClientEvent::Connected {
            sas_code: sas_code.clone(),
            fingerprint: parsed.fingerprint.clone(),
            account_count: local_account_count,
        })
        .await;
    let _ = status_tx
        .send(ClientEvent::RoleSelection {
            sas_code: sas_code.clone(),
            fingerprint: parsed.fingerprint.clone(),
        })
        .await;

    // Wait for role selection from frontend
    let role_choice = tokio::select! {
        _ = &mut cancel_rx => {
            let _ = write_frame(&mut stream, MSG_ABORT, &[0x06]).await;
            let _ = status_tx.send(ClientEvent::Cancelled).await;
            encryption_key.zeroize();
            return;
        }
        res = &mut role_select_rx => {
            match res {
                Ok(r) => r,
                Err(_) => {
                    let _ = write_frame(&mut stream, MSG_ABORT, &[0x07]).await;
                    let _ = status_tx.send(ClientEvent::Failed("Role selection cancelled".into())).await;
                    encryption_key.zeroize();
                    return;
                }
            }
        }
    };

    let (client_is_sender, account_count) = if role_choice == "send" {
        let count = local_account_count;
        let count_bytes = (count as u16).to_be_bytes();
        let mut msg = Vec::with_capacity(3);
        msg.push(0x01);
        msg.extend_from_slice(&count_bytes);

        if let Err(e) = write_frame(&mut stream, MSG_ROLE_SELECT, &msg).await {
            let _ = status_tx.send(ClientEvent::Failed(e)).await;
            encryption_key.zeroize();
            return;
        }

        // Wait for Host response
        let resp = match timeout(Duration::from_secs(SOCKET_TIMEOUT_SECS), read_frame(&mut stream)).await {
            Ok(Ok((msg_type, _))) if msg_type == MSG_ROLE_SELECT_RESP => Ok(()),
            Ok(Ok((msg_type, _))) => Err(format!("Unexpected message type 0x{msg_type:02X} after role select")),
            Ok(Err(e)) => Err(e),
            Err(_) => Err("Timed out waiting for host role select response".into()),
        };

        if let Err(e) = resp {
            let _ = status_tx.send(ClientEvent::Failed(e)).await;
            encryption_key.zeroize();
            return;
        }

        (true, count)
    } else {
        // "receive"
        let msg = [0x02, 0x00, 0x00];
        if let Err(e) = write_frame(&mut stream, MSG_ROLE_SELECT, &msg).await {
            let _ = status_tx.send(ClientEvent::Failed(e)).await;
            encryption_key.zeroize();
            return;
        }

        // Host responds with its account count
        let host_count_res: Result<Result<usize, String>, _> =
            timeout(Duration::from_secs(SOCKET_TIMEOUT_SECS), async {
                let (msg_type, payload) = read_frame(&mut stream).await?;
                if msg_type != MSG_ROLE_SELECT_RESP {
                    return Err("Expected MSG_ROLE_SELECT_RESP".into());
                }
                if payload.len() < 2 {
                    return Err("Invalid role select response length".into());
                }
                let count = u16::from_be_bytes([payload[0], payload[1]]) as usize;
                Ok(count)
            })
            .await;

        let host_count = match host_count_res {
            Ok(Ok(c)) => c,
            Ok(Err(e)) => {
                let _ = status_tx.send(ClientEvent::Failed(e)).await;
                encryption_key.zeroize();
                return;
            }
            Err(_) => {
                let _ = status_tx
                    .send(ClientEvent::Failed("Timed out waiting for host account count".into()))
                    .await;
                encryption_key.zeroize();
                return;
            }
        };

        (false, host_count)
    };

    let client_role = if client_is_sender { "sender" } else { "receiver" };
    let _ = status_tx
        .send(ClientEvent::SasVerification {
            sas_code: sas_code.clone(),
            fingerprint: parsed.fingerprint.clone(),
            role: client_role.to_string(),
            account_count,
        })
        .await;

    // Proceed to mutual confirmation and payload transfer
    run_authenticated_transfer(
        state,
        stream,
        client_is_sender,
        encryption_key,
        transcript,
        sas_code,
        sas_confirm_rx,
        cancel_rx,
        status_tx,
    )
    .await;
}

#[allow(dead_code)]
pub async fn run_sender_client(
    state: Arc<AppState>,
    parsed: ParsedQrPayload,
    status_tx: mpsc::Sender<SenderEvent>,
    sas_confirm_rx: oneshot::Receiver<bool>,
    cancel_rx: oneshot::Receiver<()>,
) {
    let (role_tx, role_rx) = oneshot::channel();
    let _ = role_tx.send("send".to_string());
    run_client_connector(state, parsed, status_tx, role_rx, sas_confirm_rx, cancel_rx).await;
}

/// Shared mutual confirmation and authenticated data transfer logic for both Host and Client
async fn run_authenticated_transfer<E>(
    state: Arc<AppState>,
    stream: TcpStream,
    is_sender: bool,
    mut encryption_key: [u8; 32],
    transcript: Vec<u8>,
    sas_code: String,
    mut sas_confirm_rx: oneshot::Receiver<bool>,
    mut cancel_rx: oneshot::Receiver<()>,
    status_tx: mpsc::Sender<E>,
) where
    E: From<TransferEvent> + Send + 'static,
{
    let my_tag_info = if is_sender {
        CONFIRM_SENDER_INFO
    } else {
        CONFIRM_RECEIVER_INFO
    };
    let peer_tag_info = if is_sender {
        CONFIRM_RECEIVER_INFO
    } else {
        CONFIRM_SENDER_INFO
    };

    let my_tag = compute_confirmation_tag(&encryption_key, &sas_code, my_tag_info);

    // Split stream for concurrent mutual confirmation exchange
    let (mut read_half, mut write_half) = stream.into_split();

    let writer_task = async {
        tokio::select! {
            _ = &mut cancel_rx => {
                let _ = write_frame(&mut write_half, MSG_ABORT, &[0x08]).await;
                Err("Cancelled by user".to_string())
            }
            confirmed = &mut sas_confirm_rx => {
                match confirmed {
                    Ok(true) => {
                        let mut confirm_payload = Vec::with_capacity(33);
                        confirm_payload.push(0x01);
                        confirm_payload.extend_from_slice(&my_tag);
                        write_frame(&mut write_half, MSG_SAS_CONFIRM, &confirm_payload).await?;
                        Ok(())
                    }
                    _ => {
                        let _ = write_frame(&mut write_half, MSG_ABORT, &[0x09]).await;
                        Err("User rejected verification code".to_string())
                    }
                }
            }
        }
    };

    let reader_task = async {
        let (msg_type, payload) = read_frame(&mut read_half).await?;
        if msg_type != MSG_SAS_CONFIRM {
            return Err("Expected MSG_SAS_CONFIRM from peer".to_string());
        }
        if payload.len() != 33 || payload[0] != 0x01 {
            return Err("Peer rejected verification code".to_string());
        }
        let mut peer_tag = [0u8; 32];
        peer_tag.copy_from_slice(&payload[1..33]);

        if !verify_confirmation_tag(&encryption_key, &sas_code, peer_tag_info, &peer_tag) {
            return Err("Peer verification tag mismatch".to_string());
        }
        Ok(())
    };

    let exchange_task = async {
        tokio::try_join!(writer_task, reader_task)
    };

    let exchange_res = timeout(
        Duration::from_secs(SOCKET_TIMEOUT_SECS),
        exchange_task,
    )
    .await;

    let mut stream = match exchange_res {
        Ok(Ok((_, _))) => match read_half.reunite(write_half) {
            Ok(s) => s,
            Err(e) => {
                let _ = status_tx
                    .send(TransferEvent::Failed(format!("Socket reunite error: {e}")).into())
                    .await;
                encryption_key.zeroize();
                return;
            }
        },
        Ok(Err(e)) => {
            let _ = status_tx.send(TransferEvent::Failed(e).into()).await;
            encryption_key.zeroize();
            return;
        }
        Err(_) => {
            let _ = status_tx
                .send(TransferEvent::Failed("Confirmation exchange timed out".into()).into())
                .await;
            encryption_key.zeroize();
            return;
        }
    };

    let _ = status_tx.send(TransferEvent::Transferring.into()).await;

    if is_sender {
        // SENDER: Export state, encrypt, and send payload
        let mut export_bytes = match create_export_payload(&state) {
            Ok(b) => b,
            Err(e) => {
                let _ = status_tx.send(TransferEvent::Failed(e).into()).await;
                encryption_key.zeroize();
                return;
            }
        };

        let encrypted = match encrypt_payload(&encryption_key, &transcript, &export_bytes) {
            Ok(c) => c,
            Err(e) => {
                let _ = status_tx.send(TransferEvent::Failed(e).into()).await;
                export_bytes.zeroize();
                encryption_key.zeroize();
                return;
            }
        };

        export_bytes.zeroize();

        if let Err(e) = write_frame(&mut stream, MSG_ENCRYPTED_PAYLOAD, &encrypted).await {
            let _ = status_tx.send(TransferEvent::Failed(e).into()).await;
            encryption_key.zeroize();
            return;
        }

        // Read ACK
        let ack_res: Result<Result<SyncSummary, String>, _> =
            timeout(Duration::from_secs(SOCKET_TIMEOUT_SECS), async {
                let (msg_type, payload) = read_frame(&mut stream).await?;
                if msg_type != MSG_ACK {
                    return Err("Expected MSG_ACK".into());
                }
                if payload.len() < 6 {
                    return Err("Invalid ACK payload length".into());
                }

                let added = u16::from_be_bytes([payload[0], payload[1]]);
                let updated = u16::from_be_bytes([payload[2], payload[3]]);
                let skipped = u16::from_be_bytes([payload[4], payload[5]]);

                Ok(SyncSummary {
                    added,
                    updated,
                    skipped,
                })
            })
            .await;

        encryption_key.zeroize();

        match ack_res {
            Ok(Ok(summary)) => {
                let _ = status_tx.send(TransferEvent::Completed(summary).into()).await;
            }
            Ok(Err(e)) => {
                let _ = status_tx.send(TransferEvent::Failed(e).into()).await;
            }
            Err(_) => {
                let _ = status_tx
                    .send(TransferEvent::Failed("Timed out waiting for transfer ACK".into()).into())
                    .await;
            }
        }
    } else {
        // RECEIVER: Read encrypted payload, decrypt, and import
        let payload_res: Result<Result<Vec<u8>, String>, _> =
            timeout(Duration::from_secs(SOCKET_TIMEOUT_SECS), async {
                let (msg_type, payload) = read_frame(&mut stream).await?;
                if msg_type != MSG_ENCRYPTED_PAYLOAD {
                    return Err("Expected MSG_ENCRYPTED_PAYLOAD".into());
                }
                let decrypted = decrypt_payload(&encryption_key, &transcript, &payload)?;
                Ok(decrypted)
            })
            .await;

        let mut decrypted_bytes = match payload_res {
            Ok(Ok(bytes)) => bytes,
            Ok(Err(e)) => {
                let _ = write_frame(&mut stream, MSG_ABORT, &[0x0A]).await;
                let _ = status_tx.send(TransferEvent::Failed(e).into()).await;
                encryption_key.zeroize();
                return;
            }
            Err(_) => {
                let _ = write_frame(&mut stream, MSG_ABORT, &[0x0B]).await;
                let _ = status_tx
                    .send(TransferEvent::Failed("Payload reception timed out".into()).into())
                    .await;
                encryption_key.zeroize();
                return;
            }
        };

        // Import into native keystore and accounts.json
        let summary = match import_sync_payload(&state, &decrypted_bytes).await {
            Ok(s) => s,
            Err(e) => {
                let _ = write_frame(&mut stream, MSG_ABORT, &[0x0C]).await;
                let _ = status_tx.send(TransferEvent::Failed(e).into()).await;
                decrypted_bytes.zeroize();
                encryption_key.zeroize();
                return;
            }
        };

        decrypted_bytes.zeroize();
        encryption_key.zeroize();

        // Send ACK frame
        let mut ack_body = Vec::with_capacity(6);
        ack_body.extend_from_slice(&summary.added.to_be_bytes());
        ack_body.extend_from_slice(&summary.updated.to_be_bytes());
        ack_body.extend_from_slice(&summary.skipped.to_be_bytes());
        let _ = write_frame(&mut stream, MSG_ACK, &ack_body).await;
        let _ = stream.shutdown().await;

        let _ = status_tx.send(TransferEvent::Completed(summary).into()).await;
    }
}

pub enum TransferEvent {
    Transferring,
    Completed(SyncSummary),
    Failed(String),
    #[allow(dead_code)]
    Cancelled,
}

impl From<TransferEvent> for HostEvent {
    fn from(ev: TransferEvent) -> Self {
        match ev {
            TransferEvent::Transferring => HostEvent::Transferring,
            TransferEvent::Completed(s) => HostEvent::Completed(s),
            TransferEvent::Failed(e) => HostEvent::Failed(e),
            TransferEvent::Cancelled => HostEvent::Cancelled,
        }
    }
}

impl From<TransferEvent> for ClientEvent {
    fn from(ev: TransferEvent) -> Self {
        match ev {
            TransferEvent::Transferring => ClientEvent::Transferring,
            TransferEvent::Completed(s) => ClientEvent::Completed(s),
            TransferEvent::Failed(e) => ClientEvent::Failed(e),
            TransferEvent::Cancelled => ClientEvent::Cancelled,
        }
    }
}

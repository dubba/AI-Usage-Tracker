use crate::{
    pairing::{
        crypto::{
            build_transcript, compute_confirmation_tag, compute_sas_code, decrypt_payload,
            encrypt_payload, verify_confirmation_tag, EphemeralKeyPair, CONFIRM_RECEIVER_INFO,
            CONFIRM_SENDER_INFO,
        },
        payload::{create_export_payload, import_sync_payload, SyncSummary},
        protocol::{
            compute_display_fingerprint, format_uri_host, read_frame_limited, write_frame,
            AbortReason, ParsedQrPayload, CONFIRM_TAG_LEN, HANDSHAKE_INIT_LEN,
            MAX_CONTROL_FRAME_SIZE, MAX_FRAME_SIZE, MAX_PREAUTH_FRAME_SIZE, MSG_ABORT, MSG_ACK,
            MSG_ENCRYPTED_PAYLOAD, MSG_HANDSHAKE_INIT, MSG_HANDSHAKE_RESP, MSG_ROLE_SELECT,
            MSG_ROLE_SELECT_RESP, MSG_SAS_CONFIRM, PUBLIC_KEY_LEN, RESP_OK, ROLE_JOINER_RECEIVES,
            ROLE_JOINER_SENDS, SAS_ACCEPTED, SAS_CONFIRM_LEN, SESSION_ID_LEN,
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
    io::{AsyncWrite, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::{mpsc, oneshot},
    time::timeout,
};
use uuid::Uuid;
use zeroize::Zeroize;

pub const SESSION_TIMEOUT_SECS: u64 = 300; // 5 minutes
pub const SOCKET_TIMEOUT_SECS: u64 = 30; // 30 seconds
/// Time allowed for the joiner's TCP connection to the host to open.
const CONNECT_TIMEOUT_SECS: u64 = 10;
/// Time allowed for both users to compare verification codes and confirm.
/// Longer than the socket timeout: comparing two screens and tapping twice
/// on two devices takes a while.
pub const CONFIRM_TIMEOUT_SECS: u64 = 60; // 60 seconds
/// Delay before rejecting a bad handshake, throttles brute-force/garbage
/// connections without letting them kill the pairing session.
const FAILED_HANDSHAKE_DELAY: Duration = Duration::from_millis(300);

/// Interface name prefixes that never carry the Wi-Fi/Ethernet LAN the other
/// device is on: cellular data (`pdp_ip` on iOS, `rmnet`/`ccmni` on Android,
/// which often hold a carrier `10.x` address), VPN and tunnel adapters,
/// Apple peer-to-peer links, and virtual-machine or container bridges.
/// Lower-cased before comparison.
const NON_LAN_INTERFACE_PREFIXES: &[&str] = &[
    "pdp_ip",
    "rmnet",
    "ccmni",
    "v4-",
    "clat",
    "utun",
    "tun",
    "ipsec",
    "ppp",
    "wg",
    "tailscale",
    "zt",
    "awdl",
    "llw",
    "anpi",
    "bridge",
    "vmnet",
    "vboxnet",
    "docker",
    "veth",
    "br-",
    "vethernet",
];

fn is_non_lan_interface(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    NON_LAN_INTERFACE_PREFIXES
        .iter()
        .any(|prefix| name.starts_with(prefix))
}

fn is_rfc1918(ip: std::net::Ipv4Addr) -> bool {
    let octets = ip.octets();
    (octets[0] == 192 && octets[1] == 168)
        || octets[0] == 10
        || (octets[0] == 172 && (16..=31).contains(&octets[1]))
}

fn is_cgnat(ip: std::net::Ipv4Addr) -> bool {
    let octets = ip.octets();
    octets[0] == 100 && (64..=127).contains(&octets[1])
}

/// Picks the address to host a pairing session on from `(interface name,
/// IPv4)` pairs in system order. A private address on a Wi-Fi or Ethernet
/// interface wins over one on a cellular, VPN, or virtual interface: an
/// iPhone lists its cellular `pdp_ip0` (often a carrier `10.x` address)
/// before Wi-Fi `en0`, and hosting there makes the session unreachable from
/// the other device on the Wi-Fi.
pub(crate) fn select_lan_ipv4(
    candidates: &[(String, std::net::Ipv4Addr)],
) -> Option<std::net::Ipv4Addr> {
    let usable = || candidates.iter().filter(|(_, ip)| !ip.is_loopback());
    usable()
        .find(|(name, ip)| is_rfc1918(*ip) && !is_non_lan_interface(name))
        .or_else(|| usable().find(|(_, ip)| is_rfc1918(*ip)))
        .or_else(|| usable().find(|(_, ip)| !ip.is_link_local() && !is_cgnat(*ip)))
        .map(|(_, ip)| *ip)
}

/// The interface index of the local interface that holds `ip`, so discovery
/// can announce the session only where the listener is reachable.
#[cfg_attr(not(target_os = "ios"), allow(dead_code))]
pub(crate) fn interface_index_for_ip(ip: &str) -> Option<u32> {
    let ip = ip.parse::<std::net::IpAddr>().ok()?;
    if_addrs::get_if_addrs()
        .ok()?
        .into_iter()
        .find(|iface| iface.addr.ip() == ip)
        .and_then(|iface| iface.index)
}

pub fn get_local_lan_ip() -> String {
    if let Ok(interfaces) = if_addrs::get_if_addrs() {
        let candidates: Vec<(String, std::net::Ipv4Addr)> = interfaces
            .into_iter()
            .filter_map(|iface| match iface.addr.ip() {
                std::net::IpAddr::V4(ipv4) => Some((iface.name, ipv4)),
                std::net::IpAddr::V6(_) => None,
            })
            .collect();
        if let Some(ip) = select_lan_ipv4(&candidates) {
            return ip.to_string();
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

    let trimmed = image.trim();
    if !trimmed.starts_with("<?xml") && !trimmed.starts_with("<svg") {
        return Err("Generated QR is not valid SVG markup".into());
    }
    if !trimmed.contains("<svg") || !trimmed.ends_with("</svg>") {
        return Err("Malformed QR SVG markup".into());
    }
    let lower = trimmed.to_ascii_lowercase();
    if lower.contains("<script")
        || lower.contains("<foreignobject")
        || lower.contains("<use")
        || lower.contains("onload")
        || lower.contains("onerror")
        || lower.contains("javascript:")
    {
        return Err("Generated QR SVG contains disallowed elements or attributes".into());
    }

    Ok(image)
}

#[derive(Debug, Clone)]
pub enum HostEvent {
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

#[cfg(test)]
pub type ReceiverEvent = HostEvent;

#[derive(Debug, Clone)]
pub enum ClientEvent {
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

#[cfg(test)]
pub type SenderEvent = ClientEvent;

/// Tells the peer why this side is ending the connection. Best effort: the
/// peer may already be gone.
async fn send_abort<W: AsyncWrite + Unpin>(writer: &mut W, reason: AbortReason) {
    let _ = write_frame(writer, MSG_ABORT, &reason.payload()).await;
}

/// A connection whose key exchange and role selection are done. What is left
/// is for both users to confirm the verification code.
struct NegotiatedPeer {
    stream: TcpStream,
    encryption_key: [u8; 32],
    transcript: Vec<u8>,
    sas_code: String,
    is_sender: bool,
    account_count: usize,
}

/// What the host does after one connection's negotiation ends.
enum HostStep {
    /// Carry on to the verification code with this peer.
    Proceed(NegotiatedPeer),
    /// This connection is finished but the session is not: accept another.
    NextPeer,
    /// The session is over; the UI has been told why.
    EndSession,
}

/// Runs the host listener loop (displays QR code, accepts incoming peer connection)
// Session plumbing: one channel/handle per concern, kept as separate
// arguments so the host, receiver, and client paths stay symmetrical.
#[allow(clippy::too_many_arguments)]
pub async fn run_host_listener(
    state: Arc<AppState>,
    session_id: Uuid,
    listener: TcpListener,
    keypair: EphemeralKeyPair,
    session_nonce: Vec<u8>,
    fingerprint: String,
    status_tx: mpsc::Sender<HostEvent>,
    mut sas_offer: Option<oneshot::Sender<bool>>,
    sas_confirm_rx: oneshot::Receiver<bool>,
    mut cancel_rx: oneshot::Receiver<()>,
) {
    let session_id_bytes = *session_id.as_bytes();
    let deadline = Instant::now() + Duration::from_secs(SESSION_TIMEOUT_SECS);

    let peer = loop {
        let Some((stream, client_pubkey)) = accept_handshake(
            &listener,
            deadline,
            &session_id_bytes,
            &mut cancel_rx,
            &status_tx,
        )
        .await
        else {
            return;
        };

        let step = negotiate_as_host(
            &state,
            stream,
            client_pubkey,
            &keypair,
            &session_id_bytes,
            &session_nonce,
            &fingerprint,
            &status_tx,
        )
        .await;
        match step {
            HostStep::Proceed(peer) => break peer,
            HostStep::NextPeer => continue,
            HostStep::EndSession => return,
        }
    };

    let host_role = if peer.is_sender { "sender" } else { "receiver" };
    // Install the answer channel only once this phase is reached, and before
    // the UI is told, so an earlier confirm has nothing to send on.
    if let Some(tx) = sas_offer.take() {
        state
            .pairing
            .offer_sas_confirm(&session_id.to_string(), tx)
            .await;
    }
    let _ = status_tx
        .send(HostEvent::SasVerification {
            sas_code: peer.sas_code.clone(),
            fingerprint: fingerprint.clone(),
            role: host_role.to_string(),
            account_count: peer.account_count,
        })
        .await;

    // Proceed to mutual confirmation and payload transfer
    run_authenticated_transfer(
        state,
        peer.stream,
        peer.is_sender,
        peer.encryption_key,
        peer.transcript,
        peer.sas_code,
        sas_confirm_rx,
        cancel_rx,
        status_tx,
    )
    .await;
}

/// Waits for a connection that opens with a valid handshake for this session
/// and returns it with the peer's public key. Connections that send anything
/// else are turned away and the wait goes on. Returns `None` once the session
/// is cancelled, expires, or the listener fails; the UI has been told by then.
async fn accept_handshake(
    listener: &TcpListener,
    deadline: Instant,
    session_id_bytes: &[u8; SESSION_ID_LEN],
    cancel_rx: &mut oneshot::Receiver<()>,
    status_tx: &mpsc::Sender<HostEvent>,
) -> Option<(TcpStream, [u8; PUBLIC_KEY_LEN])> {
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            let _ = status_tx.send(HostEvent::Expired).await;
            return None;
        }

        let mut stream = tokio::select! {
            _ = &mut *cancel_rx => {
                let _ = status_tx.send(HostEvent::Cancelled).await;
                return None;
            }
            res = timeout(remaining, listener.accept()) => {
                match res {
                    Ok(Ok((stream, _))) => stream,
                    Ok(Err(e)) => {
                        let _ = status_tx.send(HostEvent::Failed(format!("Socket accept error: {e}"))).await;
                        return None;
                    }
                    Err(_) => {
                        let _ = status_tx.send(HostEvent::Expired).await;
                        return None;
                    }
                }
            }
        };

        let handshake_res = timeout(Duration::from_secs(SOCKET_TIMEOUT_SECS), async {
            // Pre-authentication: strict 1 KiB budget so an
            // unauthenticated LAN peer cannot force a 16 MB allocation.
            let frame = read_frame_limited(&mut stream, MAX_PREAUTH_FRAME_SIZE).await?;
            parse_handshake_init(frame, session_id_bytes)
        })
        .await;

        match handshake_res {
            Ok(Ok(client_pubkey)) => return Some((stream, client_pubkey)),
            Ok(Err(_)) | Err(_) => {
                // Abort this connection only. Bad handshakes must not kill
                // the session (any LAN host can send garbage); a short delay
                // throttles brute-force attempts.
                send_abort(&mut stream, AbortReason::BadHandshake).await;
                tokio::time::sleep(FAILED_HANDSHAKE_DELAY).await;
            }
        }
    }
}

/// The joiner's public key from its opening frame, provided the frame names
/// this session.
fn parse_handshake_init(
    (msg_type, payload): (u8, Vec<u8>),
    session_id_bytes: &[u8; SESSION_ID_LEN],
) -> Result<[u8; PUBLIC_KEY_LEN], String> {
    if msg_type != MSG_HANDSHAKE_INIT {
        return Err("Expected MSG_HANDSHAKE_INIT".into());
    }
    if payload.len() != HANDSHAKE_INIT_LEN {
        return Err(format!("Invalid handshake length: {}", payload.len()));
    }

    let mut client_pubkey = [0u8; PUBLIC_KEY_LEN];
    client_pubkey.copy_from_slice(&payload[..PUBLIC_KEY_LEN]);

    let mut received_session_id = [0u8; SESSION_ID_LEN];
    received_session_id.copy_from_slice(&payload[PUBLIC_KEY_LEN..]);

    if &received_session_id != session_id_bytes {
        return Err("Session ID mismatch".into());
    }

    Ok(client_pubkey)
}

/// Derives the shared key with a peer whose handshake was accepted, answers
/// the handshake, and waits for the peer to choose who sends.
// One argument per piece of session material, as in `run_host_listener`.
#[allow(clippy::too_many_arguments)]
async fn negotiate_as_host(
    state: &AppState,
    mut stream: TcpStream,
    client_pubkey: [u8; PUBLIC_KEY_LEN],
    keypair: &EphemeralKeyPair,
    session_id_bytes: &[u8; SESSION_ID_LEN],
    session_nonce: &[u8],
    fingerprint: &str,
    status_tx: &mpsc::Sender<HostEvent>,
) -> HostStep {
    // Perform DH and key derivation
    let client_point = x25519_dalek::PublicKey::from(client_pubkey);
    let derived = match keypair.diffie_hellman(&client_point) {
        Ok(d) => d,
        Err(_) => {
            // Invalid (non-contributory) peer key: abort this connection
            // only and keep listening for a legitimate peer. Do not emit
            // a Failed event here; the session is still alive.
            send_abort(&mut stream, AbortReason::InvalidPeerKey).await;
            return HostStep::NextPeer;
        }
    };
    let mut encryption_key = match derived.derive_encryption_key(session_nonce) {
        Ok(k) => k,
        Err(e) => {
            send_abort(&mut stream, AbortReason::KeyDerivationFailed).await;
            let _ = status_tx.send(HostEvent::Failed(e)).await;
            return HostStep::EndSession;
        }
    };

    let transcript = build_transcript(
        session_id_bytes,
        session_nonce,
        &keypair.public_bytes(),
        &client_pubkey,
    );

    let sas_code = compute_sas_code(&encryption_key, &transcript);

    // Send Handshake OK response
    if write_frame(&mut stream, MSG_HANDSHAKE_RESP, &[RESP_OK])
        .await
        .is_err()
    {
        // Peer is already gone; go back to accepting connections. Do not
        // emit a Failed event; the session is still alive.
        encryption_key.zeroize();
        return HostStep::NextPeer;
    }

    // Tell the UI a peer has connected
    let _ = status_tx
        .send(HostEvent::PeerConnected {
            sas_code: sas_code.clone(),
            fingerprint: fingerprint.to_string(),
        })
        .await;

    // Wait for the joiner to pick send/receive. This is a user action, so it
    // uses the session timeout rather than the short socket timeout.
    let role_res = timeout(Duration::from_secs(SESSION_TIMEOUT_SECS), async {
        let frame = read_frame_limited(&mut stream, MAX_PREAUTH_FRAME_SIZE).await?;
        answer_role_selection(state, &mut stream, frame).await
    })
    .await;

    match role_res {
        Ok(Ok((is_sender, account_count))) => HostStep::Proceed(NegotiatedPeer {
            stream,
            encryption_key,
            transcript,
            sas_code,
            is_sender,
            account_count,
        }),
        Ok(Err(_)) => {
            // The peer failed, aborted, or disconnected before choosing a
            // role. Don't wedge the session on that connection — go back to
            // accepting so the legitimate device can still connect.
            send_abort(&mut stream, AbortReason::RoleSelectFailed).await;
            encryption_key.zeroize();
            HostStep::NextPeer
        }
        Err(_) => {
            send_abort(&mut stream, AbortReason::RoleSelectTimedOut).await;
            let _ = status_tx
                .send(HostEvent::Failed(
                    "Timed out waiting for role selection".into(),
                ))
                .await;
            encryption_key.zeroize();
            HostStep::EndSession
        }
    }
}

/// Answers the joiner's choice of who sends. Returns whether the host is the
/// sender, and the number of accounts the sender has.
async fn answer_role_selection(
    state: &AppState,
    stream: &mut TcpStream,
    (msg_type, payload): (u8, Vec<u8>),
) -> Result<(bool, usize), String> {
    if msg_type != MSG_ROLE_SELECT {
        return Err("Expected MSG_ROLE_SELECT".into());
    }
    if payload.is_empty() || payload.len() > 3 {
        return Err("Invalid role selection payload length".into());
    }

    match payload[0] {
        ROLE_JOINER_SENDS => {
            // Client selected "Send accounts from this device" -> Host is Receiver
            let count = if payload.len() >= 3 {
                u16::from_be_bytes([payload[1], payload[2]]) as usize
            } else {
                0
            };
            write_frame(stream, MSG_ROLE_SELECT_RESP, &[RESP_OK]).await?;
            Ok((false, count))
        }
        ROLE_JOINER_RECEIVES => {
            // Client selected "Receive accounts on this device" -> Host is Sender
            let host_count = state.store.list().len();
            let count_bytes = (host_count as u16).to_be_bytes();
            write_frame(stream, MSG_ROLE_SELECT_RESP, &count_bytes).await?;
            Ok((true, host_count))
        }
        other => Err(format!("Unknown role selection opcode: 0x{other:02X}")),
    }
}

#[cfg(test)]
// Session plumbing: one channel/handle per concern, kept as separate
// arguments so the host, receiver, and client paths stay symmetrical.
#[allow(clippy::too_many_arguments)]
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
        None,
        sas_confirm_rx,
        cancel_rx,
    )
    .await;
}

/// Runs the client connector loop (connects to host, selects role, verifies SAS, transfers)
// Session plumbing: one channel/handle per concern, kept as separate
// arguments so the host, receiver, and client paths stay symmetrical.
#[allow(clippy::too_many_arguments)]
pub async fn run_client_connector(
    state: Arc<AppState>,
    parsed: ParsedQrPayload,
    status_tx: mpsc::Sender<ClientEvent>,
    mut role_offer: Option<oneshot::Sender<String>>,
    mut role_select_rx: oneshot::Receiver<String>,
    mut sas_offer: Option<oneshot::Sender<bool>>,
    sas_confirm_rx: oneshot::Receiver<bool>,
    mut cancel_rx: oneshot::Receiver<()>,
) {
    let mut stream = match connect_to_host(&parsed).await {
        Ok(s) => s,
        Err(e) => {
            let _ = status_tx.send(ClientEvent::Failed(e)).await;
            return;
        }
    };

    let keypair = EphemeralKeyPair::generate();
    let client_pubkey = keypair.public_bytes();
    let session_id_bytes = *parsed.session_id.as_bytes();

    // Send Handshake Init
    let mut init_payload = Vec::with_capacity(HANDSHAKE_INIT_LEN);
    init_payload.extend_from_slice(&client_pubkey);
    init_payload.extend_from_slice(&session_id_bytes);

    if let Err(e) = write_frame(&mut stream, MSG_HANDSHAKE_INIT, &init_payload).await {
        let _ = status_tx.send(ClientEvent::Failed(e)).await;
        return;
    }

    // Read Handshake Resp
    let resp_res = timeout(Duration::from_secs(SOCKET_TIMEOUT_SECS), async {
        let frame = read_frame_limited(&mut stream, MAX_PREAUTH_FRAME_SIZE).await?;
        check_handshake_resp(frame)
    })
    .await;

    match resp_res {
        Ok(Ok(())) => {}
        Ok(Err(e)) => {
            // The host answered with MSG_ABORT or a rejection payload.
            let _ = status_tx
                .send(ClientEvent::Failed(format!(
                    "Host rejected the connection: {e}"
                )))
                .await;
            return;
        }
        Err(_) => {
            let _ = status_tx
                .send(ClientEvent::Failed(
                    "Handshake timed out waiting for host".to_string(),
                ))
                .await;
            return;
        }
    }

    let ClientKeys {
        mut encryption_key,
        transcript,
        sas_code,
        verified_fingerprint,
    } = match derive_client_keys(&keypair, &parsed) {
        Ok(keys) => keys,
        Err(e) => {
            let _ = status_tx.send(ClientEvent::Failed(e)).await;
            return;
        }
    };
    let local_account_count = state.store.list().len();

    // Install the answer channel only once this phase is reached, and before
    // the UI is told, so an earlier role choice has nothing to send on.
    if let Some(tx) = role_offer.take() {
        state
            .pairing
            .offer_role_select(&parsed.session_id.to_string(), tx)
            .await;
    }
    let _ = status_tx
        .send(ClientEvent::RoleSelection {
            sas_code: sas_code.clone(),
            fingerprint: verified_fingerprint.clone(),
        })
        .await;

    let client_is_sender =
        match await_role_choice(&mut stream, &mut cancel_rx, &mut role_select_rx).await {
            Ok(is_sender) => is_sender,
            Err(event) => {
                let _ = status_tx.send(event).await;
                encryption_key.zeroize();
                return;
            }
        };

    // Tell the host the choice. Whichever side sends also says how many
    // accounts it has.
    let announced: Result<usize, String> = async {
        if client_is_sender {
            let count_bytes = (local_account_count as u16).to_be_bytes();
            let mut msg = Vec::with_capacity(3);
            msg.push(ROLE_JOINER_SENDS);
            msg.extend_from_slice(&count_bytes);
            write_frame(&mut stream, MSG_ROLE_SELECT, &msg).await?;

            // Wait for Host response
            let resp = timeout(
                Duration::from_secs(SOCKET_TIMEOUT_SECS),
                read_frame_limited(&mut stream, MAX_CONTROL_FRAME_SIZE),
            )
            .await;
            check_role_select_ack(resp)?;
            Ok(local_account_count)
        } else {
            let msg = [ROLE_JOINER_RECEIVES, 0x00, 0x00];
            write_frame(&mut stream, MSG_ROLE_SELECT, &msg).await?;

            // Host responds with its account count
            let resp = timeout(
                Duration::from_secs(SOCKET_TIMEOUT_SECS),
                read_frame_limited(&mut stream, MAX_CONTROL_FRAME_SIZE),
            )
            .await;
            parse_host_account_count(resp)
        }
    }
    .await;
    let account_count = match announced {
        Ok(count) => count,
        Err(e) => {
            let _ = status_tx.send(ClientEvent::Failed(e)).await;
            encryption_key.zeroize();
            return;
        }
    };

    let client_role = if client_is_sender {
        "sender"
    } else {
        "receiver"
    };
    if let Some(tx) = sas_offer.take() {
        state
            .pairing
            .offer_sas_confirm(&parsed.session_id.to_string(), tx)
            .await;
    }
    let _ = status_tx
        .send(ClientEvent::SasVerification {
            sas_code: sas_code.clone(),
            fingerprint: verified_fingerprint,
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

/// Opens the TCP connection to the host named in the QR code or join code.
async fn connect_to_host(parsed: &ParsedQrPayload) -> Result<TcpStream, String> {
    let connect_addr = parsed
        .host
        .parse::<std::net::IpAddr>()
        .map(|ip| std::net::SocketAddr::new(ip, parsed.port).to_string())
        .unwrap_or_else(|_| format!("{}:{}", format_uri_host(&parsed.host), parsed.port));
    match timeout(
        Duration::from_secs(CONNECT_TIMEOUT_SECS),
        TcpStream::connect(&connect_addr),
    )
    .await
    {
        Ok(Ok(s)) => Ok(s),
        Ok(Err(e)) => Err(format!("Connection failed to {connect_addr}: {e}")),
        Err(_) => Err(format!("Connection timed out to {connect_addr}")),
    }
}

/// Accepts the host's answer to the opening frame only if it is the OK reply.
fn check_handshake_resp((msg_type, payload): (u8, Vec<u8>)) -> Result<(), String> {
    if msg_type != MSG_HANDSHAKE_RESP {
        return Err("Expected MSG_HANDSHAKE_RESP".into());
    }
    if payload.len() != 1 || payload[0] != RESP_OK {
        return Err("Host rejected handshake".into());
    }
    Ok(())
}

/// What the joiner derives from its own key pair and the host's details.
struct ClientKeys {
    encryption_key: [u8; 32],
    transcript: Vec<u8>,
    sas_code: String,
    verified_fingerprint: String,
}

/// Derives the encryption key, the verification code and the fingerprint to
/// show for the host named in `parsed`.
fn derive_client_keys(
    keypair: &EphemeralKeyPair,
    parsed: &ParsedQrPayload,
) -> Result<ClientKeys, String> {
    let host_point = x25519_dalek::PublicKey::from(parsed.peer_public_key);
    let derived = keypair.diffie_hellman(&host_point)?;
    let encryption_key = derived.derive_encryption_key(&parsed.session_nonce)?;

    let transcript = build_transcript(
        parsed.session_id.as_bytes(),
        &parsed.session_nonce,
        &parsed.peer_public_key,
        &keypair.public_bytes(),
    );

    let sas_code = compute_sas_code(&encryption_key, &transcript);
    // Recompute the fingerprint from the actual peer key — never display the
    // peer-supplied `fp` value (already rejected on mismatch at parse time).
    let verified_fingerprint = compute_display_fingerprint(
        &parsed.session_id,
        &parsed.peer_public_key,
        &parsed.session_nonce,
    );
    Ok(ClientKeys {
        encryption_key,
        transcript,
        sas_code,
        verified_fingerprint,
    })
}

/// Waits for the user to choose whether this device sends or receives, and
/// returns true if it sends. If there will be no usable choice, the host is
/// told and the event to show is returned.
async fn await_role_choice(
    stream: &mut TcpStream,
    cancel_rx: &mut oneshot::Receiver<()>,
    role_select_rx: &mut oneshot::Receiver<String>,
) -> Result<bool, ClientEvent> {
    let role_choice = tokio::select! {
        _ = &mut *cancel_rx => {
            send_abort(stream, AbortReason::CanceledBeforeRole).await;
            return Err(ClientEvent::Cancelled);
        }
        res = &mut *role_select_rx => {
            match res {
                Ok(r) => r,
                Err(_) => {
                    send_abort(stream, AbortReason::RoleChoiceDropped).await;
                    return Err(ClientEvent::Failed("Role selection canceled".into()));
                }
            }
        }
    };

    match role_choice.as_str() {
        "send" => Ok(true),
        "receive" => Ok(false),
        _ => {
            send_abort(stream, AbortReason::InvalidRole).await;
            Err(ClientEvent::Failed(format!(
                "Invalid pairing role '{role_choice}'. Expected 'send' or 'receive'."
            )))
        }
    }
}

/// The outcome of waiting for one frame: the frame, a read error, or a timeout.
type TimedFrame = Result<Result<(u8, Vec<u8>), String>, tokio::time::error::Elapsed>;

/// Accepts the host's reply to "this device sends".
fn check_role_select_ack(resp: TimedFrame) -> Result<(), String> {
    match resp {
        Ok(Ok((msg_type, payload))) if msg_type == MSG_ROLE_SELECT_RESP => {
            if payload.len() > MAX_CONTROL_FRAME_SIZE {
                Err("Role select response too large".into())
            } else {
                Ok(())
            }
        }
        Ok(Ok((msg_type, _))) => Err(format!(
            "Unexpected message type 0x{msg_type:02X} after role select"
        )),
        Ok(Err(e)) => Err(e),
        Err(_) => Err("Timed out waiting for host role select response".into()),
    }
}

/// The host's account count from its reply to "this device receives".
fn parse_host_account_count(resp: TimedFrame) -> Result<usize, String> {
    let (msg_type, payload) =
        resp.map_err(|_| "Timed out waiting for host account count".to_string())??;
    if msg_type != MSG_ROLE_SELECT_RESP {
        return Err("Expected MSG_ROLE_SELECT_RESP".into());
    }
    if payload.len() != 2 {
        return Err("Invalid role select response length".into());
    }
    Ok(u16::from_be_bytes([payload[0], payload[1]]) as usize)
}

#[cfg(test)]
pub async fn run_sender_client(
    state: Arc<AppState>,
    parsed: ParsedQrPayload,
    status_tx: mpsc::Sender<SenderEvent>,
    sas_confirm_rx: oneshot::Receiver<bool>,
    cancel_rx: oneshot::Receiver<()>,
) {
    let (role_tx, role_rx) = oneshot::channel();
    let _ = role_tx.send("send".to_string());
    run_client_connector(
        state,
        parsed,
        status_tx,
        None,
        role_rx,
        None,
        sas_confirm_rx,
        cancel_rx,
    )
    .await;
}

/// Shared mutual confirmation and authenticated data transfer logic for both Host and Client
// Session plumbing: one channel/handle per concern, kept as separate
// arguments so the host, receiver, and client paths stay symmetrical.
#[allow(clippy::too_many_arguments)]
async fn run_authenticated_transfer<E>(
    state: Arc<AppState>,
    stream: TcpStream,
    is_sender: bool,
    mut encryption_key: [u8; 32],
    transcript: Vec<u8>,
    sas_code: String,
    sas_confirm_rx: oneshot::Receiver<bool>,
    cancel_rx: oneshot::Receiver<()>,
    status_tx: mpsc::Sender<E>,
) where
    E: From<TransferEvent> + Send + 'static,
{
    let stream = match exchange_confirmations(
        stream,
        is_sender,
        &encryption_key,
        &sas_code,
        sas_confirm_rx,
        cancel_rx,
    )
    .await
    {
        Ok(s) => s,
        Err(e) => {
            let _ = status_tx.send(TransferEvent::Failed(e).into()).await;
            encryption_key.zeroize();
            return;
        }
    };

    let _ = status_tx.send(TransferEvent::Transferring.into()).await;

    let result = if is_sender {
        send_accounts(&state, stream, &encryption_key, &transcript).await
    } else {
        receive_accounts(&state, stream, &encryption_key, &transcript).await
    };
    encryption_key.zeroize();

    let event = match result {
        Ok(summary) => TransferEvent::Completed(summary),
        Err(e) => TransferEvent::Failed(e),
    };
    let _ = status_tx.send(event.into()).await;
}

/// Sends this side's confirmation of the verification code once the user
/// accepts it, and checks the peer's. Returns the connection only when both
/// sides confirmed the same code; nothing large is read before that.
async fn exchange_confirmations(
    stream: TcpStream,
    is_sender: bool,
    encryption_key: &[u8; 32],
    sas_code: &str,
    mut sas_confirm_rx: oneshot::Receiver<bool>,
    mut cancel_rx: oneshot::Receiver<()>,
) -> Result<TcpStream, String> {
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

    let my_tag = compute_confirmation_tag(encryption_key, sas_code, my_tag_info);

    // Split stream for concurrent mutual confirmation exchange
    let (mut read_half, mut write_half) = stream.into_split();

    let writer_task = async {
        tokio::select! {
            _ = &mut cancel_rx => {
                send_abort(&mut write_half, AbortReason::CanceledBeforeConfirm).await;
                Err("Canceled by user".to_string())
            }
            confirmed = &mut sas_confirm_rx => {
                match confirmed {
                    Ok(true) => {
                        let mut confirm_payload = Vec::with_capacity(SAS_CONFIRM_LEN);
                        confirm_payload.push(SAS_ACCEPTED);
                        confirm_payload.extend_from_slice(&my_tag);
                        write_frame(&mut write_half, MSG_SAS_CONFIRM, &confirm_payload).await?;
                        Ok(())
                    }
                    _ => {
                        send_abort(&mut write_half, AbortReason::SasRejected).await;
                        Err("User rejected verification code".to_string())
                    }
                }
            }
        }
    };

    let reader_task = async {
        // Still pre-authentication (SAS not yet mutually confirmed): keep the
        // 1 KiB budget. The large encrypted payload is only accepted later.
        let (msg_type, payload) =
            read_frame_limited(&mut read_half, MAX_PREAUTH_FRAME_SIZE).await?;
        if msg_type != MSG_SAS_CONFIRM {
            return Err("Expected MSG_SAS_CONFIRM from peer".to_string());
        }
        if payload.len() != SAS_CONFIRM_LEN || payload[0] != SAS_ACCEPTED {
            return Err("Peer rejected verification code".to_string());
        }
        let mut peer_tag = [0u8; CONFIRM_TAG_LEN];
        peer_tag.copy_from_slice(&payload[1..]);

        if !verify_confirmation_tag(encryption_key, sas_code, peer_tag_info, &peer_tag) {
            return Err(
                "The codes do not match. Compare all three groups. If the other device shows only two, update it and try again."
                    .to_string(),
            );
        }
        Ok(())
    };

    let exchange_task = async { tokio::try_join!(writer_task, reader_task) };

    let exchange_res = timeout(Duration::from_secs(CONFIRM_TIMEOUT_SECS), exchange_task).await;

    match exchange_res {
        Ok(Ok((_, _))) => read_half
            .reunite(write_half)
            .map_err(|e| format!("Socket reunite error: {e}")),
        Ok(Err(e)) => Err(e),
        Err(_) => Err("Confirmation exchange timed out".into()),
    }
}

/// SENDER: exports this device's accounts, encrypts them, sends them, and
/// returns what the receiver says it did with them.
async fn send_accounts(
    state: &AppState,
    mut stream: TcpStream,
    encryption_key: &[u8; 32],
    transcript: &[u8],
) -> Result<SyncSummary, String> {
    let mut export_bytes = create_export_payload(state)?;
    // Clear the confirm-time snapshot and the live flags after
    // snapshotting, so this transfer's choices do not leak into the next one.
    state.pairing_options.write().clear_after_export();

    let encrypted = encrypt_payload(encryption_key, transcript, &export_bytes);
    export_bytes.zeroize();
    let encrypted = encrypted?;

    write_frame(&mut stream, MSG_ENCRYPTED_PAYLOAD, &encrypted).await?;

    // Read ACK (small authenticated control frame)
    let ack_res: Result<Result<SyncSummary, String>, _> =
        timeout(Duration::from_secs(SOCKET_TIMEOUT_SECS), async {
            let (msg_type, payload) =
                read_frame_limited(&mut stream, MAX_CONTROL_FRAME_SIZE).await?;
            if msg_type != MSG_ACK {
                return Err("Expected MSG_ACK".into());
            }
            if payload.len() != 6 {
                return Err("Invalid ACK payload length".into());
            }

            let added = u16::from_be_bytes([payload[0], payload[1]]);
            let updated = u16::from_be_bytes([payload[2], payload[3]]);
            let skipped = u16::from_be_bytes([payload[4], payload[5]]);

            Ok(SyncSummary {
                added,
                updated,
                skipped,
                ..SyncSummary::default()
            })
        })
        .await;

    ack_res.unwrap_or_else(|_| Err("Timed out waiting for transfer ACK".into()))
}

/// RECEIVER: reads the encrypted payload, decrypts and imports it, and tells
/// the sender what happened.
async fn receive_accounts(
    state: &Arc<AppState>,
    mut stream: TcpStream,
    encryption_key: &[u8; 32],
    transcript: &[u8],
) -> Result<SyncSummary, String> {
    // This is the only large frame in the protocol and it is accepted
    // solely after mutual SAS confirmation succeeded.
    let payload_res: Result<Result<Vec<u8>, String>, _> =
        timeout(Duration::from_secs(SOCKET_TIMEOUT_SECS), async {
            let (msg_type, payload) = read_frame_limited(&mut stream, MAX_FRAME_SIZE).await?;
            if msg_type != MSG_ENCRYPTED_PAYLOAD {
                return Err("Expected MSG_ENCRYPTED_PAYLOAD".into());
            }
            let decrypted = decrypt_payload(encryption_key, transcript, &payload)?;
            Ok(decrypted)
        })
        .await;

    let mut decrypted_bytes = match payload_res {
        Ok(Ok(bytes)) => bytes,
        Ok(Err(e)) => {
            send_abort(&mut stream, AbortReason::PayloadInvalid).await;
            return Err(e);
        }
        Err(_) => {
            send_abort(&mut stream, AbortReason::PayloadTimedOut).await;
            return Err("Payload reception timed out".into());
        }
    };

    // Import into native keystore and accounts.json
    let imported = import_sync_payload(state, &decrypted_bytes).await;
    decrypted_bytes.zeroize();
    let summary = match imported {
        Ok(s) => s,
        Err(e) => {
            send_abort(&mut stream, AbortReason::ImportFailed).await;
            return Err(e);
        }
    };

    // Send ACK frame
    let mut ack_body = Vec::with_capacity(6);
    ack_body.extend_from_slice(&summary.added.to_be_bytes());
    ack_body.extend_from_slice(&summary.updated.to_be_bytes());
    ack_body.extend_from_slice(&summary.skipped.to_be_bytes());
    let _ = write_frame(&mut stream, MSG_ACK, &ack_body).await;
    let _ = stream.shutdown().await;

    Ok(summary)
}

pub enum TransferEvent {
    Transferring,
    Completed(SyncSummary),
    Failed(String),
}

impl From<TransferEvent> for HostEvent {
    fn from(ev: TransferEvent) -> Self {
        match ev {
            TransferEvent::Transferring => HostEvent::Transferring,
            TransferEvent::Completed(s) => HostEvent::Completed(s),
            TransferEvent::Failed(e) => HostEvent::Failed(e),
        }
    }
}

impl From<TransferEvent> for ClientEvent {
    fn from(ev: TransferEvent) -> Self {
        match ev {
            TransferEvent::Transferring => ClientEvent::Transferring,
            TransferEvent::Completed(s) => ClientEvent::Completed(s),
            TransferEvent::Failed(e) => ClientEvent::Failed(e),
        }
    }
}

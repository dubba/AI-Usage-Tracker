use crate::{
    pairing::{
        crypto::{
            build_transcript, compute_confirmation_tag, decrypt_payload, encrypt_payload,
            verify_confirmation_tag, PakeExchange, CONFIRM_RECEIVER_INFO, CONFIRM_SENDER_INFO,
            KEY_CONFIRM_HOST_INFO, KEY_CONFIRM_JOINER_INFO,
        },
        payload::{create_export_payload, import_sync_payload, SyncSummary},
        protocol::{
            read_frame_limited, write_frame, AbortReason, DiscoveredHost, CONFIRM_TAG_LEN,
            HANDSHAKE_INIT_LEN, MAX_CONTROL_FRAME_SIZE, MAX_FRAME_SIZE, MAX_PREAUTH_FRAME_SIZE,
            MSG_ABORT, MSG_ACK, MSG_ENCRYPTED_PAYLOAD, MSG_HANDSHAKE_INIT, MSG_HANDSHAKE_RESP,
            MSG_KEY_CONFIRM, MSG_ROLE_SELECT, MSG_ROLE_SELECT_RESP, MSG_TRANSFER_CONFIRM,
            PAKE_MESSAGE_LEN, RESP_OK, ROLE_JOINER_RECEIVES, ROLE_JOINER_SENDS, SESSION_ID_LEN,
            TRANSFER_ACCEPTED, TRANSFER_CONFIRM_LEN,
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
/// Time allowed for the sending user to read what will be sent and confirm.
pub const CONFIRM_TIMEOUT_SECS: u64 = 60; // 60 seconds
/// Wrong link codes a host accepts before it ends the session. Each wrong
/// code is one guess out of a million, so three keeps guessing hopeless while
/// forgiving a typo.
pub const MAX_CODE_ATTEMPTS: u8 = 3;
/// Hosts a joiner tries one typed code against. A device that only pretends
/// to be a pairing host learns whether one guess of its own was right from
/// each attempt, so the number is kept small.
pub const MAX_HOSTS_TRIED: usize = 3;
/// Shown on the host when [`MAX_CODE_ATTEMPTS`] is reached.
pub const TOO_MANY_WRONG_CODES: &str =
    "The wrong link code was entered too many times. Start again to get a new code.";
/// Shown on the joiner when no host accepted the code.
pub const WRONG_CODE: &str =
    "That link code didn't match the other device. Check the code and try again.";
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
    PeerConnected,
    ConfirmTransfer {
        role: String, // "sender" | "receiver"
        account_count: usize,
    },
    Transferring,
    Completed(SyncSummary),
    Cancelled,
    Expired,
    Failed(String),
}

#[derive(Debug, Clone)]
pub enum ClientEvent {
    RoleSelection,
    ConfirmTransfer {
        role: String, // "sender" | "receiver"
        account_count: usize,
    },
    Transferring,
    Completed(SyncSummary),
    Cancelled,
    Failed(String),
}

/// Tells the peer why this side is ending the connection. Best effort: the
/// peer may already be gone.
async fn send_abort<W: AsyncWrite + Unpin>(writer: &mut W, reason: AbortReason) {
    let _ = write_frame(writer, MSG_ABORT, &reason.payload()).await;
}

/// A connection whose peer proved it knows the link code. `encryption_key`
/// is shared with that peer only.
pub struct AuthenticatedPeer {
    stream: TcpStream,
    encryption_key: [u8; 32],
    transcript: Vec<u8>,
}

impl Drop for AuthenticatedPeer {
    fn drop(&mut self) {
        self.encryption_key.zeroize();
    }
}

/// An authenticated connection whose role selection is done. What is left is
/// for the sending user to confirm.
struct NegotiatedPeer {
    peer: AuthenticatedPeer,
    is_sender: bool,
    account_count: usize,
}

/// What the host does after one connection's negotiation ends.
enum HostStep {
    /// Carry on to the transfer confirmation with this peer.
    Proceed(NegotiatedPeer),
    /// This connection is finished but the session is not: accept another.
    NextPeer,
    /// The session is over; the UI has been told why.
    EndSession,
}

/// Runs the host listener loop (shows the link code, accepts the joining device)
// Session plumbing: one channel/handle per concern, kept as separate
// arguments so the host and client paths stay symmetrical.
#[allow(clippy::too_many_arguments)]
pub async fn run_host_listener(
    state: Arc<AppState>,
    session_id: Uuid,
    listener: TcpListener,
    code: String,
    session_nonce: Vec<u8>,
    status_tx: mpsc::Sender<HostEvent>,
    mut confirm_offer: Option<oneshot::Sender<bool>>,
    confirm_rx: oneshot::Receiver<bool>,
    mut cancel_rx: oneshot::Receiver<()>,
) {
    let session_id_bytes = *session_id.as_bytes();
    let deadline = Instant::now() + Duration::from_secs(SESSION_TIMEOUT_SECS);
    let mut wrong_codes: u8 = 0;

    let negotiated = loop {
        let Some((stream, joiner_message)) = accept_handshake(
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
            joiner_message,
            &code,
            &session_id_bytes,
            &session_nonce,
            &mut wrong_codes,
            &status_tx,
        )
        .await;
        match step {
            HostStep::Proceed(negotiated) => break negotiated,
            HostStep::NextPeer => continue,
            HostStep::EndSession => return,
        }
    };

    let host_role = if negotiated.is_sender {
        "sender"
    } else {
        "receiver"
    };
    // Install the answer channel only once this phase is reached, and before
    // the UI is told, so an earlier confirm has nothing to send on.
    if let Some(tx) = confirm_offer.take() {
        state
            .pairing
            .offer_transfer_confirm(&session_id.to_string(), tx)
            .await;
    }
    let _ = status_tx
        .send(HostEvent::ConfirmTransfer {
            role: host_role.to_string(),
            account_count: negotiated.account_count,
        })
        .await;

    run_authenticated_transfer(
        state,
        negotiated.peer,
        negotiated.is_sender,
        confirm_rx,
        cancel_rx,
        status_tx,
    )
    .await;
}

/// Waits for a connection that opens with a well-formed handshake for this
/// session and returns it with the joiner's key exchange message. Connections
/// that send anything else are turned away and the wait goes on. Returns
/// `None` once the session is cancelled, expires, or the listener fails; the
/// UI has been told by then.
async fn accept_handshake(
    listener: &TcpListener,
    deadline: Instant,
    session_id_bytes: &[u8; SESSION_ID_LEN],
    cancel_rx: &mut oneshot::Receiver<()>,
    status_tx: &mpsc::Sender<HostEvent>,
) -> Option<(TcpStream, [u8; PAKE_MESSAGE_LEN])> {
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
            Ok(Ok(joiner_message)) => return Some((stream, joiner_message)),
            Ok(Err(_)) | Err(_) => {
                // Abort this connection only. Bad handshakes must not kill
                // the session (any LAN host can send garbage); a short delay
                // throttles them.
                send_abort(&mut stream, AbortReason::BadHandshake).await;
                tokio::time::sleep(FAILED_HANDSHAKE_DELAY).await;
            }
        }
    }
}

/// The joiner's key exchange message from its opening frame, provided the
/// frame names this session.
fn parse_handshake_init(
    (msg_type, payload): (u8, Vec<u8>),
    session_id_bytes: &[u8; SESSION_ID_LEN],
) -> Result<[u8; PAKE_MESSAGE_LEN], String> {
    if msg_type != MSG_HANDSHAKE_INIT {
        return Err("Expected MSG_HANDSHAKE_INIT".into());
    }
    if payload.len() != HANDSHAKE_INIT_LEN {
        return Err(format!("Invalid handshake length: {}", payload.len()));
    }

    let mut joiner_message = [0u8; PAKE_MESSAGE_LEN];
    joiner_message.copy_from_slice(&payload[..PAKE_MESSAGE_LEN]);

    if &payload[PAKE_MESSAGE_LEN..] != session_id_bytes {
        return Err("Session ID mismatch".into());
    }

    Ok(joiner_message)
}

/// What the joiner's proof that it knows the link code turned out to be.
enum JoinerProof {
    Valid,
    /// A well-formed proof made with another code: one wrong guess.
    WrongCode,
    /// No proof arrived (timeout, disconnect, or another frame).
    Missing,
}

/// Reads the joiner's key confirmation and checks it.
async fn read_joiner_proof(
    stream: &mut TcpStream,
    encryption_key: &[u8; 32],
    transcript: &[u8],
) -> JoinerProof {
    let frame = timeout(
        Duration::from_secs(SOCKET_TIMEOUT_SECS),
        read_frame_limited(stream, MAX_PREAUTH_FRAME_SIZE),
    )
    .await;
    let Ok(Ok((MSG_KEY_CONFIRM, payload))) = frame else {
        return JoinerProof::Missing;
    };
    let Ok(tag) = <[u8; CONFIRM_TAG_LEN]>::try_from(payload.as_slice()) else {
        return JoinerProof::Missing;
    };
    if verify_confirmation_tag(encryption_key, transcript, KEY_CONFIRM_JOINER_INFO, &tag) {
        JoinerProof::Valid
    } else {
        JoinerProof::WrongCode
    }
}

/// Runs the key exchange with a joiner whose handshake was accepted, requires
/// its proof that it knows the link code, proves the same back, and waits for
/// it to choose who sends. A joiner without the code never gets past the
/// proof, so nothing is shown to the user for it.
// One argument per piece of session material, as in `run_host_listener`.
#[allow(clippy::too_many_arguments)]
async fn negotiate_as_host(
    state: &AppState,
    mut stream: TcpStream,
    joiner_message: [u8; PAKE_MESSAGE_LEN],
    code: &str,
    session_id_bytes: &[u8; SESSION_ID_LEN],
    session_nonce: &[u8],
    wrong_codes: &mut u8,
    status_tx: &mpsc::Sender<HostEvent>,
) -> HostStep {
    let (exchange, host_message) = PakeExchange::start_host(code);
    let encryption_key = match exchange.finish(&joiner_message, session_nonce) {
        Ok(key) => key,
        Err(_) => {
            // A malformed message, not a guess: turn this connection away and
            // keep listening. Do not emit a Failed event; the session is alive.
            send_abort(&mut stream, AbortReason::InvalidPeerKey).await;
            return HostStep::NextPeer;
        }
    };
    let transcript = build_transcript(
        session_id_bytes,
        session_nonce,
        &joiner_message,
        &host_message,
    );
    let mut peer = AuthenticatedPeer {
        stream,
        encryption_key,
        transcript,
    };

    if write_frame(&mut peer.stream, MSG_HANDSHAKE_RESP, &host_message)
        .await
        .is_err()
    {
        // Peer is already gone; go back to accepting connections.
        return HostStep::NextPeer;
    }

    // The joiner proves itself first. The host's own proof would let a
    // stranger check a guess without being counted, so it is sent only after.
    match read_joiner_proof(&mut peer.stream, &peer.encryption_key, &peer.transcript).await {
        JoinerProof::Valid => {}
        JoinerProof::WrongCode => {
            *wrong_codes += 1;
            send_abort(&mut peer.stream, AbortReason::WrongCode).await;
            tokio::time::sleep(FAILED_HANDSHAKE_DELAY).await;
            if *wrong_codes >= MAX_CODE_ATTEMPTS {
                let _ = status_tx
                    .send(HostEvent::Failed(TOO_MANY_WRONG_CODES.into()))
                    .await;
                return HostStep::EndSession;
            }
            return HostStep::NextPeer;
        }
        JoinerProof::Missing => {
            send_abort(&mut peer.stream, AbortReason::BadHandshake).await;
            return HostStep::NextPeer;
        }
    }

    let host_proof = compute_confirmation_tag(
        &peer.encryption_key,
        &peer.transcript,
        KEY_CONFIRM_HOST_INFO,
    );
    if write_frame(&mut peer.stream, MSG_KEY_CONFIRM, &host_proof)
        .await
        .is_err()
    {
        return HostStep::NextPeer;
    }

    // Tell the UI the other device has connected
    let _ = status_tx.send(HostEvent::PeerConnected).await;

    // Wait for the joiner to pick send/receive. This is a user action, so it
    // uses the session timeout rather than the short socket timeout.
    let role_res = timeout(Duration::from_secs(SESSION_TIMEOUT_SECS), async {
        let frame = read_frame_limited(&mut peer.stream, MAX_PREAUTH_FRAME_SIZE).await?;
        answer_role_selection(state, &mut peer.stream, frame).await
    })
    .await;

    match role_res {
        Ok(Ok((is_sender, account_count))) => HostStep::Proceed(NegotiatedPeer {
            peer,
            is_sender,
            account_count,
        }),
        Ok(Err(_)) => {
            // The peer failed, aborted, or disconnected before choosing a
            // role. Don't wedge the session on that connection: go back to
            // accepting so the user can try again from the other device.
            send_abort(&mut peer.stream, AbortReason::RoleSelectFailed).await;
            HostStep::NextPeer
        }
        Err(_) => {
            send_abort(&mut peer.stream, AbortReason::RoleSelectTimedOut).await;
            let _ = status_tx
                .send(HostEvent::Failed(
                    "Timed out waiting for role selection".into(),
                ))
                .await;
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

/// Why one host could not be joined.
#[derive(Debug)]
pub enum JoinError {
    /// The host (or something posing as one) did not share the code.
    WrongCode,
    /// The host could not be reached or did not follow the protocol.
    Unreachable(String),
}

/// Connects to `host` and runs the key exchange with `code`. Succeeds only if
/// the host proves it holds the same code.
pub async fn join_host(host: &DiscoveredHost, code: &str) -> Result<AuthenticatedPeer, JoinError> {
    let mut stream = connect_to_host(host)
        .await
        .map_err(JoinError::Unreachable)?;

    let (exchange, joiner_message) = PakeExchange::start_joiner(code);
    let mut init_payload = Vec::with_capacity(HANDSHAKE_INIT_LEN);
    init_payload.extend_from_slice(&joiner_message);
    init_payload.extend_from_slice(host.session_id.as_bytes());
    write_frame(&mut stream, MSG_HANDSHAKE_INIT, &init_payload)
        .await
        .map_err(JoinError::Unreachable)?;

    let host_message = match timeout(
        Duration::from_secs(SOCKET_TIMEOUT_SECS),
        read_frame_limited(&mut stream, MAX_PREAUTH_FRAME_SIZE),
    )
    .await
    {
        Ok(Ok((MSG_HANDSHAKE_RESP, payload))) if payload.len() == PAKE_MESSAGE_LEN => payload,
        Ok(Ok(_)) => {
            return Err(JoinError::Unreachable(
                "The other device rejected the connection.".into(),
            ))
        }
        Ok(Err(e)) => return Err(JoinError::Unreachable(e)),
        Err(_) => {
            return Err(JoinError::Unreachable(
                "Handshake timed out waiting for the other device".into(),
            ))
        }
    };

    let encryption_key = exchange
        .finish(&host_message, &host.session_nonce)
        .map_err(JoinError::Unreachable)?;
    let transcript = build_transcript(
        host.session_id.as_bytes(),
        &host.session_nonce,
        &joiner_message,
        &host_message,
    );
    let mut peer = AuthenticatedPeer {
        stream,
        encryption_key,
        transcript,
    };

    let joiner_proof = compute_confirmation_tag(
        &peer.encryption_key,
        &peer.transcript,
        KEY_CONFIRM_JOINER_INFO,
    );
    write_frame(&mut peer.stream, MSG_KEY_CONFIRM, &joiner_proof)
        .await
        .map_err(JoinError::Unreachable)?;

    match timeout(
        Duration::from_secs(SOCKET_TIMEOUT_SECS),
        read_frame_limited(&mut peer.stream, MAX_PREAUTH_FRAME_SIZE),
    )
    .await
    {
        Ok(Ok((MSG_KEY_CONFIRM, payload))) => {
            let valid = <[u8; CONFIRM_TAG_LEN]>::try_from(payload.as_slice()).is_ok_and(|tag| {
                verify_confirmation_tag(
                    &peer.encryption_key,
                    &peer.transcript,
                    KEY_CONFIRM_HOST_INFO,
                    &tag,
                )
            });
            if valid {
                Ok(peer)
            } else {
                send_abort(&mut peer.stream, AbortReason::WrongCode).await;
                Err(JoinError::WrongCode)
            }
        }
        Ok(Ok((MSG_ABORT, payload))) if payload == AbortReason::WrongCode.payload() => {
            Err(JoinError::WrongCode)
        }
        Ok(Ok(_)) => Err(JoinError::Unreachable(
            "The other device rejected the connection.".into(),
        )),
        Ok(Err(e)) => Err(JoinError::Unreachable(e)),
        Err(_) => Err(JoinError::Unreachable(
            "Handshake timed out waiting for the other device".into(),
        )),
    }
}

/// Tries the typed code against the hosts found on the network, at most
/// [`MAX_HOSTS_TRIED`], and returns the first that shares it.
async fn join_any_host(hosts: &[DiscoveredHost], code: &str) -> Result<AuthenticatedPeer, String> {
    let mut wrong_code = false;
    let mut last_error = None;
    for host in hosts.iter().take(MAX_HOSTS_TRIED) {
        match join_host(host, code).await {
            Ok(peer) => return Ok(peer),
            Err(JoinError::WrongCode) => wrong_code = true,
            Err(JoinError::Unreachable(error)) => last_error = Some(error),
        }
    }
    if wrong_code {
        return Err(WRONG_CODE.into());
    }
    Err(last_error.unwrap_or_else(|| "No device to connect to.".into()))
}

/// Runs the joining device: finds the host that shares the code, selects the
/// role, waits for the transfer to be confirmed, and transfers. `session_id`
/// is this device's own name for the session (the hosts' ids are theirs).
// Session plumbing: one channel/handle per concern, kept as separate
// arguments so the host and client paths stay symmetrical.
#[allow(clippy::too_many_arguments)]
pub async fn run_client_connector(
    state: Arc<AppState>,
    session_id: String,
    hosts: Vec<DiscoveredHost>,
    code: String,
    status_tx: mpsc::Sender<ClientEvent>,
    mut role_offer: Option<oneshot::Sender<String>>,
    mut role_select_rx: oneshot::Receiver<String>,
    mut confirm_offer: Option<oneshot::Sender<bool>>,
    confirm_rx: oneshot::Receiver<bool>,
    mut cancel_rx: oneshot::Receiver<()>,
) {
    let joined = tokio::select! {
        _ = &mut cancel_rx => {
            let _ = status_tx.send(ClientEvent::Cancelled).await;
            return;
        }
        joined = join_any_host(&hosts, &code) => joined,
    };
    let mut peer = match joined {
        Ok(peer) => peer,
        Err(e) => {
            let _ = status_tx.send(ClientEvent::Failed(e)).await;
            return;
        }
    };
    let local_account_count = state.store.list().len();

    // Install the answer channel only once this phase is reached, and before
    // the UI is told, so an earlier role choice has nothing to send on.
    if let Some(tx) = role_offer.take() {
        state.pairing.offer_role_select(&session_id, tx).await;
    }
    let _ = status_tx.send(ClientEvent::RoleSelection).await;

    let client_is_sender =
        match await_role_choice(&mut peer.stream, &mut cancel_rx, &mut role_select_rx).await {
            Ok(is_sender) => is_sender,
            Err(event) => {
                let _ = status_tx.send(event).await;
                return;
            }
        };

    // Tell the host the choice. Whichever side sends also says how many
    // accounts it has.
    let stream = &mut peer.stream;
    let announced: Result<usize, String> = async {
        if client_is_sender {
            let count_bytes = (local_account_count as u16).to_be_bytes();
            let mut msg = Vec::with_capacity(3);
            msg.push(ROLE_JOINER_SENDS);
            msg.extend_from_slice(&count_bytes);
            write_frame(stream, MSG_ROLE_SELECT, &msg).await?;

            // Wait for Host response
            let resp = timeout(
                Duration::from_secs(SOCKET_TIMEOUT_SECS),
                read_frame_limited(stream, MAX_CONTROL_FRAME_SIZE),
            )
            .await;
            check_role_select_ack(resp)?;
            Ok(local_account_count)
        } else {
            let msg = [ROLE_JOINER_RECEIVES, 0x00, 0x00];
            write_frame(stream, MSG_ROLE_SELECT, &msg).await?;

            // Host responds with its account count
            let resp = timeout(
                Duration::from_secs(SOCKET_TIMEOUT_SECS),
                read_frame_limited(stream, MAX_CONTROL_FRAME_SIZE),
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
            return;
        }
    };

    let client_role = if client_is_sender {
        "sender"
    } else {
        "receiver"
    };
    if let Some(tx) = confirm_offer.take() {
        state.pairing.offer_transfer_confirm(&session_id, tx).await;
    }
    let _ = status_tx
        .send(ClientEvent::ConfirmTransfer {
            role: client_role.to_string(),
            account_count,
        })
        .await;

    run_authenticated_transfer(
        state,
        peer,
        client_is_sender,
        confirm_rx,
        cancel_rx,
        status_tx,
    )
    .await;
}

/// Opens the TCP connection to a host found on the network.
async fn connect_to_host(host: &DiscoveredHost) -> Result<TcpStream, String> {
    let ip = host
        .host
        .parse::<std::net::IpAddr>()
        .map_err(|_| "The other device's address is not valid.".to_string())?;
    let connect_addr = std::net::SocketAddr::new(ip, host.port);
    match timeout(
        Duration::from_secs(CONNECT_TIMEOUT_SECS),
        TcpStream::connect(connect_addr),
    )
    .await
    {
        Ok(Ok(s)) => Ok(s),
        Ok(Err(e)) => Err(format!("Connection failed to {connect_addr}: {e}")),
        Err(_) => Err(format!("Connection timed out to {connect_addr}")),
    }
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
            Err(ClientEvent::Failed(
                "Invalid pairing role. Expected 'send' or 'receive'.".into(),
            ))
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

/// Shared transfer confirmation and authenticated data transfer for both Host and Client
async fn run_authenticated_transfer<E>(
    state: Arc<AppState>,
    mut peer: AuthenticatedPeer,
    is_sender: bool,
    confirm_rx: oneshot::Receiver<bool>,
    cancel_rx: oneshot::Receiver<()>,
    status_tx: mpsc::Sender<E>,
) where
    E: From<TransferEvent> + Send + 'static,
{
    if let Err(e) = exchange_confirmations(&mut peer, is_sender, confirm_rx, cancel_rx).await {
        let _ = status_tx.send(TransferEvent::Failed(e).into()).await;
        return;
    }

    let _ = status_tx.send(TransferEvent::Transferring.into()).await;

    let result = if is_sender {
        send_accounts(&state, &mut peer).await
    } else {
        receive_accounts(&state, &mut peer).await
    };

    let event = match result {
        Ok(summary) => TransferEvent::Completed(summary),
        Err(e) => TransferEvent::Failed(e),
    };
    let _ = status_tx.send(event.into()).await;
}

/// Both sides agree to the transfer before anything large is sent or read.
///
/// The sender's agreement is its user pressing Send. The receiver agrees at
/// once: its user already asked to receive from the device whose code they
/// typed or showed, the peer proved it is that device, and a transfer only
/// adds accounts. The tags are bound to the role, so both sides must also
/// agree on who sends.
async fn exchange_confirmations(
    peer: &mut AuthenticatedPeer,
    is_sender: bool,
    mut confirm_rx: oneshot::Receiver<bool>,
    mut cancel_rx: oneshot::Receiver<()>,
) -> Result<(), String> {
    let (my_tag_info, peer_tag_info) = if is_sender {
        (CONFIRM_SENDER_INFO, CONFIRM_RECEIVER_INFO)
    } else {
        (CONFIRM_RECEIVER_INFO, CONFIRM_SENDER_INFO)
    };
    let encryption_key = peer.encryption_key;
    let transcript = peer.transcript.clone();
    let my_tag = compute_confirmation_tag(&encryption_key, &transcript, my_tag_info);
    let mut confirm_payload = Vec::with_capacity(TRANSFER_CONFIRM_LEN);
    confirm_payload.push(TRANSFER_ACCEPTED);
    confirm_payload.extend_from_slice(&my_tag);

    let (mut read_half, mut write_half) = peer.stream.split();

    // Each failure carries the reason to tell the peer.
    type Stopped = (AbortReason, String);
    let stopped = |message: String| (AbortReason::CanceledBeforeConfirm, message);

    let writer_task = async {
        if is_sender {
            match (&mut confirm_rx).await {
                Ok(true) => {}
                _ => {
                    return Err::<(), Stopped>((
                        AbortReason::TransferDeclined,
                        "The transfer was declined on this device".to_string(),
                    ))
                }
            }
        }
        write_frame(&mut write_half, MSG_TRANSFER_CONFIRM, &confirm_payload)
            .await
            .map_err(stopped)
    };

    let reader_task = async {
        // Still before the transfer is confirmed: keep the 1 KiB budget. The
        // large encrypted payload is only accepted later.
        let (msg_type, payload) = read_frame_limited(&mut read_half, MAX_PREAUTH_FRAME_SIZE)
            .await
            .map_err(stopped)?;
        if msg_type != MSG_TRANSFER_CONFIRM {
            return Err(stopped(
                "The other device canceled the transfer.".to_string(),
            ));
        }
        if payload.len() != TRANSFER_CONFIRM_LEN || payload[0] != TRANSFER_ACCEPTED {
            return Err(stopped(
                "The other device declined the transfer.".to_string(),
            ));
        }
        let mut peer_tag = [0u8; CONFIRM_TAG_LEN];
        peer_tag.copy_from_slice(&payload[1..]);

        if !verify_confirmation_tag(&encryption_key, &transcript, peer_tag_info, &peer_tag) {
            return Err(stopped(
                "The two devices disagree about which one sends. Start the transfer again."
                    .to_string(),
            ));
        }
        Ok(())
    };

    let exchange_task = async { tokio::try_join!(writer_task, reader_task) };

    // Cancel is watched for both roles: the receiver has no button to wait on.
    let result: Result<(), Stopped> = tokio::select! {
        _ = &mut cancel_rx => Err(stopped("Canceled by user".to_string())),
        result = timeout(Duration::from_secs(CONFIRM_TIMEOUT_SECS), exchange_task) => match result {
            Ok(result) => result.map(|_| ()),
            Err(_) => Err(stopped("Confirmation exchange timed out".to_string())),
        },
    };

    match result {
        Ok(()) => Ok(()),
        Err((reason, message)) => {
            send_abort(&mut peer.stream, reason).await;
            Err(message)
        }
    }
}

/// SENDER: exports this device's accounts, encrypts them, sends them, and
/// returns what the receiver says it did with them.
async fn send_accounts(
    state: &AppState,
    peer: &mut AuthenticatedPeer,
) -> Result<SyncSummary, String> {
    let encryption_key = &peer.encryption_key;
    let transcript = &peer.transcript;
    let mut stream = &mut peer.stream;
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
    peer: &mut AuthenticatedPeer,
) -> Result<SyncSummary, String> {
    let encryption_key = &peer.encryption_key;
    let transcript = &peer.transcript;
    let mut stream = &mut peer.stream;
    // This is the only large frame in the protocol and it is accepted
    // solely after both sides confirmed the transfer.
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
    // Settings, order, alerts and layout are taken only if this device's user asked for them.
    let accept_settings = state.pairing_options.read().accept_incoming_settings;
    let imported = import_sync_payload(state, &decrypted_bytes, accept_settings).await;
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

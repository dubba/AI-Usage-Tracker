//! The joining device: finds the host that shares the code, proves it, and chooses who
//! sends.

use super::{
    send_abort, transfer::run_authenticated_transfer, AuthenticatedPeer, ClientEvent,
    SessionChannels, BAD_ADDRESS, CONNECTION_REJECTED, CONNECT_TIMEOUT_SECS, MAX_HOSTS_TRIED,
    NO_DEVICE, ROLE_SELECTION_CANCELED, SOCKET_TIMEOUT_SECS, WRONG_CODE,
};
use crate::{
    pairing::{
        crypto::{
            build_transcript, compute_confirmation_tag, verify_confirmation_tag, PakeExchange,
            KEY_CONFIRM_HOST_INFO, KEY_CONFIRM_JOINER_INFO,
        },
        protocol::{
            read_frame_limited, write_frame, AbortReason, DiscoveredHost, CONFIRM_TAG_LEN,
            HANDSHAKE_INIT_LEN, MAX_CONTROL_FRAME_SIZE, MAX_PREAUTH_FRAME_SIZE, MSG_ABORT,
            MSG_HANDSHAKE_INIT, MSG_HANDSHAKE_RESP, MSG_KEY_CONFIRM, MSG_ROLE_SELECT,
            MSG_ROLE_SELECT_RESP, PAKE_MESSAGE_LEN, ROLE_JOINER_RECEIVES, ROLE_JOINER_SENDS,
        },
    },
    state::AppState,
};
use std::{sync::Arc, time::Duration};
use tokio::{net::TcpStream, sync::oneshot, time::timeout};

/// The joining device's channel for its user's send-or-receive choice. Like
/// `SessionChannels::confirm_offer`, `role_offer` is handed over only once the
/// choice is asked for.
pub struct RoleChannels {
    pub role_offer: Option<oneshot::Sender<String>>,
    pub role_select_rx: oneshot::Receiver<String>,
}

/// Why one host could not be joined.
#[derive(Debug)]
enum JoinError {
    /// The host (or something posing as one) did not share the code.
    WrongCode,
    /// The host could not be reached or did not follow the protocol.
    Unreachable(String),
}

/// Connects to `host` and runs the key exchange with `code`. Succeeds only if
/// the host proves it holds the same code.
async fn join_host(host: &DiscoveredHost, code: &str) -> Result<AuthenticatedPeer, JoinError> {
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
        Ok(Ok(_)) => return Err(JoinError::Unreachable(CONNECTION_REJECTED.into())),
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
        shown_account_count: 0,
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
        Ok(Ok(_)) => Err(JoinError::Unreachable(CONNECTION_REJECTED.into())),
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
    Err(last_error.unwrap_or_else(|| NO_DEVICE.into()))
}

/// Runs the joining device: finds the host that shares the code, selects the
/// role, waits for the transfer to be confirmed, and transfers. `session_id`
/// is this device's own name for the session (the hosts' ids are theirs).
pub async fn run_client_connector(
    state: Arc<AppState>,
    session_id: String,
    hosts: Vec<DiscoveredHost>,
    code: String,
    channels: SessionChannels<ClientEvent>,
    role: RoleChannels,
) {
    let SessionChannels {
        status_tx,
        mut confirm_offer,
        confirm_rx,
        mut cancel_rx,
    } = channels;
    let RoleChannels {
        mut role_offer,
        mut role_select_rx,
    } = role;
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

    peer.shown_account_count = account_count;
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
        .map_err(|_| BAD_ADDRESS.to_string())?;
    let connect_addr = std::net::SocketAddr::new(ip, host.port);
    crate::platform::lan_binding::route_pairing_connection(ip).await;
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
                    return Err(ClientEvent::Failed(ROLE_SELECTION_CANCELED.into()));
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

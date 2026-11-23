//! The hosting device: accepts joiners, checks their proof of the link code, and answers
//! the role selection.

use super::{
    send_abort, transfer::run_authenticated_transfer, AuthenticatedPeer, HostEvent,
    SessionChannels, FAILED_HANDSHAKE_DELAY, MAX_CODE_ATTEMPTS, SESSION_TIMEOUT_SECS,
    SOCKET_TIMEOUT_SECS, TOO_MANY_WRONG_CODES,
};
use crate::{
    pairing::{
        crypto::{
            build_transcript, compute_confirmation_tag, verify_confirmation_tag, PakeExchange,
            KEY_CONFIRM_HOST_INFO, KEY_CONFIRM_JOINER_INFO,
        },
        protocol::{
            read_frame_limited, write_frame, AbortReason, CONFIRM_TAG_LEN, HANDSHAKE_INIT_LEN,
            MAX_PREAUTH_FRAME_SIZE, MSG_HANDSHAKE_INIT, MSG_HANDSHAKE_RESP, MSG_KEY_CONFIRM,
            MSG_ROLE_SELECT, MSG_ROLE_SELECT_RESP, PAKE_MESSAGE_LEN, RESP_OK, ROLE_JOINER_RECEIVES,
            ROLE_JOINER_SENDS, SESSION_ID_LEN,
        },
    },
    state::AppState,
};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::{
    net::{TcpListener, TcpStream},
    sync::{mpsc, oneshot},
    time::timeout,
};
use uuid::Uuid;

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

/// What the hosting device listens on and checks joiners against.
pub struct HostSession {
    pub session_id: Uuid,
    pub listener: TcpListener,
    pub code: String,
    pub session_nonce: Vec<u8>,
}

/// Runs the host listener loop (shows the link code, accepts the joining device)
pub async fn run_host_listener(
    state: Arc<AppState>,
    session: HostSession,
    channels: SessionChannels<HostEvent>,
) {
    let SessionChannels {
        status_tx,
        mut confirm_offer,
        confirm_rx,
        mut cancel_rx,
    } = channels;
    let session_id = session.session_id;
    let session_id_bytes = *session_id.as_bytes();
    let deadline = Instant::now() + Duration::from_secs(SESSION_TIMEOUT_SECS);
    let mut wrong_codes: u8 = 0;

    let negotiated = loop {
        let Some((stream, joiner_message)) = accept_handshake(
            &session.listener,
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
            &session,
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

    let mut peer = negotiated.peer;
    peer.shown_account_count = negotiated.account_count;
    run_authenticated_transfer(
        state,
        peer,
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
async fn negotiate_as_host(
    state: &AppState,
    mut stream: TcpStream,
    joiner_message: [u8; PAKE_MESSAGE_LEN],
    session: &HostSession,
    wrong_codes: &mut u8,
    status_tx: &mpsc::Sender<HostEvent>,
) -> HostStep {
    let code = session.code.as_str();
    let session_id_bytes = session.session_id.as_bytes();
    let session_nonce = session.session_nonce.as_slice();
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
        shown_account_count: 0,
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

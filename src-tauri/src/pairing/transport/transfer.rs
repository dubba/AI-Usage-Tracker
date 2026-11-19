//! The confirmed, encrypted transfer both sides run once the roles are chosen.

use super::{
    events::TransferEvent, send_abort, AuthenticatedPeer, CANCELED_BY_USER, CONFIRM_TIMEOUT_SECS,
    DECLINED_HERE, OTHER_DEVICE_CANCELED, OTHER_DEVICE_DECLINED, ROLES_DISAGREE,
    SOCKET_TIMEOUT_SECS,
};
use crate::{
    pairing::{
        crypto::{
            compute_confirmation_tag, decrypt_payload, encrypt_payload, verify_confirmation_tag,
            CONFIRM_RECEIVER_INFO, CONFIRM_SENDER_INFO,
        },
        payload::{create_export_payload, import_sync_payload, SyncSummary},
        protocol::{
            read_frame_limited, write_frame, AbortReason, CONFIRM_TAG_LEN, MAX_CONTROL_FRAME_SIZE,
            MAX_FRAME_SIZE, MAX_PREAUTH_FRAME_SIZE, MSG_ACK, MSG_ENCRYPTED_PAYLOAD,
            MSG_TRANSFER_CONFIRM, TRANSFER_ACCEPTED, TRANSFER_CONFIRM_LEN,
        },
    },
    state::AppState,
};
use std::{sync::Arc, time::Duration};
use tokio::{
    io::AsyncWriteExt,
    sync::{mpsc, oneshot},
    time::timeout,
};
use zeroize::Zeroize;

/// Shared transfer confirmation and authenticated data transfer for both Host and Client
pub(super) async fn run_authenticated_transfer<E>(
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
                        DECLINED_HERE.to_string(),
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
            return Err(stopped(OTHER_DEVICE_CANCELED.to_string()));
        }
        if payload.len() != TRANSFER_CONFIRM_LEN || payload[0] != TRANSFER_ACCEPTED {
            return Err(stopped(OTHER_DEVICE_DECLINED.to_string()));
        }
        let mut peer_tag = [0u8; CONFIRM_TAG_LEN];
        peer_tag.copy_from_slice(&payload[1..]);

        if !verify_confirmation_tag(&encryption_key, &transcript, peer_tag_info, &peer_tag) {
            return Err(stopped(ROLES_DISAGREE.to_string()));
        }
        Ok(())
    };

    let exchange_task = async { tokio::try_join!(writer_task, reader_task) };

    // Cancel is watched for both roles: the receiver has no button to wait on.
    let result: Result<(), Stopped> = tokio::select! {
        _ = &mut cancel_rx => Err(stopped(CANCELED_BY_USER.to_string())),
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

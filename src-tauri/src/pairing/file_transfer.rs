//! Pairing by file, for two devices that cannot reach each other on a network: the same link
//! code and key exchange as Wi-Fi pairing (`crypto::PakeExchange`), carried by two files that the
//! user moves with Quick Share, AirDrop or anything else.
//!
//! 1. The receiver, after typing the sender's code, makes a **request**: its half of the key
//!    exchange and a fresh nonce. It keeps its side of the exchange in memory only.
//! 2. The sender, still showing that code, opens the request, its user agrees, and it makes the
//!    **reply**: its half of the exchange, its own nonce, the number of accounts, and the export
//!    payload, compressed and encrypted with the agreed key. A code answers one request.
//! 3. The receiver opens the reply, counts the accounts for its user (`preview_reply`, which hands
//!    out a one-time ticket like the QR import), and imports them (`import_reply`).
//!
//! Neither file is secret. The request holds no key; the reply is ciphertext under a key that only
//! a holder of the code derives, and SPAKE2 means someone with both files cannot test codes
//! offline. A forged request is one guess at the code (1 in 10⁶), and it only gets a reply if the
//! sender's user agrees to a request they did not expect. Everything in the reply's header is
//! bound into the encryption, so a changed byte anywhere makes it fail to open.
//!
//! The files reach this module through native open and save dialogs (`commands::pairing`); the
//! page never chooses a path. Between steps the bytes stay here: the sender's opened request with
//! its pairing session, the receiver's opened reply with its request.

use super::{
    crypto::{decrypt_payload, encrypt_payload, PakeExchange},
    discovery::is_valid_join_code,
    payload::{create_export_payload, import_sync_payload, validate_payload, SyncSummary},
    protocol::{MAX_FRAME_SIZE, PAKE_MESSAGE_LEN},
    transport::MORE_ACCOUNTS_THAN_SHOWN,
};
use crate::state::AppState;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use rand::RngCore;
use sha2::{Digest, Sha256};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
use zeroize::{Zeroize, Zeroizing};

/// The first bytes of both files.
const MAGIC: &[u8; 8] = b"AIUTPAIR";
const FORMAT_VERSION: u8 = 1;
const KIND_REQUEST: u8 = 1;
const KIND_REPLY: u8 = 2;
const HEADER_LEN: usize = MAGIC.len() + 2;
const NONCE_LEN: usize = 32;
/// Header, receiver nonce, joiner key exchange message.
pub const REQUEST_LEN: usize = HEADER_LEN + NONCE_LEN + PAKE_MESSAGE_LEN;
/// Header, both nonces, host key exchange message, account count; then the ciphertext.
const REPLY_FIXED_LEN: usize = HEADER_LEN + 2 * NONCE_LEN + PAKE_MESSAGE_LEN + 2;
/// XChaCha20-Poly1305's nonce and tag around the compressed payload.
const CIPHERTEXT_OVERHEAD: usize = 24 + 16;
/// The largest payload, before compression, a reply may carry: the Wi-Fi transfer's frame limit.
const MAX_PAYLOAD_LEN: usize = MAX_FRAME_SIZE;
/// A reply is refused unread above this size.
pub const MAX_REPLY_LEN: usize = REPLY_FIXED_LEN + CIPHERTEXT_OVERHEAD + MAX_PAYLOAD_LEN;
/// Separates this route's transcript from the Wi-Fi one.
const TRANSCRIPT_LABEL: &[u8] = b"ai-usage-tracker-file-transfer-v1";
/// How long a receiver waits for the reply to its request: as long as the sender's code lasts
/// (`transport::SESSION_TIMEOUT_SECS`), which is plenty for two hops by AirDrop or Quick Share.
pub const REQUEST_LIFETIME: Duration = Duration::from_secs(super::transport::SESSION_TIMEOUT_SECS);

pub const NOT_A_PAIRING_FILE: &str =
    "This isn't a Sync Devices file. Choose the file the other device sent.";
pub const NEWER_FORMAT: &str =
    "This file comes from a newer version of AI Usage Tracker. Update the app on this device and try again.";
pub const NOT_A_REQUEST: &str =
    "This is a reply, not a request. Open it on the device that is receiving the accounts.";
pub const NOT_A_REPLY: &str =
    "This is a request, not a reply. Open it on the device that is showing the link code.";
pub const NO_CODE_SHOWN: &str =
    "Choose Send on this device to show a link code, then open the request again.";
pub const CODE_ALREADY_USED: &str =
    "This link code has already answered a request. Show a new code to send again.";
pub const INVALID_CODE: &str = "Enter the 6-digit code shown on the other device.";
pub const NO_REQUEST_OPENED: &str = "Open the request file from the other device first.";
pub const NO_REQUEST_OUT: &str =
    "Choose Receive on this device and enter the code first, then open the reply.";
pub const REQUEST_EXPIRED: &str =
    "This transfer took too long and has expired. Start again on both devices.";
pub const REPLY_FOR_ANOTHER_REQUEST: &str =
    "This reply answers a different request. Open the newest reply from the sending device.";
pub const REPLY_DOES_NOT_OPEN: &str =
    "This reply doesn't match the code you entered, or the file is damaged. Start again on both devices.";
pub const STALE_PREVIEW: &str = "This isn't the reply that was checked. Open the reply again.";

/// The receiver's side between making its request and importing the reply. Memory only: the
/// `spake2` state cannot be saved, so if the app is closed in between the user starts again.
pub enum ReceiverState {
    /// A request is out.
    Waiting(PendingRequest),
    /// The reply opened and was counted; its import may run once, with this ticket.
    Opened(OpenedReply),
}

pub struct PendingRequest {
    exchange: PakeExchange,
    receiver_nonce: [u8; NONCE_LEN],
    joiner_message: Vec<u8>,
    made_at: Instant,
}

pub struct OpenedReply {
    key: Zeroizing<[u8; 32]>,
    /// The reply as opened; the import reads these same bytes.
    reply: Vec<u8>,
    /// The request's half of the exchange, part of the transcript the reply is opened against.
    joiner_message: Vec<u8>,
    reply_hash: [u8; 32],
    ticket: String,
}

/// What an opened reply holds, shown before the user agrees to add it.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct FilePreview {
    pub account_count: usize,
    /// One-time ticket for importing exactly this reply.
    pub ticket: String,
}

/// A request the sender opened, shown before its user agrees to answer it.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct FileRequestInfo {
    /// The accounts this device would send. An account with no saved sign-in is left out of the
    /// export, so the reply may hold fewer.
    pub account_count: usize,
}

/// A transfer file tapped in another app (Android's Quick Share notification), opened as what
/// its header says it is: a request on the sending device, a reply on the receiving one.
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS))]
pub enum TappedFile {
    Request { info: FileRequestInfo },
    Reply { preview: FilePreview },
}

/// The largest file [`open_tapped`] reads: a reply (a request is far smaller).
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub const MAX_TAPPED_LEN: usize = MAX_REPLY_LEN;

struct ParsedRequest<'a> {
    receiver_nonce: &'a [u8],
    joiner_message: &'a [u8],
}

struct ParsedReply<'a> {
    receiver_nonce: &'a [u8],
    sender_nonce: &'a [u8],
    host_message: &'a [u8],
    account_count: u16,
    ciphertext: &'a [u8],
}

fn header(kind: u8) -> [u8; HEADER_LEN] {
    let mut out = [0u8; HEADER_LEN];
    out[..MAGIC.len()].copy_from_slice(MAGIC);
    out[MAGIC.len()] = FORMAT_VERSION;
    out[MAGIC.len() + 1] = kind;
    out
}

/// Checks the magic, version and kind, and returns the bytes after the header.
fn body(bytes: &[u8], kind: u8) -> Result<&[u8], String> {
    if bytes.len() < HEADER_LEN || &bytes[..MAGIC.len()] != MAGIC {
        return Err(NOT_A_PAIRING_FILE.into());
    }
    if bytes[MAGIC.len()] != FORMAT_VERSION {
        return Err(NEWER_FORMAT.into());
    }
    match (bytes[MAGIC.len() + 1], kind) {
        (found, wanted) if found == wanted => Ok(&bytes[HEADER_LEN..]),
        (KIND_REPLY, KIND_REQUEST) => Err(NOT_A_REQUEST.into()),
        (KIND_REQUEST, KIND_REPLY) => Err(NOT_A_REPLY.into()),
        _ => Err(NOT_A_PAIRING_FILE.into()),
    }
}

/// Whether `bytes` is a request (true) or a reply (false), from the header alone.
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
fn is_request(bytes: &[u8]) -> Result<bool, String> {
    if bytes.len() < HEADER_LEN || &bytes[..MAGIC.len()] != MAGIC {
        return Err(NOT_A_PAIRING_FILE.into());
    }
    if bytes[MAGIC.len()] != FORMAT_VERSION {
        return Err(NEWER_FORMAT.into());
    }
    match bytes[MAGIC.len() + 1] {
        KIND_REQUEST => Ok(true),
        KIND_REPLY => Ok(false),
        _ => Err(NOT_A_PAIRING_FILE.into()),
    }
}

fn parse_request(bytes: &[u8]) -> Result<ParsedRequest<'_>, String> {
    let body = body(bytes, KIND_REQUEST)?;
    if bytes.len() != REQUEST_LEN {
        return Err(NOT_A_PAIRING_FILE.into());
    }
    let (receiver_nonce, joiner_message) = body.split_at(NONCE_LEN);
    Ok(ParsedRequest {
        receiver_nonce,
        joiner_message,
    })
}

fn parse_reply(bytes: &[u8]) -> Result<ParsedReply<'_>, String> {
    let body = body(bytes, KIND_REPLY)?;
    if bytes.len() < REPLY_FIXED_LEN + CIPHERTEXT_OVERHEAD || bytes.len() > MAX_REPLY_LEN {
        return Err(NOT_A_PAIRING_FILE.into());
    }
    let (receiver_nonce, rest) = body.split_at(NONCE_LEN);
    let (sender_nonce, rest) = rest.split_at(NONCE_LEN);
    let (host_message, rest) = rest.split_at(PAKE_MESSAGE_LEN);
    let (count, ciphertext) = rest.split_at(2);
    Ok(ParsedReply {
        receiver_nonce,
        sender_nonce,
        host_message,
        account_count: u16::from_be_bytes([count[0], count[1]]),
        ciphertext,
    })
}

/// What the encryption is bound to: everything in the reply's header and the request it answers.
fn transcript(
    receiver_nonce: &[u8],
    sender_nonce: &[u8],
    joiner_message: &[u8],
    host_message: &[u8],
    account_count: u16,
) -> Vec<u8> {
    let mut out =
        Vec::with_capacity(TRANSCRIPT_LABEL.len() + 2 * NONCE_LEN + 2 * PAKE_MESSAGE_LEN + 2);
    out.extend_from_slice(TRANSCRIPT_LABEL);
    out.extend_from_slice(receiver_nonce);
    out.extend_from_slice(sender_nonce);
    out.extend_from_slice(joiner_message);
    out.extend_from_slice(host_message);
    out.extend_from_slice(&account_count.to_be_bytes());
    out
}

fn salt(receiver_nonce: &[u8], sender_nonce: &[u8]) -> Vec<u8> {
    [receiver_nonce, sender_nonce].concat()
}

/// The receiver's request for the device showing `code`, and what it keeps to open the reply.
pub fn build_request(code: &str) -> Result<(PendingRequest, Vec<u8>), String> {
    let code = code.trim();
    if !is_valid_join_code(code) {
        return Err(INVALID_CODE.into());
    }
    let (exchange, joiner_message) = PakeExchange::start_joiner(code);
    let mut receiver_nonce = [0u8; NONCE_LEN];
    rand::rngs::OsRng.fill_bytes(&mut receiver_nonce);
    let mut file = Vec::with_capacity(REQUEST_LEN);
    file.extend_from_slice(&header(KIND_REQUEST));
    file.extend_from_slice(&receiver_nonce);
    file.extend_from_slice(&joiner_message);
    Ok((
        PendingRequest {
            exchange,
            receiver_nonce,
            joiner_message,
            made_at: Instant::now(),
        },
        file,
    ))
}

/// Checks that `request` is a well-formed request, before anything is used up.
pub fn check_request(request: &[u8]) -> Result<(), String> {
    parse_request(request).map(|_| ())
}

/// The sender's reply to `request`, for the code it shows: `payload` (an export) compressed and
/// encrypted under the agreed key, with `account_count` bound to it.
pub fn build_reply(
    code: &str,
    request: &[u8],
    payload: &[u8],
    account_count: usize,
) -> Result<Vec<u8>, String> {
    let request = parse_request(request)?;
    if payload.len() > MAX_PAYLOAD_LEN {
        return Err("The accounts are too large to send in one file.".into());
    }
    let account_count = u16::try_from(account_count).map_err(|_| NOT_A_PAIRING_FILE.to_string())?;
    let (exchange, host_message) = PakeExchange::start_host(code);
    let mut sender_nonce = [0u8; NONCE_LEN];
    rand::rngs::OsRng.fill_bytes(&mut sender_nonce);
    let key = Zeroizing::new(
        exchange
            .finish(
                request.joiner_message,
                &salt(request.receiver_nonce, &sender_nonce),
            )
            // A malformed key exchange message: not a request this app made.
            .map_err(|_| NOT_A_PAIRING_FILE.to_string())?,
    );
    let aad = transcript(
        request.receiver_nonce,
        &sender_nonce,
        request.joiner_message,
        &host_message,
        account_count,
    );
    let mut compressed = miniz_oxide::deflate::compress_to_vec(payload, 6);
    let ciphertext = encrypt_payload(&key, &aad, &compressed);
    compressed.zeroize();
    let ciphertext = ciphertext?;

    let mut file = Vec::with_capacity(REPLY_FIXED_LEN + ciphertext.len());
    file.extend_from_slice(&header(KIND_REPLY));
    file.extend_from_slice(request.receiver_nonce);
    file.extend_from_slice(&sender_nonce);
    file.extend_from_slice(&host_message);
    file.extend_from_slice(&account_count.to_be_bytes());
    file.extend_from_slice(&ciphertext);
    Ok(file)
}

/// Decrypts and decompresses a reply's payload with `key`, and refuses one holding more accounts
/// than its header says (the number the receiver's user is shown).
fn open_payload(
    key: &[u8; 32],
    reply: &ParsedReply,
    joiner_message: &[u8],
) -> Result<Vec<u8>, String> {
    let aad = transcript(
        reply.receiver_nonce,
        reply.sender_nonce,
        joiner_message,
        reply.host_message,
        reply.account_count,
    );
    let mut compressed = decrypt_payload(key, &aad, reply.ciphertext)
        .map_err(|_| REPLY_DOES_NOT_OPEN.to_string())?;
    let payload = miniz_oxide::inflate::decompress_to_vec_with_limit(&compressed, MAX_PAYLOAD_LEN)
        .map_err(|_| REPLY_DOES_NOT_OPEN.to_string());
    compressed.zeroize();
    let mut payload = payload?;
    match validate_payload(&payload) {
        Ok(parsed) if parsed.accounts.len() <= usize::from(reply.account_count) => Ok(payload),
        Ok(_) => {
            payload.zeroize();
            Err(MORE_ACCOUNTS_THAN_SHOWN.into())
        }
        Err(error) => {
            payload.zeroize();
            Err(error)
        }
    }
}

/// Receiver: makes the request for `code` and keeps its side of the exchange, replacing any
/// earlier request.
pub fn create_request(state: &AppState, code: &str) -> Result<Vec<u8>, String> {
    let (pending, file) = build_request(code)?;
    *state.pairing_file_receiver.lock() = Some(ReceiverState::Waiting(pending));
    Ok(file)
}

/// Sender: checks `request` and keeps it with the pairing session showing a code, for
/// [`answer_request`] once the user agrees. A newer request replaces it.
pub async fn open_request(state: &AppState, request: Vec<u8>) -> Result<FileRequestInfo, String> {
    check_request(&request)?;
    state.pairing.hold_file_request(request).await?;
    Ok(FileRequestInfo {
        account_count: state.store.list().len(),
    })
}

/// Sender: answers the opened request for the code this device shows. Call only after its user
/// agreed to send. The code is used up even if building the reply fails: one answer per code.
pub async fn answer_request(state: &AppState) -> Result<Vec<u8>, String> {
    let (code, request) = state.pairing.take_file_reply_inputs().await?;
    let code = Zeroizing::new(code);
    let mut payload = create_export_payload(state)?;
    // Like the Wi-Fi sender: this transfer's choices do not carry into the next one.
    state.pairing_options.write().clear_after_export();
    let reply = validate_payload(&payload)
        .and_then(|parsed| build_reply(&code, &request, &payload, parsed.accounts.len()));
    payload.zeroize();
    reply
}

/// A file tapped in another app: opens it as a request ([`open_request`]) or a reply
/// ([`preview_reply`]), whichever its header says. Each fails as it would from the open dialog,
/// for example when this device is not at that step ([`NO_CODE_SHOWN`], [`NO_REQUEST_OUT`]); any
/// other file is [`NOT_A_PAIRING_FILE`].
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub async fn open_tapped(state: &AppState, bytes: Vec<u8>) -> Result<TappedFile, String> {
    if is_request(&bytes)? {
        open_request(state, bytes)
            .await
            .map(|info| TappedFile::Request { info })
    } else {
        preview_reply(state, bytes).map(|preview| TappedFile::Reply { preview })
    }
}

/// Receiver: opens `reply` and says how many accounts it holds. Nothing is imported. A reply
/// that does not open (a wrong code, or a damaged or altered file) ends the request.
pub fn preview_reply(state: &AppState, reply: Vec<u8>) -> Result<FilePreview, String> {
    let parsed = parse_reply(&reply)?;
    let mut slot = state.pairing_file_receiver.lock();
    let pending = match slot.take() {
        Some(ReceiverState::Waiting(pending)) => pending,
        // An opened reply checked again: withdraw its ticket and count it afresh below.
        Some(ReceiverState::Opened(opened)) => {
            return reopen(&mut slot, opened, &reply, &parsed);
        }
        None => return Err(NO_REQUEST_OUT.into()),
    };
    if pending.made_at.elapsed() > REQUEST_LIFETIME {
        return Err(REQUEST_EXPIRED.into());
    }
    if parsed.receiver_nonce != pending.receiver_nonce {
        // Someone else's reply, or one to an older request: this request still waits.
        *slot = Some(ReceiverState::Waiting(pending));
        return Err(REPLY_FOR_ANOTHER_REQUEST.into());
    }
    let PendingRequest {
        exchange,
        receiver_nonce,
        joiner_message,
        ..
    } = pending;
    let key = Zeroizing::new(
        exchange
            .finish(
                parsed.host_message,
                &salt(&receiver_nonce, parsed.sender_nonce),
            )
            .map_err(|_| REPLY_DOES_NOT_OPEN.to_string())?,
    );
    let account_count = count_accounts(&key, &parsed, &joiner_message)?;
    let ticket = new_ticket();
    let reply_hash = Sha256::digest(&reply).into();
    *slot = Some(ReceiverState::Opened(OpenedReply {
        key,
        reply,
        joiner_message,
        reply_hash,
        ticket: ticket.clone(),
    }));
    Ok(FilePreview {
        account_count,
        ticket,
    })
}

/// Opens the payload and counts its accounts, keeping none of it.
fn count_accounts(
    key: &[u8; 32],
    reply: &ParsedReply,
    joiner_message: &[u8],
) -> Result<usize, String> {
    let mut payload = open_payload(key, reply, joiner_message)?;
    let count = validate_payload(&payload).map(|parsed| parsed.accounts.len());
    payload.zeroize();
    count
}

/// The same reply opened again after its preview (the user went back, or the file was opened
/// twice): counted again with a new ticket, which withdraws the old one. A different file leaves
/// the opened reply as it was.
fn reopen(
    slot: &mut Option<ReceiverState>,
    mut opened: OpenedReply,
    reply: &[u8],
    parsed: &ParsedReply,
) -> Result<FilePreview, String> {
    let hash: [u8; 32] = Sha256::digest(reply).into();
    if hash != opened.reply_hash {
        *slot = Some(ReceiverState::Opened(opened));
        return Err(REPLY_FOR_ANOTHER_REQUEST.into());
    }
    let account_count = count_accounts(&opened.key, parsed, &opened.joiner_message)?;
    opened.ticket = new_ticket();
    let preview = FilePreview {
        account_count,
        ticket: opened.ticket.clone(),
    };
    *slot = Some(ReceiverState::Opened(opened));
    Ok(preview)
}

/// Receiver: imports the reply its user agreed to add, the bytes [`preview_reply`] opened.
/// `ticket` is the one that preview gave; it is used up here, whatever happens.
pub async fn import_reply(
    state: &Arc<AppState>,
    ticket: &str,
    accept_settings: bool,
) -> Result<SyncSummary, String> {
    let opened = match state.pairing_file_receiver.lock().take() {
        Some(ReceiverState::Opened(opened)) => opened,
        _ => return Err(STALE_PREVIEW.into()),
    };
    if opened.ticket != ticket {
        return Err(STALE_PREVIEW.into());
    }
    let parsed = parse_reply(&opened.reply)?;
    let mut payload = open_payload(&opened.key, &parsed, &opened.joiner_message)?;
    let summary = import_sync_payload(state, &payload, accept_settings).await;
    payload.zeroize();
    summary
}

fn new_ticket() -> String {
    let mut bytes = [0u8; 16];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

#[cfg(test)]
mod tests;

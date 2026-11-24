//! Pairing by file, for two devices that cannot reach each other on a network: one file, carried
//! by AirDrop, Quick Share or anything else, holding the accounts encrypted with the link code.
//!
//! 1. The receiver shows a twelve-letter link code (`discovery::generate_link_code`) and waits, on
//!    Wi-Fi and for the file.
//! 2. The sender, once its user typed the code and the other device wasn't found on the network,
//!    makes the **file** ([`seal`]): the export payload, compressed and encrypted under a key
//!    derived from the code with Argon2id and a fresh salt, with the number of accounts bound to
//!    it. It goes out at once.
//! 3. The receiver opens the file with the code it shows ([`open`]). That uses the code up and
//!    ends its Wi-Fi session; the accounts are counted, then imported ([`import`]).
//!
//! The Wi-Fi route's key exchange (`crypto::PakeExchange`) allows one guess at the code per
//! connection. A file allows more: whoever gets a copy can try codes offline. So the code is long
//! (23^12, about 2^54 codes) and each try costs Argon2id with 64 MiB and three passes. The
//! six-digit codes kept for older versions never make or open a file. Everything in the header is
//! bound into the encryption, so a changed byte anywhere stops the file opening.
//!
//! The files reach this module through the native open dialog, a tap in another app, or Downloads
//! (`incoming_files`), all read by `commands::pairing`; the page never chooses a path. Once a file
//! opens its accounts stay here, decrypted in memory, until the import.

use super::{
    crypto::{decrypt_payload, encrypt_payload},
    discovery::{is_legacy_code, is_link_code, normalize_code},
    payload::{create_export_payload, import_sync_payload, validate_payload, SyncSummary},
    protocol::MAX_FRAME_SIZE,
    transport::MORE_ACCOUNTS_THAN_SHOWN,
};
use crate::state::AppState;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use rand::RngCore;
use std::sync::Arc;
use zeroize::{Zeroize, Zeroizing};

/// The first bytes of a transfer file.
const MAGIC: &[u8; 8] = b"AIUTPAIR";
/// Version 1 was a request and reply pair, never released.
const FORMAT_VERSION: u8 = 2;
const KIND_ACCOUNTS: u8 = 1;
const HEADER_LEN: usize = MAGIC.len() + 2;
const SALT_LEN: usize = 16;
/// Header, salt, account count; then the ciphertext.
const FIXED_LEN: usize = HEADER_LEN + SALT_LEN + 2;
/// XChaCha20-Poly1305's nonce and tag around the compressed payload.
const CIPHERTEXT_OVERHEAD: usize = 24 + 16;
/// The largest payload, before compression, a file may carry: the Wi-Fi transfer's frame limit.
const MAX_PAYLOAD_LEN: usize = MAX_FRAME_SIZE;
/// A file is refused unread above this size.
pub const MAX_FILE_LEN: usize = FIXED_LEN + CIPHERTEXT_OVERHEAD + MAX_PAYLOAD_LEN;
/// Separates this file's encryption from every other use of the code.
const AAD_LABEL: &[u8] = b"ai-usage-tracker-file-transfer-v2";

/// Argon2id's cost for one try of a code: 64 MiB and three passes, well under a second on a
/// phone. Fixed by the format version, so a file cannot ask the receiver for more. Tests use a
/// token cost.
#[cfg(not(test))]
const ARGON2_MEMORY_KIB: u32 = 64 * 1024;
#[cfg(not(test))]
const ARGON2_PASSES: u32 = 3;
#[cfg(test)]
const ARGON2_MEMORY_KIB: u32 = 64;
#[cfg(test)]
const ARGON2_PASSES: u32 = 1;

pub const NOT_A_PAIRING_FILE: &str =
    "This isn't a Sync Devices file. Choose the file the other device sent.";
pub const NEWER_FORMAT: &str =
    "This file comes from a newer version of AI Usage Tracker. Update the app on this device and try again.";
pub const OLDER_FORMAT: &str =
    "This file comes from an older version of AI Usage Tracker. Update the app on the other device and send it again.";
pub const NO_CODE_SHOWN: &str =
    "Choose Receive on this device to show a link code, then open the file again.";
pub const WIFI_ONLY_CODE: &str =
    "A 6-digit code works only on the same Wi-Fi. To use a file, choose Receive on the other device and enter its 12-letter code.";
pub const CODE_ALREADY_USED: &str =
    "This link code has already received a file. Show a new code to receive again.";
pub const INVALID_CODE: &str = "Enter the 12-letter code shown on the other device.";
pub const FILE_DOES_NOT_OPEN: &str =
    "This file doesn't match the code shown here, or it is damaged. Check the code on the sending device and send it again.";
pub const STALE_PREVIEW: &str = "This isn't the file that was checked. Open the file again.";

/// A file that opened on the receiver, its accounts not imported yet. Memory only.
pub struct OpenedFile {
    payload: Zeroizing<Vec<u8>>,
    ticket: String,
}

/// What an opened file holds.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct FilePreview {
    pub account_count: usize,
    /// One-time ticket for importing exactly this file.
    pub ticket: String,
}

struct Parsed<'a> {
    /// Everything before the ciphertext, which the encryption is bound to.
    header: &'a [u8],
    salt: &'a [u8],
    account_count: u16,
    ciphertext: &'a [u8],
}

/// Checks the magic, version, kind and size, before any key is derived.
fn parse(bytes: &[u8]) -> Result<Parsed<'_>, String> {
    if bytes.len() < HEADER_LEN || &bytes[..MAGIC.len()] != MAGIC {
        return Err(NOT_A_PAIRING_FILE.into());
    }
    match bytes[MAGIC.len()] {
        FORMAT_VERSION => {}
        version if version < FORMAT_VERSION => return Err(OLDER_FORMAT.into()),
        _ => return Err(NEWER_FORMAT.into()),
    }
    if bytes[MAGIC.len() + 1] != KIND_ACCOUNTS
        || bytes.len() < FIXED_LEN + CIPHERTEXT_OVERHEAD
        || bytes.len() > MAX_FILE_LEN
    {
        return Err(NOT_A_PAIRING_FILE.into());
    }
    let (header, ciphertext) = bytes.split_at(FIXED_LEN);
    let salt = &header[HEADER_LEN..HEADER_LEN + SALT_LEN];
    let count = &header[HEADER_LEN + SALT_LEN..];
    Ok(Parsed {
        header,
        salt,
        account_count: u16::from_be_bytes([count[0], count[1]]),
        ciphertext,
    })
}

/// Whether `bytes` looks like a transfer file of this version, from the header alone: what is
/// checked before the slow key derivation.
pub fn check(bytes: &[u8]) -> Result<(), String> {
    parse(bytes).map(|_| ())
}

fn derive_key(code: &str, salt: &[u8]) -> Result<Zeroizing<[u8; 32]>, String> {
    use argon2::{Algorithm, Argon2, Params, Version};
    let params = Params::new(ARGON2_MEMORY_KIB, ARGON2_PASSES, 1, Some(32))
        .map_err(|_| "Couldn't prepare the file's encryption.".to_string())?;
    let mut key = Zeroizing::new([0u8; 32]);
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into(code.as_bytes(), salt, key.as_mut())
        .map_err(|_| "Couldn't prepare the file's encryption.".to_string())?;
    Ok(key)
}

fn aad(header: &[u8]) -> Vec<u8> {
    [AAD_LABEL, header].concat()
}

/// The file for `code` (a link code, normalized): `payload` (an export) compressed and encrypted,
/// with `account_count` bound to it.
pub fn build(code: &str, payload: &[u8], account_count: usize) -> Result<Vec<u8>, String> {
    if !is_link_code(code) {
        return Err(if is_legacy_code(code) {
            WIFI_ONLY_CODE
        } else {
            INVALID_CODE
        }
        .into());
    }
    if payload.len() > MAX_PAYLOAD_LEN {
        return Err("The accounts are too large to send in one file.".into());
    }
    let account_count = u16::try_from(account_count)
        .map_err(|_| "Too many accounts to send in one file.".to_string())?;
    let mut salt = [0u8; SALT_LEN];
    rand::rngs::OsRng.fill_bytes(&mut salt);
    let mut header = Vec::with_capacity(FIXED_LEN);
    header.extend_from_slice(MAGIC);
    header.push(FORMAT_VERSION);
    header.push(KIND_ACCOUNTS);
    header.extend_from_slice(&salt);
    header.extend_from_slice(&account_count.to_be_bytes());

    let key = derive_key(code, &salt)?;
    let mut compressed = miniz_oxide::deflate::compress_to_vec(payload, 6);
    let ciphertext = encrypt_payload(&key, &aad(&header), &compressed);
    compressed.zeroize();
    let ciphertext = ciphertext?;
    header.extend_from_slice(&ciphertext);
    Ok(header)
}

/// Decrypts and decompresses `file` with `code`, and refuses one holding more accounts than its
/// header says.
fn decrypt(code: &str, file: &[u8]) -> Result<Zeroizing<Vec<u8>>, String> {
    let parsed = parse(file)?;
    let key = derive_key(code, parsed.salt)?;
    let compressed = Zeroizing::new(
        decrypt_payload(&key, &aad(parsed.header), parsed.ciphertext)
            .map_err(|_| FILE_DOES_NOT_OPEN.to_string())?,
    );
    let payload = Zeroizing::new(
        miniz_oxide::inflate::decompress_to_vec_with_limit(&compressed, MAX_PAYLOAD_LEN)
            .map_err(|_| FILE_DOES_NOT_OPEN.to_string())?,
    );
    let accounts = validate_payload(&payload)?.accounts.len();
    if accounts > usize::from(parsed.account_count) {
        return Err(MORE_ACCOUNTS_THAN_SHOWN.into());
    }
    Ok(payload)
}

/// Sender: the file for the device showing `code`, holding this device's accounts. The transfer's
/// extras (`state.pairing_options`) are used up, as by a Wi-Fi transfer.
pub async fn seal(state: &AppState, code: &str) -> Result<Vec<u8>, String> {
    let code = Zeroizing::new(normalize_code(code));
    if !is_link_code(&code) {
        return Err(if is_legacy_code(&code) {
            WIFI_ONLY_CODE
        } else {
            INVALID_CODE
        }
        .into());
    }
    let payload = Zeroizing::new(create_export_payload(state)?);
    // Like the Wi-Fi sender: this transfer's choices do not carry into the next one.
    state.pairing_options.write().clear_after_export();
    let account_count = validate_payload(&payload)?.accounts.len();
    tokio::task::spawn_blocking(move || build(&code, &payload, account_count))
        .await
        .map_err(|_| "Couldn't make the file.".to_string())?
}

/// Receiver: opens `file` with the code this device shows and counts its accounts, importing
/// nothing. A file that opens uses the code up and ends the Wi-Fi session; one that does not
/// (another code, or a damaged file) leaves both, so a corrected file can follow.
pub async fn open(state: &AppState, file: Vec<u8>) -> Result<FilePreview, String> {
    check(&file)?;
    let code = state.pairing.file_code().await?;
    let decrypt_code = code.clone();
    let payload = tokio::task::spawn_blocking(move || decrypt(&decrypt_code, &file))
        .await
        .map_err(|_| FILE_DOES_NOT_OPEN.to_string())??;
    state.pairing.use_file_code(&code).await?;
    let account_count = validate_payload(&payload)?.accounts.len();
    let ticket = new_ticket();
    *state.pairing_file_received.lock() = Some(OpenedFile {
        payload,
        ticket: ticket.clone(),
    });
    Ok(FilePreview {
        account_count,
        ticket,
    })
}

/// Receiver: imports the file [`open`] opened. `ticket` is the one it gave; it is used up here,
/// whatever happens.
pub async fn import(
    state: &Arc<AppState>,
    ticket: &str,
    accept_settings: bool,
) -> Result<SyncSummary, String> {
    let opened = state
        .pairing_file_received
        .lock()
        .take()
        .ok_or_else(|| STALE_PREVIEW.to_string())?;
    if opened.ticket != ticket {
        return Err(STALE_PREVIEW.into());
    }
    import_sync_payload(state, &opened.payload, accept_settings).await
}

fn new_ticket() -> String {
    let mut bytes = [0u8; 16];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

#[cfg(test)]
mod tests;

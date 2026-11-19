//! Air-gapped visual transfer using animated multi-frame QR codes.
//!
//! When devices are not on the same Wi-Fi network (e.g. mobile cellular vs
//! laptop Wi-Fi, or guest Wi-Fi client isolation), the sender displays an
//! animated looping sequence of QR codes. The receiver's camera captures all
//! frames and reassembles the payload.
//!
//! The frames carry their own transfer key, so a recording of all of them can
//! be decrypted: this transfer is not secret from someone who can film the
//! screen (the window is kept out of screenshots while they show, see
//! `platform::capture_protection`). Integrity needs no user check: each frame
//! has a checksum, and the payload is sealed with XChaCha20-Poly1305, so a
//! damaged, mixed or altered capture fails to open instead of importing wrong
//! data. Before importing, the receiver decrypts the frames once to show how
//! many accounts they hold, and the user agrees to add them.

use crate::{
    pairing::{
        crypto::{decrypt_payload, encrypt_payload},
        payload::{create_export_payload, import_sync_payload, validate_payload, SyncSummary},
        transport::generate_qr_svg,
    },
    state::AppState,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, sync::Arc};
use url::Url;
use uuid::Uuid;
use zeroize::Zeroize;

pub const MAX_AIRGAP_DECOMPRESSED_SIZE: usize = 16 * 1024 * 1024; // 16 MB max

pub const AIRGAP_URI_SCHEME: &str = "aiut-airgap";
pub const CHUNK_BINARY_SIZE: usize = 350; // 350 bytes binary -> ~467 bytes base64
const AIRGAP_INFO: &[u8] = b"aiut-airgap-v1";

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct AirgapExportFrame {
    pub chunk_index: usize,
    pub total_chunks: usize,
    pub uri: String,
    pub svg: String,
}

impl std::fmt::Debug for AirgapExportFrame {
    // The frames carry the transfer key and the encrypted accounts, so only
    // their sizes are printed.
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("AirgapExportFrame")
            .field("chunk_index", &self.chunk_index)
            .field("total_chunks", &self.total_chunks)
            .field("uri_len", &self.uri.len())
            .field("svg_len", &self.svg.len())
            .finish()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct AirgapExport {
    pub session_id: String,
    pub total_chunks: usize,
    pub frames: Vec<AirgapExportFrame>,
}

/// What a complete capture holds, shown before the user agrees to import it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct AirgapPreview {
    pub session_id: String,
    pub total_chunks: usize,
    /// Accounts in the transfer. Ones this device already has are skipped on import.
    pub account_count: usize,
    /// One-time ticket for importing exactly these frames. The import must
    /// present it with the same frames (L-104).
    pub ticket: String,
}

/// What the latest preview approved: its ticket and the SHA-256 of the
/// reassembled container. Only the newest preview's ticket is held, and an
/// import consumes it whether or not it succeeds.
pub struct AirgapImportTicket {
    ticket: String,
    container_hash: [u8; 32],
}

const STALE_PREVIEW_ERROR: &str =
    "These frames are not the transfer that was checked. Scan the codes again.";

#[derive(Clone, PartialEq, Eq)]
pub struct ParsedAirgapChunk {
    pub session_id: String,
    pub chunk_index: usize,
    pub total_chunks: usize,
    pub data: String,
}

impl std::fmt::Debug for ParsedAirgapChunk {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ParsedAirgapChunk")
            .field("session_id", &self.session_id)
            .field("chunk_index", &self.chunk_index)
            .field("total_chunks", &self.total_chunks)
            .field("data_len", &self.data.len())
            .finish()
    }
}

/// Computes an 8-character hex checksum of base64 chunk data.
pub fn chunk_checksum(data: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data.as_bytes());
    let digest = hasher.finalize();
    format!(
        "{:02x}{:02x}{:02x}{:02x}",
        digest[0], digest[1], digest[2], digest[3]
    )
}

/// Prepares an encrypted, compressed air-gap export as an animated sequence of SVG QR frames.
pub fn prepare_airgap_export(state: &AppState) -> Result<AirgapExport, String> {
    let raw_payload_bytes = create_export_payload(state)?;

    // 1. Deflate compression (typically reduces payload by 65-75%)
    let compressed = miniz_oxide::deflate::compress_to_vec(&raw_payload_bytes, 6);

    // 2. Random 32-byte transfer key. The key travels inside the frames, so a
    // complete frame capture is sufficient to decrypt.
    let mut key = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut key);

    // 3. Encrypt with XChaCha20-Poly1305
    let ciphertext = encrypt_payload(&key, AIRGAP_INFO, &compressed)?;

    // 4. Container: [32 bytes key] || [ciphertext (24B nonce + data + 16B tag)]
    let mut container = Vec::with_capacity(key.len() + ciphertext.len());
    container.extend_from_slice(&key);
    container.extend_from_slice(&ciphertext);

    // 5. Slice container into chunks of CHUNK_BINARY_SIZE
    let session_id = Uuid::new_v4().simple().to_string()[..8].to_string();
    let binary_chunks: Vec<&[u8]> = container.chunks(CHUNK_BINARY_SIZE).collect();
    let total_chunks = binary_chunks.len();

    let mut frames = Vec::with_capacity(total_chunks);
    for (i, slice) in binary_chunks.iter().enumerate() {
        let chunk_index = i + 1;
        let b64_data = URL_SAFE_NO_PAD.encode(slice);
        let crc = chunk_checksum(&b64_data);

        let uri = format!(
            "{AIRGAP_URI_SCHEME}://1/{session_id}/{chunk_index}/{total_chunks}/{crc}?d={b64_data}"
        );
        let svg = generate_qr_svg(&uri)?;
        frames.push(AirgapExportFrame {
            chunk_index,
            total_chunks,
            uri,
            svg,
        });
    }

    Ok(AirgapExport {
        session_id,
        total_chunks,
        frames,
    })
}

/// Parses an airgap URI string and verifies its checksum.
pub fn parse_airgap_uri(raw_uri: &str) -> Result<ParsedAirgapChunk, String> {
    let trimmed = raw_uri.trim();
    let url = Url::parse(trimmed).map_err(|e| format!("Invalid airgap URI: {e}"))?;
    if url.scheme() != AIRGAP_URI_SCHEME {
        return Err(format!("Unsupported scheme '{}'", url.scheme()));
    }

    let path_segments: Vec<&str> = url.path_segments().map(|s| s.collect()).unwrap_or_default();

    let (session_id, chunk_index, total_chunks, expected_crc) = if url.host_str() == Some("1") {
        if path_segments.len() < 4 {
            return Err("Airgap URI path missing components".into());
        }
        (
            path_segments[0].to_string(),
            path_segments[1]
                .parse::<usize>()
                .map_err(|_| "Invalid chunk index".to_string())?,
            path_segments[2]
                .parse::<usize>()
                .map_err(|_| "Invalid total chunks".to_string())?,
            path_segments[3].to_string(),
        )
    } else {
        if path_segments.len() < 5 || path_segments[0] != "1" {
            return Err("Invalid airgap URI format".into());
        }
        (
            path_segments[1].to_string(),
            path_segments[2]
                .parse::<usize>()
                .map_err(|_| "Invalid chunk index".to_string())?,
            path_segments[3]
                .parse::<usize>()
                .map_err(|_| "Invalid total chunks".to_string())?,
            path_segments[4].to_string(),
        )
    };

    let mut data = None;
    for (k, v) in url.query_pairs() {
        if k == "d" {
            data = Some(v.into_owned());
            break;
        }
    }
    let data = data.ok_or_else(|| "Airgap URI missing data parameter 'd'".to_string())?;

    let actual_crc = chunk_checksum(&data);
    if actual_crc != expected_crc {
        return Err("Airgap chunk checksum mismatch (corrupted frame)".into());
    }

    Ok(ParsedAirgapChunk {
        session_id,
        chunk_index,
        total_chunks,
        data,
    })
}

/// Parses, validates, and reassembles captured airgap chunks into the
/// `(session_id, container)` pair. Shared by preview and import so both
/// operate on identical bytes.
fn reassemble_container(raw_chunks: Vec<String>) -> Result<(String, usize, Vec<u8>), String> {
    if raw_chunks.is_empty() {
        return Err("No air-gap frames provided".into());
    }
    // Bound the work before parsing anything: a real transfer is at most a
    // hundred distinct frames, each about 500 characters.
    if raw_chunks.len() > crate::limits::MAX_AIRGAP_FRAMES_SUBMITTED
        || raw_chunks
            .iter()
            .any(|chunk| chunk.len() > crate::limits::MAX_AIRGAP_FRAME_URI_CHARS)
    {
        return Err("The scanned air-gap frames are not valid. Please rescan.".into());
    }

    let mut parsed_chunks = Vec::with_capacity(raw_chunks.len());
    for raw in &raw_chunks {
        parsed_chunks.push(parse_airgap_uri(raw)?);
    }

    let expected_session = parsed_chunks[0].session_id.clone();
    let total_chunks = parsed_chunks[0].total_chunks;

    if total_chunks == 0 || total_chunks > 100 {
        return Err("Invalid total chunks count in air-gap transfer".into());
    }

    let mut chunk_map: HashMap<usize, String> = HashMap::new();
    for chunk in parsed_chunks {
        if chunk.session_id != expected_session {
            return Err("Scanned frames contain mixed session IDs. Please rescan.".into());
        }
        if chunk.total_chunks != total_chunks {
            return Err("Scanned frames contain mismatched total chunk count".into());
        }
        if chunk.chunk_index == 0 || chunk.chunk_index > total_chunks {
            return Err(format!("Chunk index {} is out of range", chunk.chunk_index));
        }
        chunk_map.insert(chunk.chunk_index, chunk.data);
    }

    if chunk_map.len() < total_chunks {
        return Err(format!(
            "Missing frames: captured {} of {} frames",
            chunk_map.len(),
            total_chunks
        ));
    }

    let mut container = Vec::new();
    for i in 1..=total_chunks {
        let b64_data = chunk_map
            .get(&i)
            .ok_or_else(|| format!("Missing chunk {i}"))?;
        let bytes = URL_SAFE_NO_PAD
            .decode(b64_data.as_bytes())
            .or_else(|_| base64::engine::general_purpose::STANDARD.decode(b64_data.as_bytes()))
            .map_err(|e| format!("Corrupted base64 data in chunk {i}: {e}"))?;
        container.extend_from_slice(&bytes);
    }

    Ok((expected_session, total_chunks, container))
}

/// Decrypts and decompresses a reassembled container. Fails on any damaged
/// or altered byte (the payload is authenticated).
fn open_container(container: &[u8]) -> Result<Vec<u8>, String> {
    if container.len() < 32 + 40 {
        return Err("Air-gap container is too short".into());
    }
    let (key_bytes, ciphertext_with_nonce) = container.split_at(32);
    let mut key = [0u8; 32];
    key.copy_from_slice(key_bytes);
    let compressed = decrypt_payload(&key, AIRGAP_INFO, ciphertext_with_nonce);
    key.zeroize();
    let mut compressed = compressed
        .map_err(|_| "Corrupted transfer. Please rescan the animated codes.".to_string())?;
    let decompressed = miniz_oxide::inflate::decompress_to_vec_with_limit(
        &compressed,
        MAX_AIRGAP_DECOMPRESSED_SIZE,
    )
    .map_err(|_| "Corrupted transfer. Please rescan the animated codes.".to_string());
    compressed.zeroize();
    decompressed
}

/// Checks a complete capture and says how many accounts it holds, so the user
/// can agree to add them. Nothing is imported.
pub fn preview_airgap_frames(
    state: &AppState,
    raw_chunks: Vec<String>,
) -> Result<AirgapPreview, String> {
    // A new preview withdraws the previous one's ticket, even if it fails.
    state.airgap_import_ticket.lock().take();
    let (session_id, total_chunks, container) = reassemble_container(raw_chunks)?;
    let mut bytes = open_container(&container)?;
    let payload = validate_payload(&bytes);
    bytes.zeroize();
    let account_count = payload?.accounts.len();
    let mut ticket_bytes = [0u8; 16];
    rand::rngs::OsRng.fill_bytes(&mut ticket_bytes);
    let ticket = URL_SAFE_NO_PAD.encode(ticket_bytes);
    *state.airgap_import_ticket.lock() = Some(AirgapImportTicket {
        ticket: ticket.clone(),
        container_hash: Sha256::digest(&container).into(),
    });
    Ok(AirgapPreview {
        session_id,
        total_chunks,
        account_count,
        ticket,
    })
}

/// Reassembles captured airgap chunks, decrypts with the embedded transfer
/// key, decompresses, and imports. Call only after the user agreed to add the
/// accounts. `ticket` is the one [`preview_airgap_frames`] returned for these
/// same frames; it is used up here, so each preview allows one import.
/// `accept_settings` is the receiving user's own choice.
pub async fn import_airgap_payload(
    state: &Arc<AppState>,
    raw_chunks: Vec<String>,
    ticket: &str,
    accept_settings: bool,
) -> Result<SyncSummary, String> {
    let approved = state
        .airgap_import_ticket
        .lock()
        .take()
        .ok_or_else(|| STALE_PREVIEW_ERROR.to_string())?;
    let (_session_id, _total_chunks, container) = reassemble_container(raw_chunks)?;
    let hash: [u8; 32] = Sha256::digest(&container).into();
    if approved.ticket != ticket || approved.container_hash != hash {
        return Err(STALE_PREVIEW_ERROR.into());
    }
    let mut decompressed_bytes = open_container(&container)?;
    let summary = import_sync_payload(state, &decompressed_bytes, accept_settings).await;
    decompressed_bytes.zeroize();
    summary
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::AppState;
    use std::sync::Arc;
    use tempfile::TempDir;

    #[test]
    fn oversized_frame_submissions_are_rejected_before_parsing() {
        let dir = TempDir::new().unwrap();
        let state = AppState::new(dir.path().to_path_buf(), "token".into()).unwrap();
        let many = vec!["aiut-airgap://1/x/1/1/00000000?d=AA".to_string(); 1001];
        assert!(preview_airgap_frames(&state, many).is_err());

        let long_frame = format!(
            "aiut-airgap://1/x/1/1/00000000?d={}",
            "A".repeat(crate::limits::MAX_AIRGAP_FRAME_URI_CHARS)
        );
        let error = preview_airgap_frames(&state, vec![long_frame]).unwrap_err();
        assert!(error.contains("rescan"), "{error}");
    }

    #[tokio::test]
    async fn test_airgap_roundtrip() {
        let dir = TempDir::new().unwrap();
        let state = Arc::new(AppState::new(dir.path().to_path_buf(), "token".into()).unwrap());

        state
            .persist_connected_account(
                crate::model::Account {
                    id: "acc-airgap".into(),
                    label: "Claude".into(),
                    provider: crate::model::Provider::Anthropic,
                    email: Some("airgap@example.com".into()),
                    provider_account_id: None,
                    chatgpt_account_id: None,
                    plan: None,
                    created_at: chrono::Utc::now().to_rfc3339(),
                    updated_at: chrono::Utc::now().to_rfc3339(),
                    last_usage: None,
                    last_error: None,
                    auth_required: false,
                },
                &crate::model::ProviderSecret::Anthropic(crate::model::OAuthSecret {
                    access_token: "a".into(),
                    refresh_token: "r".into(),
                    id_token: None,
                    expires_at: 0,
                }),
            )
            .await
            .unwrap();

        // Prepare export
        let export = prepare_airgap_export(&state).expect("Airgap export failed");
        assert!(!export.frames.is_empty());
        assert_eq!(export.frames.len(), export.total_chunks);

        // Collect frame URIs, shuffling them to simulate out-of-order camera reads
        let mut uris: Vec<String> = export.frames.into_iter().map(|f| f.uri).collect();
        uris.reverse();

        // The preview opens the frames and counts the accounts, importing nothing
        let dir2 = TempDir::new().unwrap();
        let state2 = Arc::new(AppState::new(dir2.path().to_path_buf(), "token2".into()).unwrap());
        let preview = preview_airgap_frames(&state2, uris.clone()).expect("Airgap preview failed");
        assert_eq!(preview.account_count, 1);
        assert_eq!(preview.total_chunks, export.total_chunks);
        assert_eq!(preview.session_id, export.session_id);
        assert!(state2.store.list().is_empty());

        let summary = import_airgap_payload(&state2, uris.clone(), &preview.ticket, true)
            .await
            .expect("Airgap import failed");
        assert_eq!(summary.skipped, 0);
        assert_eq!(summary.added, 1);

        // Test tampered frames fail the preview (checksum mismatch surfaces first)
        let mut tampered_uris = uris.clone();
        tampered_uris[0] = tampered_uris[0].replace("d=", "d=corrupted");
        let err = preview_airgap_frames(&state2, tampered_uris).unwrap_err();
        assert!(err.contains("checksum mismatch"));

        // Test corrupted URI fails checksum
        let preview = preview_airgap_frames(&state2, uris.clone()).unwrap();
        let mut corrupted_uris = uris.clone();
        corrupted_uris[0] = corrupted_uris[0].replace("d=", "d=corrupted");
        let err = import_airgap_payload(&state2, corrupted_uris, &preview.ticket, true)
            .await
            .unwrap_err();
        assert!(err.contains("checksum mismatch"));

        // Test empty frames list
        let preview = preview_airgap_frames(&state2, uris.clone()).unwrap();
        let err_empty = import_airgap_payload(&state2, vec![], &preview.ticket, true)
            .await
            .unwrap_err();
        assert!(err_empty.contains("No air-gap frames provided"));

        // Test missing frame (frame specifies total_chunks=2 but only 1 is provided)
        let preview = preview_airgap_frames(&state2, uris.clone()).unwrap();
        let incomplete_uri = uris[0].replace(
            &format!("/1/{}/", export.total_chunks),
            &format!("/1/{}/", export.total_chunks + 1),
        );
        let err_missing =
            import_airgap_payload(&state2, vec![incomplete_uri], &preview.ticket, true)
                .await
                .unwrap_err();
        assert!(err_missing.contains("Missing frames"));

        // Each export has its own session (and key)
        let export2 = prepare_airgap_export(&state).expect("Airgap export failed");
        assert_ne!(export2.session_id, export.session_id);
    }

    /// Frames re-made with valid checksums but changed bytes (someone editing
    /// the transfer) must fail to open: the encryption, not a human code
    /// comparison, is what guards integrity now.
    #[tokio::test]
    async fn altered_frames_with_valid_checksums_are_refused() {
        let dir = TempDir::new().unwrap();
        let state = Arc::new(AppState::new(dir.path().to_path_buf(), "token".into()).unwrap());
        let export = prepare_airgap_export(&state).expect("Airgap export failed");
        let mut uris: Vec<String> = export.frames.into_iter().map(|f| f.uri).collect();

        let last = uris.len() - 1;
        let chunk = parse_airgap_uri(&uris[last]).unwrap();
        let mut bytes = URL_SAFE_NO_PAD.decode(chunk.data.as_bytes()).unwrap();
        let end = bytes.len() - 1;
        bytes[end] ^= 0x01;
        let data = URL_SAFE_NO_PAD.encode(&bytes);
        uris[last] = format!(
            "{AIRGAP_URI_SCHEME}://1/{}/{}/{}/{}?d={data}",
            chunk.session_id,
            chunk.chunk_index,
            chunk.total_chunks,
            chunk_checksum(&data)
        );

        let dir2 = TempDir::new().unwrap();
        let state2 = Arc::new(AppState::new(dir2.path().to_path_buf(), "token2".into()).unwrap());
        assert!(preview_airgap_frames(&state2, uris.clone())
            .unwrap_err()
            .contains("Corrupted transfer"));
        assert!(import_airgap_payload(&state2, uris, "", true)
            .await
            .is_err());
        assert!(state2.store.list().is_empty());
    }

    async fn state_with_one_account(dir: &TempDir, id: &str, email: &str) -> Arc<AppState> {
        let state = Arc::new(AppState::new(dir.path().to_path_buf(), "token".into()).unwrap());
        state
            .persist_connected_account(
                crate::model::Account {
                    id: id.into(),
                    label: "Claude".into(),
                    provider: crate::model::Provider::Anthropic,
                    email: Some(email.into()),
                    provider_account_id: None,
                    chatgpt_account_id: None,
                    plan: None,
                    created_at: chrono::Utc::now().to_rfc3339(),
                    updated_at: chrono::Utc::now().to_rfc3339(),
                    last_usage: None,
                    last_error: None,
                    auth_required: false,
                },
                &crate::model::ProviderSecret::Anthropic(crate::model::OAuthSecret {
                    access_token: "a".into(),
                    refresh_token: "r".into(),
                    id_token: None,
                    expires_at: 0,
                }),
            )
            .await
            .unwrap();
        state
    }

    fn frame_uris(state: &AppState) -> Vec<String> {
        prepare_airgap_export(state)
            .unwrap()
            .frames
            .into_iter()
            .map(|frame| frame.uri)
            .collect()
    }

    /// The import has to present the ticket of the preview the user looked at,
    /// with those same frames, once (L-104).
    #[tokio::test]
    async fn an_import_only_applies_the_frames_its_preview_checked_once() {
        let sender_a_dir = TempDir::new().unwrap();
        let sender_b_dir = TempDir::new().unwrap();
        let sender_a = state_with_one_account(&sender_a_dir, "a", "a@example.com").await;
        let sender_b = state_with_one_account(&sender_b_dir, "b", "b@example.com").await;
        let frames_a = frame_uris(&sender_a);
        let frames_b = frame_uris(&sender_b);
        let dir = TempDir::new().unwrap();
        let receiver = Arc::new(AppState::new(dir.path().to_path_buf(), "token2".into()).unwrap());

        // No preview at all.
        let error = import_airgap_payload(&receiver, frames_a.clone(), "made-up", true)
            .await
            .unwrap_err();
        assert_eq!(error, STALE_PREVIEW_ERROR);

        // Preview A, import B with A's ticket.
        let preview_a = preview_airgap_frames(&receiver, frames_a.clone()).unwrap();
        let error = import_airgap_payload(&receiver, frames_b.clone(), &preview_a.ticket, true)
            .await
            .unwrap_err();
        assert_eq!(error, STALE_PREVIEW_ERROR);
        // That attempt used the ticket up.
        let error = import_airgap_payload(&receiver, frames_a.clone(), &preview_a.ticket, true)
            .await
            .unwrap_err();
        assert_eq!(error, STALE_PREVIEW_ERROR);

        // A late preview A ticket after a newer preview B no longer works.
        let preview_a = preview_airgap_frames(&receiver, frames_a.clone()).unwrap();
        let preview_b = preview_airgap_frames(&receiver, frames_b.clone()).unwrap();
        let error = import_airgap_payload(&receiver, frames_a.clone(), &preview_a.ticket, true)
            .await
            .unwrap_err();
        assert_eq!(error, STALE_PREVIEW_ERROR);
        assert!(receiver.store.list().is_empty());

        // The matching preview and frames import, and the ticket cannot be replayed.
        let preview_b2 = preview_airgap_frames(&receiver, frames_b.clone()).unwrap();
        assert_ne!(preview_b.ticket, preview_b2.ticket);
        let summary = import_airgap_payload(&receiver, frames_b.clone(), &preview_b2.ticket, true)
            .await
            .unwrap();
        assert_eq!(summary.added, 1);
        let error = import_airgap_payload(&receiver, frames_b, &preview_b2.ticket, true)
            .await
            .unwrap_err();
        assert_eq!(error, STALE_PREVIEW_ERROR);
        assert_eq!(receiver.store.list().len(), 1);
    }

    #[test]
    fn test_airgap_decompression_limit() {
        let oversized = vec![b'A'; 1024 * 1024];
        let compressed = miniz_oxide::deflate::compress_to_vec(&oversized, 6);
        let res = miniz_oxide::inflate::decompress_to_vec_with_limit(&compressed, 512 * 1024);
        assert!(
            res.is_err(),
            "Decompression exceeding limit must be rejected"
        );

        let res_ok =
            miniz_oxide::inflate::decompress_to_vec_with_limit(&compressed, 2 * 1024 * 1024);
        assert!(res_ok.is_ok(), "Decompression within limit must succeed");
    }

    #[test]
    fn debug_output_of_frames_shows_sizes_not_contents() {
        let frame = AirgapExportFrame {
            chunk_index: 0,
            total_chunks: 2,
            uri: "aiusage://airgap?d=SECRET_KEY_AND_CIPHERTEXT".into(),
            svg: "<svg>SECRET_QR</svg>".into(),
        };
        let export = AirgapExport {
            session_id: "abcd1234".into(),
            total_chunks: 2,
            frames: vec![frame.clone()],
        };
        let chunk = ParsedAirgapChunk {
            session_id: "abcd1234".into(),
            chunk_index: 0,
            total_chunks: 2,
            data: "SECRET_PAYLOAD".into(),
        };
        for text in [
            format!("{frame:?}"),
            format!("{export:?}"),
            format!("{chunk:?}"),
        ] {
            assert!(!text.contains("SECRET"), "{text}");
        }
        assert!(format!("{export:?}").contains("uri_len"));
    }
}

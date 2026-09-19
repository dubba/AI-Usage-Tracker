//! Air-gapped visual transfer using animated multi-frame QR codes.
//!
//! When devices are not on the same Wi-Fi network (e.g. mobile cellular vs
//! laptop Wi-Fi, or guest Wi-Fi client isolation), the sender displays an
//! animated looping sequence of QR codes. The receiver's camera captures all
//! frames and reassembles the payload.
//!
//! Like the Wi-Fi flow's SAS comparison, both sides independently display the
//! same short verification code: the sender shows the code for its payload,
//! and the receiver shows the code computed from the scanned frames. The user
//! confirms the codes match before anything is imported. A full screen
//! recording would capture the frames (which carry the transfer key), so the
//! code is a confirmation/integrity check — not secrecy from observers.

use crate::{
    pairing::{
        crypto::{decrypt_payload, encrypt_payload},
        payload::{create_export_payload, import_sync_payload, SyncSummary},
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
const AIRGAP_VERIFY_INFO: &[u8] = b"aiut-airgap-verify-v1";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AirgapExportFrame {
    pub chunk_index: usize,
    pub total_chunks: usize,
    pub uri: String,
    pub svg: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AirgapExport {
    pub session_id: String,
    pub verify_code: String,
    pub total_chunks: usize,
    pub frames: Vec<AirgapExportFrame>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AirgapVerifyResult {
    pub session_id: String,
    pub verify_code: String,
    pub total_chunks: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedAirgapChunk {
    pub session_id: String,
    pub chunk_index: usize,
    pub total_chunks: usize,
    pub data: String,
}

/// Computes the short verification code (e.g. "4F2A-8B91") shown on both
/// devices, mirroring the Wi-Fi flow's SAS format. Sender and receiver each
/// compute it independently over identical container bytes; the user confirms
/// the two screens match before importing.
pub fn compute_verify_code(session_id: &str, container: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(AIRGAP_VERIFY_INFO);
    hasher.update(session_id.as_bytes());
    hasher.update(container);
    let digest = hasher.finalize();

    format!(
        "{:02X}{:02X}-{:02X}{:02X}",
        digest[0], digest[1], digest[2], digest[3]
    )
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
    // complete frame capture is sufficient to decrypt — the verification code
    // below is the human confirmation step, not a second secret.
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
    let verify_code = compute_verify_code(&session_id, &container);
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
        verify_code,
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

    let path_segments: Vec<&str> = url
        .path_segments()
        .map(|s| s.collect())
        .unwrap_or_default();

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
/// `(session_id, container)` pair. Shared by verification and import so both
/// operate on identical bytes.
fn reassemble_container(raw_chunks: Vec<String>) -> Result<(String, usize, Vec<u8>), String> {
    if raw_chunks.is_empty() {
        return Err("No air-gap frames provided".into());
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

/// Verifies scanned frames and returns the verification code to display for
/// human comparison with the sender's screen. No data is imported.
pub fn verify_airgap_frames(raw_chunks: Vec<String>) -> Result<AirgapVerifyResult, String> {
    let (session_id, total_chunks, container) = reassemble_container(raw_chunks)?;
    if container.len() < 32 + 40 {
        return Err("Air-gap container is too short".into());
    }
    let verify_code = compute_verify_code(&session_id, &container);
    Ok(AirgapVerifyResult {
        session_id,
        verify_code,
        total_chunks,
    })
}

/// Reassembles captured airgap chunks, decrypts with the embedded transfer
/// key, decompresses, and imports. Call only after the user confirms the
/// verification code matches the sender's screen.
pub async fn import_airgap_payload(
    state: &Arc<AppState>,
    raw_chunks: Vec<String>,
) -> Result<SyncSummary, String> {
    let (_session_id, _total_chunks, container) = reassemble_container(raw_chunks)?;

    if container.len() < 32 + 40 {
        return Err("Air-gap container is too short".into());
    }

    let (key_bytes, ciphertext_with_nonce) = container.split_at(32);
    let mut key = [0u8; 32];
    key.copy_from_slice(key_bytes);

    let mut decompressed_bytes = match decrypt_payload(&key, AIRGAP_INFO, ciphertext_with_nonce) {
        Ok(compressed) => miniz_oxide::inflate::decompress_to_vec_with_limit(
            &compressed,
            MAX_AIRGAP_DECOMPRESSED_SIZE,
        )
        .map_err(|e| format!("Decompression failed: {e:?}"))?,
        Err(_) => {
            key.zeroize();
            return Err("Corrupted transfer. Please rescan the animated codes.".into());
        }
    };
    key.zeroize();

    let summary = import_sync_payload(state, &decompressed_bytes).await;
    decompressed_bytes.zeroize();
    summary
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::AppState;
    use std::sync::Arc;
    use tempfile::TempDir;

    #[tokio::test]
    async fn test_airgap_roundtrip() {
        let dir = TempDir::new().unwrap();
        let state = Arc::new(AppState::new(dir.path().to_path_buf(), "token".into()).unwrap());

        // Prepare export
        let export = prepare_airgap_export(&state).expect("Airgap export failed");
        assert!(!export.frames.is_empty());
        assert_eq!(export.frames.len(), export.total_chunks);
        assert_eq!(export.verify_code.len(), 9);

        // Collect frame URIs, shuffling them to simulate out-of-order camera reads
        let mut uris: Vec<String> = export.frames.into_iter().map(|f| f.uri).collect();
        uris.reverse();

        // Verify step returns the same code the sender displays
        let verify = verify_airgap_frames(uris.clone()).expect("Airgap verify failed");
        assert_eq!(verify.verify_code, export.verify_code);
        assert_eq!(verify.total_chunks, export.total_chunks);

        let dir2 = TempDir::new().unwrap();
        let state2 = Arc::new(AppState::new(dir2.path().to_path_buf(), "token2".into()).unwrap());
        let summary = import_airgap_payload(&state2, uris.clone())
            .await
            .expect("Airgap import failed");
        assert_eq!(summary.skipped, 0);

        // Test tampered frames fail verification (checksum mismatch surfaces first)
        let mut tampered_uris = uris.clone();
        tampered_uris[0] = tampered_uris[0].replace("d=", "d=corrupted");
        let err = verify_airgap_frames(tampered_uris)
            .unwrap_err();
        assert!(err.contains("checksum mismatch"));

        // Test corrupted URI fails checksum
        let mut corrupted_uris = uris.clone();
        corrupted_uris[0] = corrupted_uris[0].replace("d=", "d=corrupted");
        let err = import_airgap_payload(&state2, corrupted_uris)
            .await
            .unwrap_err();
        assert!(err.contains("checksum mismatch"));

        // Test empty frames list
        let err_empty = import_airgap_payload(&state2, vec![])
            .await
            .unwrap_err();
        assert!(err_empty.contains("No air-gap frames provided"));

        // Test missing frame (frame specifies total_chunks=2 but only 1 is provided)
        let incomplete_uri = uris[0].replace(&format!("/1/{}/", export.total_chunks), &format!("/1/{}/", export.total_chunks + 1));
        let err_missing = import_airgap_payload(&state2, vec![incomplete_uri])
            .await
            .unwrap_err();
        assert!(err_missing.contains("Missing frames"));

        // Verify codes differ across transfers (random key + session per export)
        let export2 = prepare_airgap_export(&state).expect("Airgap export failed");
        assert_ne!(export2.session_id, export.session_id);
        assert_ne!(export2.verify_code, export.verify_code);
    }

    #[test]
    fn test_airgap_decompression_limit() {
        let oversized = vec![b'A'; 1024 * 1024];
        let compressed = miniz_oxide::deflate::compress_to_vec(&oversized, 6);
        let res = miniz_oxide::inflate::decompress_to_vec_with_limit(&compressed, 512 * 1024);
        assert!(res.is_err(), "Decompression exceeding limit must be rejected");

        let res_ok = miniz_oxide::inflate::decompress_to_vec_with_limit(&compressed, 2 * 1024 * 1024);
        assert!(res_ok.is_ok(), "Decompression within limit must succeed");
    }
}

use chacha20poly1305::{
    aead::{Aead, KeyInit, Payload},
    XChaCha20Poly1305, XNonce,
};
use hkdf::Hkdf;
use rand::RngCore;
use sha2::{Digest, Sha256};
use spake2::{Ed25519Group, Identity, Password, Spake2};
use subtle::ConstantTimeEq;
use zeroize::Zeroize;

pub const KEY_INFO: &[u8] = b"ai-usage-tracker-pairing-v2";
/// Proves the joiner derived the same key, so it knew the link code.
pub const KEY_CONFIRM_JOINER_INFO: &[u8] = b"ai-usage-tracker-key-confirm-joiner";
/// Proves the host derived the same key, so it is the device showing the code.
pub const KEY_CONFIRM_HOST_INFO: &[u8] = b"ai-usage-tracker-key-confirm-host";
pub const CONFIRM_RECEIVER_INFO: &[u8] = b"ai-usage-tracker-confirm-receiver";
pub const CONFIRM_SENDER_INFO: &[u8] = b"ai-usage-tracker-confirm-sender";

const JOINER_IDENTITY: &[u8] = b"ai-usage-tracker-pairing-joiner";
const HOST_IDENTITY: &[u8] = b"ai-usage-tracker-pairing-host";

/// One side of the link-code key exchange (SPAKE2).
///
/// The six-digit code is the shared password. Each side sends one message;
/// neither message lets an observer test codes offline, and a peer that does
/// not know the code ends up with a different key. That shows up when the
/// confirmation tags are compared, so each connection is one guess at the code.
pub struct PakeExchange {
    state: Spake2<Ed25519Group>,
}

impl PakeExchange {
    /// The device that typed the code. Returns the message to send to the host.
    pub fn start_joiner(code: &str) -> (Self, Vec<u8>) {
        let (state, message) = Spake2::<Ed25519Group>::start_a(
            &Password::new(code.as_bytes()),
            &Identity::new(JOINER_IDENTITY),
            &Identity::new(HOST_IDENTITY),
        );
        (Self { state }, message)
    }

    /// The device that shows the code. Returns the message to send to the joiner.
    pub fn start_host(code: &str) -> (Self, Vec<u8>) {
        let (state, message) = Spake2::<Ed25519Group>::start_b(
            &Password::new(code.as_bytes()),
            &Identity::new(JOINER_IDENTITY),
            &Identity::new(HOST_IDENTITY),
        );
        (Self { state }, message)
    }

    /// Derives the session key from the peer's message. `salt` is the host's
    /// session nonce. A malformed message is an error; a wrong code is not: it
    /// yields a key the peer does not share.
    pub fn finish(self, peer_message: &[u8], salt: &[u8]) -> Result<[u8; 32], String> {
        let mut shared = self
            .state
            .finish(peer_message)
            .map_err(|_| "The other device sent an invalid key exchange message.".to_string())?;
        let hk = Hkdf::<Sha256>::new(Some(salt), &shared);
        shared.zeroize();
        let mut key = [0u8; 32];
        hk.expand(KEY_INFO, &mut key)
            .map_err(|_| "Failed to derive the pairing key".to_string())?;
        Ok(key)
    }
}

/// Builds the transcript the confirmation tags and the payload encryption are
/// bound to: `session_id (16B) || session_nonce || joiner message || host message`.
pub fn build_transcript(
    session_id: &[u8; 16],
    session_nonce: &[u8],
    joiner_message: &[u8],
    host_message: &[u8],
) -> Vec<u8> {
    let mut transcript =
        Vec::with_capacity(16 + session_nonce.len() + joiner_message.len() + host_message.len());
    transcript.extend_from_slice(session_id);
    transcript.extend_from_slice(session_nonce);
    transcript.extend_from_slice(joiner_message);
    transcript.extend_from_slice(host_message);
    transcript
}

/// A tag only a holder of `encryption_key` can compute for this session.
/// `role_info` separates the tags so one side's tag cannot be replayed as the
/// other's.
pub fn compute_confirmation_tag(
    encryption_key: &[u8; 32],
    transcript: &[u8],
    role_info: &[u8],
) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(role_info);
    hasher.update(encryption_key);
    hasher.update(transcript);
    let mut tag = [0u8; 32];
    tag.copy_from_slice(&hasher.finalize());
    tag
}

/// Verifies a confirmation tag in constant time.
pub fn verify_confirmation_tag(
    encryption_key: &[u8; 32],
    transcript: &[u8],
    role_info: &[u8],
    received_tag: &[u8; 32],
) -> bool {
    let expected = compute_confirmation_tag(encryption_key, transcript, role_info);
    expected.ct_eq(received_tag).into()
}

/// Encrypts plaintext using XChaCha20-Poly1305 with a 24-byte random nonce and AAD.
/// Returns `[24 bytes nonce] || [ciphertext + 16 bytes tag]`.
pub fn encrypt_payload(
    encryption_key: &[u8; 32],
    aad: &[u8],
    plaintext: &[u8],
) -> Result<Vec<u8>, String> {
    let cipher = XChaCha20Poly1305::new(encryption_key.into());
    let mut nonce_bytes = [0u8; 24];
    rand::rngs::OsRng.fill_bytes(&mut nonce_bytes);
    let nonce = XNonce::from_slice(&nonce_bytes);

    let payload = Payload {
        msg: plaintext,
        aad,
    };

    let ciphertext = cipher
        .encrypt(nonce, payload)
        .map_err(|e| format!("Encryption error: {e}"))?;

    let mut out = Vec::with_capacity(24 + ciphertext.len());
    out.extend_from_slice(&nonce_bytes);
    out.extend_from_slice(&ciphertext);
    Ok(out)
}

/// Decrypts payload using XChaCha20-Poly1305.
/// Input must be at least 24 bytes (nonce) + 16 bytes (Poly1305 tag).
pub fn decrypt_payload(
    encryption_key: &[u8; 32],
    aad: &[u8],
    ciphertext_with_nonce: &[u8],
) -> Result<Vec<u8>, String> {
    if ciphertext_with_nonce.len() < 40 {
        return Err("Ciphertext too short".into());
    }

    let (nonce_bytes, ciphertext) = ciphertext_with_nonce.split_at(24);
    let nonce = XNonce::from_slice(nonce_bytes);
    let cipher = XChaCha20Poly1305::new(encryption_key.into());

    let payload = Payload {
        msg: ciphertext,
        aad,
    };

    cipher
        .decrypt(nonce, payload)
        .map_err(|_| "Decryption or authentication tag failure".to_string())
}

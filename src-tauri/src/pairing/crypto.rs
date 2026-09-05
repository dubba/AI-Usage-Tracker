use chacha20poly1305::{
    aead::{Aead, KeyInit, Payload},
    XChaCha20Poly1305, XNonce,
};
use hkdf::Hkdf;
use rand::RngCore;
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use x25519_dalek::{PublicKey, StaticSecret};
use zeroize::{Zeroize, ZeroizeOnDrop};

pub const KEY_INFO: &[u8] = b"ai-usage-tracker-pairing-v1";
pub const SAS_INFO: &[u8] = b"ai-usage-tracker-sas-v1";
pub const CONFIRM_RECEIVER_INFO: &[u8] = b"ai-usage-tracker-confirm-receiver";
pub const CONFIRM_SENDER_INFO: &[u8] = b"ai-usage-tracker-confirm-sender";

#[derive(Zeroize, ZeroizeOnDrop)]
pub struct EphemeralKeyPair {
    secret: StaticSecret,
    #[zeroize(skip)]
    public: PublicKey,
}

impl EphemeralKeyPair {
    pub fn generate() -> Self {
        let mut rng = rand::rngs::OsRng;
        let secret = StaticSecret::random_from_rng(&mut rng);
        let public = PublicKey::from(&secret);
        Self { secret, public }
    }

    #[allow(dead_code)]
    pub fn public_key(&self) -> &PublicKey {
        &self.public
    }

    pub fn public_bytes(&self) -> [u8; 32] {
        *self.public.as_bytes()
    }

    pub fn diffie_hellman(self, peer_public: &PublicKey) -> Result<DerivedKeys, String> {
        let shared = self.secret.diffie_hellman(peer_public);
        // Reject low-order (non-contributory) peer public keys: they force a
        // predictable all-zero shared secret, which would make the derived
        // encryption key and SAS code attacker-known.
        if !bool::from(shared.was_contributory()) {
            return Err(
                "Peer public key is invalid (non-contributory). Aborting pairing.".to_string(),
            );
        }
        Ok(DerivedKeys::from_shared_secret(shared.as_bytes()))
    }
}

#[derive(Zeroize, ZeroizeOnDrop)]
pub struct DerivedKeys {
    shared_secret: [u8; 32],
}

impl DerivedKeys {
    pub fn from_shared_secret(shared: &[u8; 32]) -> Self {
        Self {
            shared_secret: *shared,
        }
    }

    pub fn derive_encryption_key(&self, salt: &[u8]) -> Result<[u8; 32], String> {
        let hk = Hkdf::<Sha256>::new(Some(salt), &self.shared_secret);
        let mut key = [0u8; 32];
        hk.expand(KEY_INFO, &mut key)
            .map_err(|_| "Failed to expand HKDF encryption key".to_string())?;
        Ok(key)
    }
}

/// Builds the transcript for SAS derivation and AAD binding:
/// `session_id (16B) || session_nonce (32B) || receiver_pubkey (32B) || sender_pubkey (32B)`
pub fn build_transcript(
    session_id: &[u8; 16],
    session_nonce: &[u8],
    receiver_pubkey: &[u8; 32],
    sender_pubkey: &[u8; 32],
) -> Vec<u8> {
    let mut transcript = Vec::with_capacity(16 + session_nonce.len() + 32 + 32);
    transcript.extend_from_slice(session_id);
    transcript.extend_from_slice(session_nonce);
    transcript.extend_from_slice(receiver_pubkey);
    transcript.extend_from_slice(sender_pubkey);
    transcript
}

/// Computes the 8-character hex SAS fingerprint (e.g. "4F2A-8B91").
pub fn compute_sas_code(encryption_key: &[u8; 32], transcript: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(SAS_INFO);
    hasher.update(encryption_key);
    hasher.update(transcript);
    let digest = hasher.finalize();

    format!(
        "{:02X}{:02X}-{:02X}{:02X}",
        digest[0], digest[1], digest[2], digest[3]
    )
}

/// Computes a constant-time verification authentication tag for SAS confirmation.
pub fn compute_confirmation_tag(
    encryption_key: &[u8; 32],
    sas_code: &str,
    role_info: &[u8],
) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(role_info);
    hasher.update(encryption_key);
    hasher.update(sas_code.as_bytes());
    let mut tag = [0u8; 32];
    tag.copy_from_slice(&hasher.finalize());
    tag
}

/// Verifies a confirmation tag in constant time.
pub fn verify_confirmation_tag(
    encryption_key: &[u8; 32],
    sas_code: &str,
    role_info: &[u8],
    received_tag: &[u8; 32],
) -> bool {
    let expected = compute_confirmation_tag(encryption_key, sas_code, role_info);
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

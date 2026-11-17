use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use uuid::Uuid;

/// Version 2: the six-digit link code is the shared secret of a password-authenticated key
/// exchange. Version 1 announced the code on the network and relied on both users comparing a
/// verification code; a version 1 device cannot pair with this one.
pub const PROTOCOL_VERSION: u32 = 2;
/// The version older builds announce, recognised only to tell the user to update that device.
pub const LEGACY_PROTOCOL_VERSION: u32 = 1;

pub const MAX_FRAME_SIZE: usize = 16 * 1024 * 1024; // 16 MB (encrypted payload only, post-confirmation)
/// Maximum frame size permitted before both sides confirmed the transfer.
/// Handshake init is 50 bytes, handshake resp 34, key confirm 33, role select
/// <= 4, transfer confirm 34, abort 2. 1 KiB leaves ample room while
/// preventing unauthenticated 16 MB allocations (memory-DoS).
pub const MAX_PREAUTH_FRAME_SIZE: usize = 1024;
/// Maximum frame size for small authenticated control frames (ACK, role resp).
pub const MAX_CONTROL_FRAME_SIZE: usize = 1024;

pub const MSG_HANDSHAKE_INIT: u8 = 0x01;
pub const MSG_HANDSHAKE_RESP: u8 = 0x02;
pub const MSG_TRANSFER_CONFIRM: u8 = 0x03;
pub const MSG_ENCRYPTED_PAYLOAD: u8 = 0x04;
pub const MSG_ACK: u8 = 0x05;
pub const MSG_KEY_CONFIRM: u8 = 0x06;
pub const MSG_ROLE_SELECT: u8 = 0x10;
pub const MSG_ROLE_SELECT_RESP: u8 = 0x11;
pub const MSG_ABORT: u8 = 0xFF;

/// Length of one side's key exchange message on the wire (SPAKE2 over Ed25519:
/// a side byte and a compressed point).
pub const PAKE_MESSAGE_LEN: usize = 33;
/// Length of the session id (a UUID) on the wire.
pub const SESSION_ID_LEN: usize = 16;
/// `MSG_HANDSHAKE_INIT` payload: the joiner's key exchange message, then the session id.
pub const HANDSHAKE_INIT_LEN: usize = PAKE_MESSAGE_LEN + SESSION_ID_LEN;
/// The one-byte payload of the `MSG_ROLE_SELECT_RESP` that answers a joiner who sends.
pub const RESP_OK: u8 = 0x00;
/// First byte of `MSG_ROLE_SELECT`: the joiner sends its accounts, so the host receives.
pub const ROLE_JOINER_SENDS: u8 = 0x01;
/// First byte of `MSG_ROLE_SELECT`: the joiner receives, so the host sends.
pub const ROLE_JOINER_RECEIVES: u8 = 0x02;
/// Length of a confirmation tag (`MSG_KEY_CONFIRM`, `MSG_TRANSFER_CONFIRM`).
pub const CONFIRM_TAG_LEN: usize = 32;
/// First byte of `MSG_TRANSFER_CONFIRM`: this side agreed to the transfer.
pub const TRANSFER_ACCEPTED: u8 = 0x01;
/// `MSG_TRANSFER_CONFIRM` payload: the accept byte, then the confirmation tag.
pub const TRANSFER_CONFIRM_LEN: usize = 1 + CONFIRM_TAG_LEN;

/// The one-byte payload of an `MSG_ABORT` frame: why this side gave up. The
/// peer does not act on the value (any abort ends its read), so it is there
/// for diagnosis only. The numbers are on the wire; do not renumber them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum AbortReason {
    /// Host: the handshake init was malformed, for another session, or timed out.
    BadHandshake = 0x01,
    // 0x02 and 0x03 were used by protocol version 1; they stay unused.
    /// Host: the joiner sent a bad role selection or disconnected before choosing.
    RoleSelectFailed = 0x04,
    /// Host: the joiner did not choose a role in time.
    RoleSelectTimedOut = 0x05,
    /// Joiner: the user canceled before choosing a role.
    CanceledBeforeRole = 0x06,
    /// Joiner: the role choice was dropped without an answer.
    RoleChoiceDropped = 0x07,
    /// Either side: the user canceled before the transfer was confirmed.
    CanceledBeforeConfirm = 0x08,
    /// Sender: the user declined to send.
    TransferDeclined = 0x09,
    /// Receiver: the encrypted payload could not be read or decrypted.
    PayloadInvalid = 0x0A,
    /// Receiver: the encrypted payload did not arrive in time.
    PayloadTimedOut = 0x0B,
    /// Receiver: the payload decrypted but could not be imported.
    ImportFailed = 0x0C,
    /// Host: the joiner's key exchange message was malformed.
    InvalidPeerKey = 0x0D,
    /// Either side: the peer did not prove it knows the link code.
    WrongCode = 0x0E,
    /// Joiner: the app asked for a role other than send or receive.
    InvalidRole = 0x10,
}

impl AbortReason {
    /// The `MSG_ABORT` payload for this reason.
    pub const fn payload(self) -> [u8; 1] {
        [self as u8]
    }
}

/// Pairing must stay on the local network. The host must be an IP literal
/// (no DNS names, to avoid DNS-rebinding style redirects) in a private,
/// loopback, link-local, or CGNAT (Tailscale) range.
pub(crate) fn is_allowed_pairing_host(host: &str) -> bool {
    use std::net::IpAddr;
    let host = host
        .strip_prefix('[')
        .and_then(|h| h.strip_suffix(']'))
        .unwrap_or(host);
    match host.parse::<IpAddr>() {
        Ok(IpAddr::V4(v4)) => {
            let octets = v4.octets();
            v4.is_private()
                || v4.is_loopback()
                || v4.is_link_local()
                // CGNAT range 100.64.0.0/10 (e.g. Tailscale mesh IPs)
                || (octets[0] == 100 && (64..=127).contains(&octets[1]))
        }
        Ok(IpAddr::V6(v6)) => {
            let segments = v6.segments();
            v6.is_loopback()
                // ULA fc00::/7
                || (segments[0] & 0xfe00) == 0xfc00
                // Link-local fe80::/10
                || (segments[0] & 0xffc0) == 0xfe80
        }
        Err(_) => false,
    }
}

/// A pairing host found on the local network. Nothing here is secret or
/// trusted: the link code, which is never announced, authenticates the host.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiscoveredHost {
    pub host: String,
    pub port: u16,
    pub session_id: Uuid,
    pub session_nonce: Vec<u8>,
}

/// Reads a length-prefixed frame: `[4 bytes length][1 byte type][payload]`
/// using the maximum (post-authentication) frame budget. Production code
/// reads with [`read_frame_limited`] and an explicit budget.
#[cfg(test)]
pub async fn read_frame<R: AsyncRead + Unpin>(reader: &mut R) -> Result<(u8, Vec<u8>), String> {
    read_frame_limited(reader, MAX_FRAME_SIZE).await
}

/// Reads a length-prefixed frame with an explicit budget. Unauthenticated
/// callers must pass [`MAX_PREAUTH_FRAME_SIZE`] so a LAN peer cannot force a
/// 16 MB allocation before authentication.
pub async fn read_frame_limited<R: AsyncRead + Unpin>(
    reader: &mut R,
    max_frame_size: usize,
) -> Result<(u8, Vec<u8>), String> {
    let mut len_buf = [0u8; 4];
    reader
        .read_exact(&mut len_buf)
        .await
        .map_err(|e| format!("Socket read error (length prefix): {e}"))?;

    let frame_len = u32::from_be_bytes(len_buf) as usize;
    if frame_len < 1 {
        return Err("Malformed frame: length is zero".into());
    }
    if frame_len > max_frame_size {
        return Err(format!(
            "Frame length {} exceeds maximum allowed size {}",
            frame_len, max_frame_size
        ));
    }

    let mut msg_type_buf = [0u8; 1];
    reader
        .read_exact(&mut msg_type_buf)
        .await
        .map_err(|e| format!("Socket read error (message type): {e}"))?;

    let payload_len = frame_len - 1;
    let mut payload = vec![0u8; payload_len];
    if payload_len > 0 {
        reader
            .read_exact(&mut payload)
            .await
            .map_err(|e| format!("Socket read error (payload): {e}"))?;
    }

    Ok((msg_type_buf[0], payload))
}

/// Writes a length-prefixed frame: `[4 bytes length][1 byte type][payload]`
pub async fn write_frame<W: AsyncWrite + Unpin>(
    writer: &mut W,
    msg_type: u8,
    payload: &[u8],
) -> Result<(), String> {
    let frame_len = 1 + payload.len();
    if frame_len > MAX_FRAME_SIZE {
        return Err(format!(
            "Outgoing frame length {} exceeds maximum {}",
            frame_len, MAX_FRAME_SIZE
        ));
    }

    let len_bytes = (frame_len as u32).to_be_bytes();
    writer
        .write_all(&len_bytes)
        .await
        .map_err(|e| format!("Socket write error (length prefix): {e}"))?;
    writer
        .write_all(&[msg_type])
        .await
        .map_err(|e| format!("Socket write error (message type): {e}"))?;

    if !payload.is_empty() {
        writer
            .write_all(payload)
            .await
            .map_err(|e| format!("Socket write error (payload): {e}"))?;
    }

    writer
        .flush()
        .await
        .map_err(|e| format!("Socket flush error: {e}"))?;

    Ok(())
}

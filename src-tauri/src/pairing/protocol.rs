use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use url::Url;
use uuid::Uuid;

pub const PROTOCOL_VERSION: u32 = 1;

/// Bracket IPv6 literals so `host:port` is unambiguous in pairing URIs.
pub fn format_uri_host(host: &str) -> String {
    let host = host
        .strip_prefix('[')
        .and_then(|h| h.strip_suffix(']'))
        .unwrap_or(host);
    if host.parse::<std::net::Ipv6Addr>().is_ok() {
        format!("[{host}]")
    } else {
        host.to_string()
    }
}
pub const PAIRING_SCHEME: &str = "aiusage-pair";
pub const SECONDARY_PAIRING_SCHEME: &str = "aiusage";
pub const MAX_FRAME_SIZE: usize = 16 * 1024 * 1024; // 16 MB (encrypted payload only, post-SAS)
/// Maximum frame size permitted before SAS mutual confirmation succeeds.
/// Handshake init is 49 bytes, role select <= 4 bytes, SAS confirm 34 bytes,
/// abort 2 bytes, handshake resp 2 bytes. 1 KiB leaves ample room while
/// preventing unauthenticated 16 MB allocations (memory-DoS).
pub const MAX_PREAUTH_FRAME_SIZE: usize = 1024;
/// Maximum frame size for small authenticated control frames (ACK, role resp).
pub const MAX_CONTROL_FRAME_SIZE: usize = 1024;

pub const MSG_HANDSHAKE_INIT: u8 = 0x01;
pub const MSG_HANDSHAKE_RESP: u8 = 0x02;
pub const MSG_SAS_CONFIRM: u8 = 0x03;
pub const MSG_ENCRYPTED_PAYLOAD: u8 = 0x04;
pub const MSG_ACK: u8 = 0x05;
pub const MSG_ROLE_SELECT: u8 = 0x10;
pub const MSG_ROLE_SELECT_RESP: u8 = 0x11;
pub const MSG_ABORT: u8 = 0xFF;

/// Pairing must stay on the local network. The host must be an IP literal
/// (no DNS names, to avoid DNS-rebinding style redirects) in a private,
/// loopback, link-local, or CGNAT (Tailscale) range.
pub(crate) fn is_allowed_pairing_host(host: &str) -> bool {
    use std::net::IpAddr;
    // url::Url::host_str() keeps square brackets around IPv6 literals.
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

pub fn compute_display_fingerprint(
    session_id: &Uuid,
    public_key: &[u8; 32],
    nonce: &[u8],
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(session_id.as_bytes());
    hasher.update(public_key);
    hasher.update(nonce);
    let digest = hasher.finalize();
    format!(
        "{:02X}{:02X}-{:02X}{:02X}",
        digest[0], digest[1], digest[2], digest[3]
    )
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedQrPayload {
    pub host: String,
    pub port: u16,
    pub session_id: Uuid,
    pub peer_public_key: [u8; 32],
    pub session_nonce: Vec<u8>,
    pub fingerprint: String,
    pub version: u32,
}

impl ParsedQrPayload {
    pub fn to_uri(&self) -> String {
        let pk_b64 = URL_SAFE_NO_PAD.encode(self.peer_public_key);
        let nonce_b64 = URL_SAFE_NO_PAD.encode(&self.session_nonce);
        format!(
            "{}://{}:{}?session_id={}&pk={}&nonce={}&fp={}&v={}",
            PAIRING_SCHEME,
            format_uri_host(&self.host),
            self.port,
            self.session_id,
            pk_b64,
            nonce_b64,
            self.fingerprint,
            self.version
        )
    }

    pub fn parse(raw_uri: &str) -> Result<Self, String> {
        let trimmed = raw_uri.trim();
        let url = Url::parse(trimmed).map_err(|e| format!("Invalid pairing URI: {e}"))?;

        let scheme = url.scheme();
        if scheme != PAIRING_SCHEME && scheme != SECONDARY_PAIRING_SCHEME {
            return Err(format!(
                "Unsupported scheme '{scheme}'. Expected '{PAIRING_SCHEME}'."
            ));
        }

        let host_raw = url
            .host_str()
            .ok_or_else(|| "Pairing URI missing host".to_string())?;
        // url::Url::host_str() keeps square brackets around IPv6 literals.
        let host = host_raw
            .strip_prefix('[')
            .and_then(|h| h.strip_suffix(']'))
            .unwrap_or(host_raw)
            .to_string();

        if host.is_empty()
            || host.contains('/')
            || host.contains('\\')
            || host.contains('?')
            || host.contains('#')
        {
            return Err("Invalid host in pairing URI".to_string());
        }

        if !is_allowed_pairing_host(&host) {
            return Err(
                "Pairing host must be a local network address (private, loopback, or link-local IP). Refusing to connect."
                    .to_string(),
            );
        }

        let port = url
            .port()
            .ok_or_else(|| "Pairing URI missing port".to_string())?;

        let mut session_id = None;
        let mut public_key = None;
        let mut session_nonce = None;
        let mut fingerprint = None;
        let mut version = None;

        for (k, v) in url.query_pairs() {
            match k.as_ref() {
                "session_id" => {
                    let uuid = Uuid::parse_str(&v)
                        .map_err(|e| format!("Invalid session_id UUID: {e}"))?;
                    session_id = Some(uuid);
                }
                "pk" => {
                    let decoded = URL_SAFE_NO_PAD
                        .decode(v.as_bytes())
                        .or_else(|_| {
                            base64::engine::general_purpose::STANDARD.decode(v.as_bytes())
                        })
                        .map_err(|e| format!("Invalid base64 in public key: {e}"))?;

                    if decoded.len() != 32 {
                        return Err(format!(
                            "Invalid public key length: expected 32 bytes, got {}",
                            decoded.len()
                        ));
                    }
                    let mut pk = [0u8; 32];
                    pk.copy_from_slice(&decoded);
                    public_key = Some(pk);
                }
                "nonce" => {
                    let decoded = URL_SAFE_NO_PAD
                        .decode(v.as_bytes())
                        .or_else(|_| {
                            base64::engine::general_purpose::STANDARD.decode(v.as_bytes())
                        })
                        .map_err(|e| format!("Invalid base64 in nonce: {e}"))?;

                    if decoded.len() < 16 || decoded.len() > 64 {
                        return Err(format!("Invalid nonce length: {} bytes", decoded.len()));
                    }
                    session_nonce = Some(decoded);
                }
                "fp" => {
                    if !v.is_empty() {
                        fingerprint = Some(v.to_string());
                    }
                }
                "v" => {
                    let parsed: u32 = v
                        .parse()
                        .map_err(|_| "Invalid protocol version".to_string())?;
                    version = Some(parsed);
                }
                _ => {}
            }
        }

        let session_id = session_id.ok_or_else(|| "Missing session_id in URI".to_string())?;
        let public_key = public_key.ok_or_else(|| "Missing pk in URI".to_string())?;
        let session_nonce = session_nonce.ok_or_else(|| "Missing nonce in URI".to_string())?;
        let version = version.unwrap_or(PROTOCOL_VERSION);

        if version != PROTOCOL_VERSION {
            return Err(format!("Incompatible pairing protocol version: {version}"));
        }

        let calculated_fp = compute_display_fingerprint(&session_id, &public_key, &session_nonce);
        // Never trust a peer-supplied fingerprint for display: recompute locally
        // and reject mismatches so a crafted QR/deep-link cannot spoof the
        // verification string shown next to the SAS code.
        if let Some(provided) = fingerprint {
            if provided.to_ascii_uppercase() != calculated_fp {
                return Err(
                    "Pairing fingerprint mismatch: the code in the QR does not match its key. Refusing to connect."
                        .to_string(),
                );
            }
        }
        let fp = calculated_fp;

        Ok(Self {
            host,
            port,
            session_id,
            peer_public_key: public_key,
            session_nonce,
            fingerprint: fp,
            version,
        })
    }
}

/// Reads a length-prefixed frame: `[4 bytes length][1 byte type][payload]`
/// using the maximum (post-authentication) frame budget. Prefer
/// [`read_frame_limited`] with [`MAX_PREAUTH_FRAME_SIZE`] for any frame
/// received before SAS confirmation succeeds.
#[allow(dead_code)]
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

pub fn generate_qr_uri(
    host: &str,
    port: u16,
    public_key: &[u8; 32],
    session_id: Uuid,
    nonce: &[u8],
) -> String {
    let fp = compute_display_fingerprint(&session_id, public_key, nonce);
    ParsedQrPayload {
        host: host.to_string(),
        port,
        session_id,
        peer_public_key: *public_key,
        session_nonce: nonce.to_vec(),
        fingerprint: fp,
        version: PROTOCOL_VERSION,
    }
    .to_uri()
}

pub fn parse_qr_uri(raw_uri: &str) -> Result<ParsedQrPayload, String> {
    ParsedQrPayload::parse(raw_uri)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn format_uri_host_brackets_ipv6_literals() {
        assert_eq!(format_uri_host("::1"), "[::1]");
        assert_eq!(format_uri_host("[::1]"), "[::1]");
        assert_eq!(
            format_uri_host("fd12:3456:789a::1"),
            "[fd12:3456:789a::1]"
        );
        assert_eq!(format_uri_host("127.0.0.1"), "127.0.0.1");
        assert_eq!(format_uri_host("192.168.1.5"), "192.168.1.5");
        assert_eq!(format_uri_host("localhost"), "localhost");
    }
}

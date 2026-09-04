//! mDNS/Bonjour short-code discovery for pairing.
//!
//! The host advertises `_aiut-pair._tcp.local` with the 6-digit join code in
//! the instance name and the pairing session parameters (session id, public
//! key, nonce) in TXT records. A joiner types the 6-digit code, browses for
//! the matching instance, resolves host/port, and reconstructs the same
//! `ParsedQrPayload` a QR scan would have produced.
//!
//! The code is a *discovery handle*, not a secret: security comes from the
//! ECDH exchange and SAS comparison performed after the TCP connection.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use mdns_sd::{Receiver, ServiceDaemon, ServiceEvent, ServiceInfo};
use rand::Rng;
use uuid::Uuid;

use super::protocol::{compute_display_fingerprint, ParsedQrPayload, PROTOCOL_VERSION};

pub const SERVICE_TYPE: &str = "_aiut-pair._tcp.local.";
const CODE_DIGITS: usize = 6;
const RESOLVE_TIMEOUT_MS: u64 = 15_000;
/// Failed join-by-code lookups per code before the joiner is locked out.
/// The code is a discovery handle, not authentication — SAS still authenticates.
pub const MAX_JOIN_ATTEMPTS: u8 = 5;

fn instance_name(code: &str) -> String {
    format!("AIUT-{code}")
}

pub fn is_valid_join_code(code: &str) -> bool {
    code.len() == CODE_DIGITS && code.bytes().all(|b| b.is_ascii_digit())
}

/// Rejects trivial LAN codes (all identical digits or strictly sequential).
/// Collision resistance on a local segment is the goal; this is not entropy for auth.
pub fn is_weak_join_code(code: &str) -> bool {
    if !is_valid_join_code(code) {
        return true;
    }
    let digits: Vec<u8> = code.bytes().map(|b| b - b'0').collect();
    if digits.iter().all(|&d| d == digits[0]) {
        return true;
    }
    let ascending = digits.windows(2).all(|w| w[1] == w[0] + 1);
    let descending = digits.windows(2).all(|w| w[0] == w[1] + 1);
    ascending || descending
}

/// Generates a random 6-digit numeric join code (leading zeros allowed).
pub fn generate_join_code() -> String {
    let mut rng = rand::thread_rng();
    loop {
        let value = rng.gen_range(0..1_000_000u32);
        let code = format!("{value:06}");
        if !is_weak_join_code(&code) {
            return code;
        }
    }
}

pub struct MdnsAdvertisement {
    daemon: ServiceDaemon,
    fullname: String,
}

impl MdnsAdvertisement {
    pub fn unregister(self) {
        drop(self);
    }
}

impl Drop for MdnsAdvertisement {
    fn drop(&mut self) {
        let _ = self.daemon.unregister(&self.fullname);
        let _ = self.daemon.shutdown();
    }
}

/// Advertise this pairing host on the LAN under the given join code.
pub fn advertise(
    code: &str,
    host_ip: &str,
    port: u16,
    session_id: Uuid,
    public_key: &[u8; 32],
    nonce: &[u8],
) -> Result<MdnsAdvertisement, String> {
    if !is_valid_join_code(code) {
        return Err("Pairing code must be 6 digits".into());
    }

    let daemon = ServiceDaemon::new().map_err(|e| format!("mDNS unavailable: {e}"))?;
    let host_name = format!("aiut-{}.local.", session_id.simple());
    let properties = [
        ("sid", session_id.to_string()),
        ("pk", URL_SAFE_NO_PAD.encode(public_key)),
        ("nonce", URL_SAFE_NO_PAD.encode(nonce)),
        ("v", PROTOCOL_VERSION.to_string()),
    ];
    let info = ServiceInfo::new(
        SERVICE_TYPE,
        &instance_name(code),
        &host_name,
        host_ip,
        port,
        &properties[..],
    )
    .map_err(|e| format!("Invalid mDNS service info: {e}"))?;
    // Host side doesn't need to announce hostnames separately.
    let fullname = info.get_fullname().to_string();
    daemon
        .register(info)
        .map_err(|e| format!("Failed to advertise pairing service: {e}"))?;

    Ok(MdnsAdvertisement { daemon, fullname })
}

/// Look up a pairing host by its 6-digit code and rebuild the QR payload.
pub async fn resolve(code: &str) -> Result<ParsedQrPayload, String> {
    if !is_valid_join_code(code) {
        return Err("Pairing code must be 6 digits".into());
    }

    let target_fullname = format!("{}.{}", instance_name(code), SERVICE_TYPE);
    let daemon = ServiceDaemon::new().map_err(|e| format!("mDNS unavailable: {e}"))?;
    let receiver = daemon
        .browse(SERVICE_TYPE)
        .map_err(|e| format!("Failed to browse for pairing services: {e}"))?;

    let result = tokio::time::timeout(
        std::time::Duration::from_millis(RESOLVE_TIMEOUT_MS),
        wait_for_resolution(&receiver, &target_fullname),
    )
    .await;

    let _ = daemon.stop_browse(SERVICE_TYPE);
    let _ = daemon.shutdown();

    result
        .map_err(|_| {
            "No device found with that pairing code. Check the code and that both devices are on the same Wi-Fi network.".to_string()
        })?
}

async fn wait_for_resolution(
    receiver: &Receiver<ServiceEvent>,
    target_fullname: &str,
) -> Result<ParsedQrPayload, String> {
    loop {
        let event = receiver
            .recv_async()
            .await
            .map_err(|_| "mDNS browse channel closed".to_string())?;
        let ServiceEvent::ServiceResolved(info) = event else {
            continue;
        };
        if info.get_fullname() != target_fullname {
            continue;
        }

        let port = info.get_port();
        let addrs_v4 = info.get_addresses_v4();
        let host = addrs_v4
            .iter()
            .find(|ip| {
                let octets = ip.octets();
                let is_cgnat_tailscale =
                    octets[0] == 100 && (octets[1] >= 64 && octets[1] <= 127);
                !is_cgnat_tailscale
                    && ((octets[0] == 192 && octets[1] == 168)
                        || octets[0] == 10
                        || (octets[0] == 172 && (16..=31).contains(&octets[1])))
            })
            .or_else(|| {
                addrs_v4.iter().find(|ip| {
                    let octets = ip.octets();
                    let is_cgnat_tailscale =
                        octets[0] == 100 && (octets[1] >= 64 && octets[1] <= 127);
                    !ip.is_loopback() && !ip.is_link_local() && !is_cgnat_tailscale
                })
            })
            .or_else(|| addrs_v4.iter().next())
            .map(|a| a.to_string())
            .or_else(|| info.get_addresses().iter().next().map(|a| a.to_string()));
        let sid = info.get_property_val_str("sid");
        let pk = info.get_property_val_str("pk");
        let nonce = info.get_property_val_str("nonce");
        let version = info.get_property_val_str("v");
        return parsed_from_resolved(host.as_deref(), port, sid, pk, nonce, version);
    }
}

/// Rebuilds the QR payload from resolved mDNS fields. Extracted so unit tests
/// can cover session resolution without a live DNS-SD browse.
pub fn parsed_from_resolved(
    host: Option<&str>,
    port: u16,
    sid: Option<&str>,
    pk_b64: Option<&str>,
    nonce_b64: Option<&str>,
    version: Option<&str>,
) -> Result<ParsedQrPayload, String> {
    if port == 0 {
        return Err("Resolved pairing service has no port".into());
    }
    let host = host
        .filter(|h| !h.is_empty())
        .ok_or_else(|| "Resolved pairing service has no IP addresses".to_string())?
        .to_string();

    let sid = sid.ok_or_else(|| "Pairing service is missing its session id".to_string())?;
    let session_id =
        Uuid::parse_str(sid).map_err(|e| format!("Invalid session id from mDNS: {e}"))?;

    let pk_b64 = pk_b64.ok_or_else(|| "Pairing service is missing its public key".to_string())?;
    let pk_bytes = URL_SAFE_NO_PAD
        .decode(pk_b64.as_bytes())
        .map_err(|e| format!("Invalid public key from mDNS: {e}"))?;
    if pk_bytes.len() != 32 {
        return Err("Invalid public key length from mDNS".into());
    }
    let mut peer_public_key = [0u8; 32];
    peer_public_key.copy_from_slice(&pk_bytes);

    let nonce_b64 =
        nonce_b64.ok_or_else(|| "Pairing service is missing its nonce".to_string())?;
    let session_nonce = URL_SAFE_NO_PAD
        .decode(nonce_b64.as_bytes())
        .map_err(|e| format!("Invalid nonce from mDNS: {e}"))?;

    let version = version
        .and_then(|v| v.parse::<u32>().ok())
        .unwrap_or(PROTOCOL_VERSION);
    if version != PROTOCOL_VERSION {
        return Err(format!("Incompatible pairing protocol version: {version}"));
    }

    let fingerprint = compute_display_fingerprint(&session_id, &peer_public_key, &session_nonce);

    Ok(ParsedQrPayload {
        host,
        port,
        session_id,
        peer_public_key,
        receiver_public_key: peer_public_key,
        session_nonce,
        fingerprint,
        version,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn join_code_is_six_digits() {
        for _ in 0..100 {
            let code = generate_join_code();
            assert_eq!(code.len(), 6);
            assert!(code.bytes().all(|b| b.is_ascii_digit()));
            assert!(!is_weak_join_code(&code));
        }
    }

    #[test]
    fn join_code_allows_leading_zeros() {
        assert_eq!(format!("{:06}", 42u32), "000042");
        assert!(is_valid_join_code("000042"));
        assert!(!is_weak_join_code("000042"));
    }

    #[test]
    fn rejects_simple_and_sequential_codes() {
        for code in ["000000", "111111", "123456", "234567", "654321", "987654"] {
            assert!(is_weak_join_code(code), "{code}");
        }
        assert!(!is_weak_join_code("482019"));
        assert!(!is_weak_join_code("102938"));
    }

    #[test]
    fn rejects_invalid_codes() {
        for code in ["", "12345", "1234567", "abcdef", "12345x"] {
            assert!(matches!(
                advertise(code, "127.0.0.1", 1, Uuid::nil(), &[0u8; 32], &[0u8; 16]),
                Err(_)
            ));
        }
    }

    #[test]
    fn resolve_rejects_invalid_codes() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            assert!(resolve("abc").await.is_err());
        });
    }

    #[test]
    fn reconstructs_payload_from_resolved_txt() {
        let session_id = Uuid::new_v4();
        let pk = [7u8; 32];
        let nonce = [9u8; 16];
        let pk_b64 = URL_SAFE_NO_PAD.encode(pk);
        let nonce_b64 = URL_SAFE_NO_PAD.encode(nonce);
        let parsed = parsed_from_resolved(
            Some("192.168.1.10"),
            49200,
            Some(&session_id.to_string()),
            Some(&pk_b64),
            Some(&nonce_b64),
            Some("1"),
        )
        .unwrap();
        assert_eq!(parsed.host, "192.168.1.10");
        assert_eq!(parsed.port, 49200);
        assert_eq!(parsed.session_id, session_id);
        assert_eq!(parsed.peer_public_key, pk);
        assert_eq!(parsed.session_nonce, nonce);
    }

    #[test]
    fn resolved_payload_rejects_incompatible_version() {
        let session_id = Uuid::new_v4();
        let pk_b64 = URL_SAFE_NO_PAD.encode([7u8; 32]);
        let nonce_b64 = URL_SAFE_NO_PAD.encode([9u8; 16]);
        let err = parsed_from_resolved(
            Some("127.0.0.1"),
            1,
            Some(&session_id.to_string()),
            Some(&pk_b64),
            Some(&nonce_b64),
            Some("99"),
        )
        .unwrap_err();
        assert!(err.contains("Incompatible"));
    }
}

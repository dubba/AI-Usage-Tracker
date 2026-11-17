//! mDNS/Bonjour discovery for link-code pairing.
//!
//! The host advertises `_aiut-pair._tcp.local` under a random instance name
//! with its session id and nonce in TXT records. A joiner browses for those
//! hosts and tries the code its user typed against them.
//!
//! The six-digit link code is never announced: it is the shared secret of the
//! key exchange that follows the TCP connection (`crypto::PakeExchange`), so
//! nothing here is trusted or secret. A device that only pretends to be a
//! pairing host fails that exchange.
//!
//! iOS goes through the system's Bonjour service ([`super::dnssd`]) because
//! it blocks the raw multicast sockets `mdns-sd` uses; every other platform
//! uses `mdns-sd`. Both speak standard mDNS, so either side can host.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
#[cfg(not(target_os = "ios"))]
use mdns_sd::{ServiceDaemon, ServiceEvent, ServiceInfo};
use rand::Rng;
use std::{net::IpAddr, time::Duration};
use uuid::Uuid;

use super::protocol::{
    is_allowed_pairing_host, DiscoveredHost, LEGACY_PROTOCOL_VERSION, PROTOCOL_VERSION,
};

#[cfg_attr(target_os = "ios", allow(dead_code))]
pub const SERVICE_TYPE: &str = "_aiut-pair._tcp.local.";
/// The service type without its domain, as DNS-SD registers and resolves it.
#[cfg_attr(not(any(target_os = "ios", test)), allow(dead_code))]
pub(crate) const DNSSD_REGTYPE: &str = "_aiut-pair._tcp";
pub const NOT_FOUND: &str = "No device is showing a link code on this Wi-Fi network. Check that both devices are on the same Wi-Fi and that the other device is showing its code.";
pub const OLDER_VERSION: &str = "The other device has an older version of AI Usage Tracker that can't pair with this one. Update the app on both devices and try again.";
const CODE_DIGITS: usize = 6;
/// How long a joiner looks for a host before giving up.
#[cfg(not(test))]
pub(crate) const DISCOVERY_TIMEOUT: Duration = Duration::from_millis(15_000);
#[cfg(test)]
pub(crate) const DISCOVERY_TIMEOUT: Duration = Duration::from_millis(25);
/// Once one host is found, how much longer to listen for others on the network.
const DISCOVERY_SETTLE: Duration = Duration::from_millis(700);
/// Hosts kept from one browse. A network holds one or two real ones; the cap
/// bounds what a flood of fake announcements can make the joiner hold.
const MAX_DISCOVERED_HOSTS: usize = 8;

/// A random instance name for one pairing session. It says nothing about the
/// link code or the session.
pub(crate) fn generate_instance_name() -> String {
    let mut bytes = [0u8; 4];
    rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut bytes);
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!("AIUT-{hex}")
}

pub fn is_valid_join_code(code: &str) -> bool {
    code.len() == CODE_DIGITS && code.bytes().all(|b| b.is_ascii_digit())
}

/// Rejects the codes a guesser would try first (all identical digits or
/// strictly sequential).
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

/// Generates a random 6-digit numeric link code (leading zeros allowed) from
/// the operating system's random source: the code is the pairing secret.
pub fn generate_join_code() -> String {
    let mut rng = rand::rngs::OsRng;
    loop {
        let value = rng.gen_range(0..1_000_000u32);
        let code = format!("{value:06}");
        if !is_weak_join_code(&code) {
            return code;
        }
    }
}

pub struct MdnsAdvertisement {
    #[cfg(not(target_os = "ios"))]
    daemon: ServiceDaemon,
    #[cfg(not(target_os = "ios"))]
    fullname: String,
    #[cfg(target_os = "ios")]
    _registration: super::dnssd::Registration,
}

impl MdnsAdvertisement {
    pub fn unregister(self) {
        drop(self);
    }
}

#[cfg(not(target_os = "ios"))]
impl Drop for MdnsAdvertisement {
    fn drop(&mut self) {
        let _ = self.daemon.unregister(&self.fullname);
        let _ = self.daemon.shutdown();
    }
}

/// The TXT records of a pairing host: where its session is, never the link
/// code or any key.
pub(crate) fn advertised_properties(session_id: Uuid, nonce: &[u8]) -> [(&'static str, String); 3] {
    [
        ("sid", session_id.to_string()),
        ("nonce", URL_SAFE_NO_PAD.encode(nonce)),
        ("v", PROTOCOL_VERSION.to_string()),
    ]
}

/// Advertise this pairing host on the LAN under `instance`.
pub fn advertise(
    instance: &str,
    host_ip: &str,
    port: u16,
    session_id: Uuid,
    nonce: &[u8],
) -> Result<MdnsAdvertisement, String> {
    if port == 0 {
        return Err("Invalid pairing port".into());
    }
    if nonce.len() < 16 || nonce.len() > 64 {
        return Err("Invalid nonce length".into());
    }
    // A misconfigured host never advertises a non-local address.
    if !is_allowed_pairing_host(host_ip) {
        return Err("Pairing host must be a local network address".into());
    }

    let properties = advertised_properties(session_id, nonce);

    #[cfg(target_os = "ios")]
    {
        // Announce only on the interface the listener is bound to, so the
        // address the joiner resolves is the one that accepts it.
        let interface_index = super::transport::interface_index_for_ip(host_ip).unwrap_or(0);
        let registration =
            super::dnssd::register(instance, DNSSD_REGTYPE, port, interface_index, &properties)?;
        Ok(MdnsAdvertisement {
            _registration: registration,
        })
    }

    #[cfg(not(target_os = "ios"))]
    advertise_mdns_sd(instance, host_ip, port, &properties)
}

#[cfg(not(target_os = "ios"))]
fn advertise_mdns_sd(
    instance: &str,
    host_ip: &str,
    port: u16,
    properties: &[(&str, String)],
) -> Result<MdnsAdvertisement, String> {
    let daemon = ServiceDaemon::new().map_err(|e| format!("mDNS unavailable: {e}"))?;
    let host_name = format!("{}.local.", instance.to_ascii_lowercase());
    let info = ServiceInfo::new(
        SERVICE_TYPE,
        instance,
        &host_name,
        host_ip,
        port,
        properties,
    )
    .map_err(|e| format!("Invalid mDNS service info: {e}"))?;
    let fullname = info.get_fullname().to_string();
    daemon
        .register(info)
        .map_err(|e| format!("Failed to advertise pairing service: {e}"))?;

    Ok(MdnsAdvertisement { daemon, fullname })
}

/// What one browse of the network found.
#[derive(Debug, Default)]
pub struct Discovery {
    pub hosts: Vec<DiscoveredHost>,
    /// A device announcing the older pairing protocol was seen.
    pub saw_older_version: bool,
}

impl Discovery {
    fn add(&mut self, resolved: Result<DiscoveredHost, ResolveError>) {
        match resolved {
            Ok(host) => {
                let known = self.hosts.iter().any(|h| h.session_id == host.session_id);
                if !known && self.hosts.len() < MAX_DISCOVERED_HOSTS {
                    self.hosts.push(host);
                }
            }
            Err(ResolveError::OlderVersion) => self.saw_older_version = true,
            Err(ResolveError::Invalid) => {}
        }
    }

    /// The hosts to try, or why there are none.
    pub fn into_hosts(self) -> Result<Vec<DiscoveredHost>, String> {
        if !self.hosts.is_empty() {
            Ok(self.hosts)
        } else if self.saw_older_version {
            Err(OLDER_VERSION.into())
        } else {
            Err(NOT_FOUND.into())
        }
    }
}

/// Finds the pairing hosts on the local network.
pub async fn discover() -> Result<Vec<DiscoveredHost>, String> {
    #[cfg(target_os = "ios")]
    {
        discover_dnssd(DISCOVERY_TIMEOUT).await?.into_hosts()
    }

    #[cfg(not(target_os = "ios"))]
    discover_mdns_sd(DISCOVERY_TIMEOUT).await?.into_hosts()
}

#[cfg(any(target_os = "ios", all(test, target_os = "macos")))]
pub(crate) async fn discover_dnssd(timeout: Duration) -> Result<Discovery, String> {
    tokio::task::spawn_blocking(move || {
        let deadline = std::time::Instant::now() + timeout;
        let instances = super::dnssd::browse(
            DNSSD_REGTYPE,
            timeout,
            DISCOVERY_SETTLE,
            MAX_DISCOVERED_HOSTS,
        )?;
        let mut discovery = Discovery::default();
        for instance in instances {
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            if remaining.is_zero() {
                break;
            }
            let Ok(resolved) = super::dnssd::resolve(&instance, DNSSD_REGTYPE, remaining) else {
                continue;
            };
            let host = pick_resolved_host(&resolved.addresses);
            let property = |key: &str| resolved.properties.get(key).map(String::as_str);
            discovery.add(parsed_from_resolved(
                host.as_deref(),
                resolved.port,
                property("sid"),
                property("nonce"),
                property("v"),
            ));
        }
        Ok(discovery)
    })
    .await
    .map_err(|_| NOT_FOUND.to_string())?
}

#[cfg(not(target_os = "ios"))]
pub(crate) async fn discover_mdns_sd(timeout: Duration) -> Result<Discovery, String> {
    let daemon = ServiceDaemon::new().map_err(|e| format!("mDNS unavailable: {e}"))?;
    let receiver = daemon
        .browse(SERVICE_TYPE)
        .map_err(|e| format!("Failed to browse for pairing services: {e}"))?;

    let mut discovery = Discovery::default();
    let mut deadline = tokio::time::Instant::now() + timeout;
    let mut settling = false;
    loop {
        let event = match tokio::time::timeout_at(deadline, receiver.recv_async()).await {
            Ok(Ok(event)) => event,
            Ok(Err(_)) | Err(_) => break,
        };
        let ServiceEvent::ServiceResolved(info) = event else {
            continue;
        };
        let mut addresses: Vec<IpAddr> = info
            .get_addresses_v4()
            .into_iter()
            .map(|ip| IpAddr::V4(*ip))
            .collect();
        addresses.extend(info.get_addresses().iter().filter(|ip| ip.is_ipv6()));
        let host = pick_resolved_host(&addresses);
        discovery.add(parsed_from_resolved(
            host.as_deref(),
            info.get_port(),
            info.get_property_val_str("sid"),
            info.get_property_val_str("nonce"),
            info.get_property_val_str("v"),
        ));
        if !discovery.hosts.is_empty() && !settling {
            // Found one: listen a little longer for others, then stop.
            settling = true;
            deadline = deadline.min(tokio::time::Instant::now() + DISCOVERY_SETTLE);
        }
    }

    let _ = daemon.stop_browse(SERVICE_TYPE);
    let _ = daemon.shutdown();
    Ok(discovery)
}

/// Chooses which resolved address of the host to connect to: a private LAN
/// IPv4 first, then any other routable IPv4 that is not a Tailscale/CGNAT
/// address, then any IPv4, then anything else.
fn pick_resolved_host(addresses: &[IpAddr]) -> Option<String> {
    let v4: Vec<std::net::Ipv4Addr> = addresses
        .iter()
        .filter_map(|ip| match ip {
            IpAddr::V4(v4) => Some(*v4),
            IpAddr::V6(_) => None,
        })
        .collect();
    let is_cgnat = |ip: &std::net::Ipv4Addr| {
        let octets = ip.octets();
        octets[0] == 100 && (64..=127).contains(&octets[1])
    };
    v4.iter()
        .find(|ip| {
            let octets = ip.octets();
            !is_cgnat(ip)
                && ((octets[0] == 192 && octets[1] == 168)
                    || octets[0] == 10
                    || (octets[0] == 172 && (16..=31).contains(&octets[1])))
        })
        .or_else(|| {
            v4.iter()
                .find(|ip| !ip.is_loopback() && !ip.is_link_local() && !is_cgnat(ip))
        })
        .or_else(|| v4.first())
        .map(|a| a.to_string())
        .or_else(|| addresses.first().map(|a| a.to_string()))
}

/// Why an announced service is not a host this build can pair with.
#[derive(Debug, PartialEq, Eq)]
pub enum ResolveError {
    /// It speaks the older protocol: that device needs updating.
    OlderVersion,
    /// Its records are missing, malformed, or point outside the local network.
    Invalid,
}

/// Builds a host from resolved mDNS fields. Extracted so unit tests can cover
/// it without a live DNS-SD browse.
pub fn parsed_from_resolved(
    host: Option<&str>,
    port: u16,
    sid: Option<&str>,
    nonce_b64: Option<&str>,
    version: Option<&str>,
) -> Result<DiscoveredHost, ResolveError> {
    // Builds before versioning sent no `v`; they are version 1.
    let version = version.unwrap_or("1");
    if version.len() > 8 {
        return Err(ResolveError::Invalid);
    }
    match version.parse::<u32>() {
        Ok(PROTOCOL_VERSION) => {}
        Ok(LEGACY_PROTOCOL_VERSION) => return Err(ResolveError::OlderVersion),
        _ => return Err(ResolveError::Invalid),
    }

    if port == 0 {
        return Err(ResolveError::Invalid);
    }
    let host = host
        .filter(|h| !h.is_empty())
        .ok_or(ResolveError::Invalid)?;
    // A rogue mDNS responder must not steer the TCP connection at a
    // non-local address.
    if !is_allowed_pairing_host(host) {
        return Err(ResolveError::Invalid);
    }

    let sid = sid
        .filter(|sid| sid.len() <= 64)
        .ok_or(ResolveError::Invalid)?;
    let session_id = Uuid::parse_str(sid).map_err(|_| ResolveError::Invalid)?;

    let nonce_b64 = nonce_b64
        .filter(|nonce| nonce.len() <= 128)
        .ok_or(ResolveError::Invalid)?;
    let session_nonce = URL_SAFE_NO_PAD
        .decode(nonce_b64.as_bytes())
        .map_err(|_| ResolveError::Invalid)?;
    if session_nonce.len() < 16 || session_nonce.len() > 64 {
        return Err(ResolveError::Invalid);
    }

    Ok(DiscoveredHost {
        host: host.to_string(),
        port,
        session_id,
        session_nonce,
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
            assert!(!is_valid_join_code(code), "{code}");
        }
    }

    /// The announcement must never carry the link code or a key: the code is
    /// the pairing secret, and everything announced is public.
    #[test]
    fn the_announcement_carries_only_the_session_id_nonce_and_version() {
        let properties = advertised_properties(Uuid::new_v4(), &[9u8; 16]);
        let keys: Vec<&str> = properties.iter().map(|(key, _)| *key).collect();
        assert_eq!(keys, ["sid", "nonce", "v"]);

        let code = generate_join_code();
        for _ in 0..50 {
            let name = generate_instance_name();
            assert!(name.starts_with("AIUT-") && name.len() == 13, "{name}");
            assert!(!name.contains(&code), "{name}");
            assert!(
                !name["AIUT-".len()..].bytes().all(|b| b.is_ascii_digit())
                    || name.len() != "AIUT-".len() + CODE_DIGITS,
                "an instance name must not look like a link code: {name}"
            );
        }
    }

    fn resolved(version: Option<&str>) -> Result<DiscoveredHost, ResolveError> {
        let session_id = Uuid::new_v4();
        let nonce_b64 = URL_SAFE_NO_PAD.encode([9u8; 16]);
        parsed_from_resolved(
            Some("192.168.1.10"),
            49200,
            Some(&session_id.to_string()),
            Some(&nonce_b64),
            version,
        )
    }

    #[test]
    fn builds_a_host_from_resolved_txt() {
        let session_id = Uuid::new_v4();
        let nonce = [9u8; 16];
        let nonce_b64 = URL_SAFE_NO_PAD.encode(nonce);
        let host = parsed_from_resolved(
            Some("192.168.1.10"),
            49200,
            Some(&session_id.to_string()),
            Some(&nonce_b64),
            Some("2"),
        )
        .unwrap();
        assert_eq!(host.host, "192.168.1.10");
        assert_eq!(host.port, 49200);
        assert_eq!(host.session_id, session_id);
        assert_eq!(host.session_nonce, nonce);
    }

    #[test]
    fn an_older_host_is_reported_as_needing_an_update() {
        assert_eq!(resolved(Some("1")), Err(ResolveError::OlderVersion));
        assert_eq!(resolved(None), Err(ResolveError::OlderVersion));
        assert_eq!(resolved(Some("99")), Err(ResolveError::Invalid));
        assert_eq!(resolved(Some("abc")), Err(ResolveError::Invalid));

        let mut discovery = Discovery::default();
        discovery.add(resolved(Some("1")));
        assert_eq!(discovery.into_hosts().unwrap_err(), OLDER_VERSION);
        assert_eq!(Discovery::default().into_hosts().unwrap_err(), NOT_FOUND);
    }

    #[test]
    fn hosts_outside_the_local_network_or_malformed_are_ignored() {
        let sid = Uuid::new_v4().to_string();
        let nonce = URL_SAFE_NO_PAD.encode([9u8; 16]);
        let invalid = |host, port, sid: Option<&str>, nonce: Option<&str>| {
            assert_eq!(
                parsed_from_resolved(host, port, sid, nonce, Some("2")),
                Err(ResolveError::Invalid)
            );
        };
        invalid(Some("8.8.8.8"), 1, Some(&sid), Some(&nonce));
        invalid(Some("example.com"), 1, Some(&sid), Some(&nonce));
        invalid(None, 1, Some(&sid), Some(&nonce));
        invalid(Some("192.168.1.10"), 0, Some(&sid), Some(&nonce));
        invalid(Some("192.168.1.10"), 1, Some("not-a-uuid"), Some(&nonce));
        invalid(Some("192.168.1.10"), 1, None, Some(&nonce));
        invalid(Some("192.168.1.10"), 1, Some(&sid), Some("AAAA"));
        invalid(Some("192.168.1.10"), 1, Some(&sid), None);
    }

    #[test]
    fn a_browse_keeps_each_session_once_and_a_bounded_number() {
        let mut discovery = Discovery::default();
        let host = resolved(Some("2")).unwrap();
        discovery.add(Ok(host.clone()));
        discovery.add(Ok(host));
        assert_eq!(discovery.hosts.len(), 1);
        for _ in 0..20 {
            discovery.add(resolved(Some("2")));
        }
        assert_eq!(discovery.hosts.len(), MAX_DISCOVERED_HOSTS);
    }
}

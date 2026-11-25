//! mDNS/Bonjour discovery for link-code pairing.
//!
//! The host advertises `_aiut-pair._tcp.local` under a random instance name
//! with its session id and nonce in TXT records. A joiner browses for those
//! hosts and tries the code its user typed against them.
//!
//! The link code is never announced: it is the shared secret of the key
//! exchange that follows the TCP connection (`crypto::PakeExchange`), so
//! nothing here is trusted or secret. A device that only pretends to be a
//! pairing host fails that exchange.
//!
//! Apple platforms (iOS and macOS) go through the system's Bonjour service
//! ([`super::dnssd`]) because iOS blocks raw multicast sockets without a
//! restricted entitlement and macOS already runs `mDNSResponder` on UDP 5353;
//! every other platform uses `mdns-sd`. Both speak standard mDNS, so any
//! combination of platforms can host or join.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
#[cfg(any(
    not(any(target_os = "ios", target_os = "macos")),
    all(test, target_os = "macos")
))]
use mdns_sd::{ServiceDaemon, ServiceEvent, ServiceInfo};
use rand::Rng;
use std::{net::IpAddr, time::Duration};
use uuid::Uuid;

use super::protocol::{
    is_allowed_pairing_host, DiscoveredHost, LEGACY_PROTOCOL_VERSION, PROTOCOL_VERSION,
};

#[cfg_attr(any(target_os = "ios", target_os = "macos"), allow(dead_code))]
pub const SERVICE_TYPE: &str = "_aiut-pair._tcp.local.";
/// The service type without its domain, as DNS-SD registers and resolves it.
#[cfg_attr(not(any(target_os = "ios", target_os = "macos")), allow(dead_code))]
pub(crate) const DNSSD_REGTYPE: &str = "_aiut-pair._tcp";
pub const NOT_FOUND: &str = "No device is showing a link code on this Wi-Fi network. Check that both devices are on the same Wi-Fi and that the other device is showing its code. If a VPN is on, turn it off on both devices and try again.";
pub const INVALID_CODE: &str = "Enter the code shown on the other device: 12 letters, or 6 digits from an older version of the app.";
pub const OLDER_VERSION: &str = "The other device has an older version of AI Usage Tracker that can't pair with this one. Update the app on both devices and try again.";
/// The digits of the link code kept for devices with an older version: Wi-Fi only.
const LEGACY_CODE_DIGITS: usize = 6;
/// The letters of a link code. It also keys a transfer file (`file_transfer`), which can be
/// tested offline, so it is long: 23^12, about 2^54 codes.
pub const LINK_CODE_LEN: usize = 12;
/// Capital letters without I, L and O, which are read as 1 and 0. Letters only, so a phone types
/// the code on one keyboard.
pub const LINK_CODE_ALPHABET: &[u8; 23] = b"ABCDEFGHJKMNPQRSTUVWXYZ";
/// How long a joiner looks for a host before giving up.
#[cfg(not(test))]
pub(crate) const DISCOVERY_TIMEOUT: Duration = Duration::from_millis(10_000);
#[cfg(test)]
pub(crate) const DISCOVERY_TIMEOUT: Duration = Duration::from_millis(25);
/// Once one host is found, how much longer to listen for others on the network.
const DISCOVERY_SETTLE: Duration = Duration::from_millis(700);
/// Hosts kept from one browse. A network holds one or two real ones; the cap
/// bounds what a flood of fake announcements can make the joiner hold.
const MAX_DISCOVERED_HOSTS: usize = 8;

/// Prefix of every pairing instance name.
const INSTANCE_PREFIX: &str = "AIUT-";
/// What a [`connect_instance_name`] carries after the prefix, as lowercase hex: the host's IPv4
/// address (4 bytes), its port (2) and the session id (16).
const CONNECT_NAME_BYTES: usize = 4 + 2 + 16;
/// Separates the session nonce from every other use of the session id.
const NONCE_LABEL: &[u8] = b"ai-usage-tracker pairing session nonce v1";

/// The instance name a host announces: its IPv4 address, port and session id, so a joiner can
/// connect from the name alone. An iPhone joining an Android host saw the name but never got
/// the service's address and TXT records back ("resolve timed out"); with this it does not need
/// them. All of it is public anyway (the SRV, A and TXT records carry the same), and the link code
/// is never in it. A host without an IPv4 address gets a random name and is found the usual way.
pub(crate) fn connect_instance_name(host_ip: &str, port: u16, session_id: Uuid) -> String {
    let Ok(ip) = host_ip.parse::<std::net::Ipv4Addr>() else {
        return generate_instance_name();
    };
    let mut bytes = Vec::with_capacity(CONNECT_NAME_BYTES);
    bytes.extend_from_slice(&ip.octets());
    bytes.extend_from_slice(&port.to_be_bytes());
    bytes.extend_from_slice(session_id.as_bytes());
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!("{INSTANCE_PREFIX}{hex}")
}

/// The session nonce for `session_id`, so a joiner that read the session id from the instance
/// name ([`host_from_instance_name`]) has the nonce too. The id is random, so the nonce is too.
pub(crate) fn session_nonce_for(session_id: Uuid) -> Vec<u8> {
    use sha2::{Digest, Sha256};
    let digest = Sha256::new()
        .chain_update(NONCE_LABEL)
        .chain_update(session_id.as_bytes())
        .finalize();
    digest[..16].to_vec()
}

/// The host a [`connect_instance_name`] describes, checked like a resolved service; `None` for
/// any other name (an older version's random one), which is resolved instead. A rename suffix a
/// responder adds on a name conflict (`" (2)"`) is ignored.
pub(crate) fn host_from_instance_name(name: &str) -> Option<Result<DiscoveredHost, ResolveError>> {
    let hex = name.strip_prefix(INSTANCE_PREFIX)?;
    let hex = hex.split(' ').next()?;
    if hex.len() != CONNECT_NAME_BYTES * 2 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let bytes: Vec<u8> = (0..CONNECT_NAME_BYTES)
        .map(|i| u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16))
        .collect::<Result<_, _>>()
        .ok()?;
    let ip = std::net::Ipv4Addr::new(bytes[0], bytes[1], bytes[2], bytes[3]);
    let port = u16::from_be_bytes([bytes[4], bytes[5]]);
    let session_id = Uuid::from_slice(&bytes[6..]).ok()?;
    let nonce = URL_SAFE_NO_PAD.encode(session_nonce_for(session_id));
    let version = PROTOCOL_VERSION.to_string();
    Some(parsed_from_resolved(
        Some(&ip.to_string()),
        port,
        Some(&session_id.to_string()),
        Some(&nonce),
        Some(&version),
    ))
}

/// A random instance name for one pairing session. It says nothing about the
/// link code or the session.
pub(crate) fn generate_instance_name() -> String {
    let mut bytes = [0u8; 4];
    rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut bytes);
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!("{INSTANCE_PREFIX}{hex}")
}

/// A code this app shows: a link code ([`is_link_code`]) or, for an older version, six digits.
pub fn is_valid_join_code(code: &str) -> bool {
    is_link_code(code) || is_legacy_code(code)
}

/// A twelve-letter link code, as [`normalize_code`] leaves it.
pub fn is_link_code(code: &str) -> bool {
    code.len() == LINK_CODE_LEN && code.bytes().all(|b| LINK_CODE_ALPHABET.contains(&b))
}

/// A six-digit code, the kind an older version shows and types.
pub fn is_legacy_code(code: &str) -> bool {
    code.len() == LEGACY_CODE_DIGITS && code.bytes().all(|b| b.is_ascii_digit())
}

/// A typed code as the key exchange uses it: capitals, without the spaces and dashes it may be
/// shown or typed with.
pub fn normalize_code(typed: &str) -> String {
    typed
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '-')
        .map(|c| c.to_ascii_uppercase())
        .collect()
}

/// Rejects the six-digit codes a guesser would try first (all identical digits or strictly
/// sequential).
pub fn is_weak_legacy_code(code: &str) -> bool {
    if !is_legacy_code(code) {
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

/// A random six-digit code (leading zeros allowed) for a device with an older version, from the
/// operating system's random source: the code is the pairing secret.
pub fn generate_legacy_code() -> String {
    let mut rng = rand::rngs::OsRng;
    loop {
        let value = rng.gen_range(0..1_000_000u32);
        let code = format!("{value:06}");
        if !is_weak_legacy_code(&code) {
            return code;
        }
    }
}

/// A random twelve-letter link code from the operating system's random source.
pub fn generate_link_code() -> String {
    let mut rng = rand::rngs::OsRng;
    (0..LINK_CODE_LEN)
        .map(|_| char::from(LINK_CODE_ALPHABET[rng.gen_range(0..LINK_CODE_ALPHABET.len())]))
        .collect()
}

#[cfg(any(
    not(any(target_os = "ios", target_os = "macos")),
    all(test, target_os = "macos")
))]
pub(crate) struct MdnsSdAdvertisement {
    daemon: ServiceDaemon,
    fullname: String,
}

#[cfg(any(
    not(any(target_os = "ios", target_os = "macos")),
    all(test, target_os = "macos")
))]
impl Drop for MdnsSdAdvertisement {
    fn drop(&mut self) {
        if let Ok(receiver) = self.daemon.unregister(&self.fullname) {
            // Give the daemon thread a moment to send the TTL=0 goodbye packet before shutting down.
            let _ = receiver.recv_timeout(Duration::from_millis(200));
        }
        let _ = self.daemon.shutdown();
    }
}

#[cfg(target_os = "android")]
struct AndroidNsdAdvertisement;

#[cfg(target_os = "android")]
impl Drop for AndroidNsdAdvertisement {
    fn drop(&mut self) {
        crate::platform::lan_binding::unregister_nsd_service();
    }
}

#[cfg(target_os = "android")]
#[allow(dead_code)]
enum AndroidAdvertisement {
    Nsd(AndroidNsdAdvertisement),
    MdnsSd(MdnsSdAdvertisement),
}

pub struct MdnsAdvertisement {
    #[cfg(target_os = "android")]
    _android: AndroidAdvertisement,
    #[cfg(not(any(target_os = "ios", target_os = "macos", target_os = "android")))]
    _mdns: MdnsSdAdvertisement,
    #[cfg(any(target_os = "ios", target_os = "macos"))]
    _registration: super::dnssd::Registration,
}

impl MdnsAdvertisement {
    pub fn unregister(self) {
        drop(self);
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

    #[cfg(any(target_os = "ios", target_os = "macos"))]
    {
        // Announce only on the interface the listener is bound to, so the
        // address the joiner resolves is the one that accepts it.
        let interface_index = super::transport::lan::interface_index_for_ip(host_ip).unwrap_or(0);
        let registration =
            super::dnssd::register(instance, DNSSD_REGTYPE, port, interface_index, &properties)?;
        Ok(MdnsAdvertisement {
            _registration: registration,
        })
    }

    #[cfg(target_os = "android")]
    {
        let sid = properties[0].1.as_str();
        let nonce_b64 = properties[1].1.as_str();
        let version = properties[2].1.as_str();
        match crate::platform::lan_binding::register_nsd_service(
            instance, port, sid, nonce_b64, version,
        ) {
            Ok(()) => {
                super::sync_log::note("link code: announced via Android NSD");
                Ok(MdnsAdvertisement {
                    _android: AndroidAdvertisement::Nsd(AndroidNsdAdvertisement),
                })
            }
            Err(error) => {
                crate::diagnostics::warn(&error);
                Ok(MdnsAdvertisement {
                    _android: AndroidAdvertisement::MdnsSd(advertise_mdns_sd(
                        instance,
                        host_ip,
                        port,
                        &properties,
                    )?),
                })
            }
        }
    }

    #[cfg(not(any(target_os = "ios", target_os = "macos", target_os = "android")))]
    Ok(MdnsAdvertisement {
        _mdns: advertise_mdns_sd(instance, host_ip, port, &properties)?,
    })
}

#[cfg(any(
    not(any(target_os = "ios", target_os = "macos")),
    all(test, target_os = "macos")
))]
pub(crate) fn advertise_mdns_sd(
    instance: &str,
    host_ip: &str,
    port: u16,
    properties: &[(&str, String)],
) -> Result<MdnsSdAdvertisement, String> {
    let daemon = ServiceDaemon::new().map_err(|e| format!("mDNS unavailable: {e}"))?;
    // Pairing listeners bind IPv4; disabling IPv6 keeps mdns-sd from dropping queries on IPv6
    // sockets where an IPv4-only ServiceInfo has no interface-matching addresses.
    if host_ip.parse::<std::net::Ipv4Addr>().is_ok() {
        let _ = daemon.disable_interface(mdns_sd::IfKind::IPv6);
    }
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

    Ok(MdnsSdAdvertisement { daemon, fullname })
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
    #[cfg(any(target_os = "ios", target_os = "macos"))]
    {
        discover_dnssd(DISCOVERY_TIMEOUT).await?.into_hosts()
    }

    #[cfg(not(any(target_os = "ios", target_os = "macos")))]
    discover_mdns_sd(DISCOVERY_TIMEOUT).await?.into_hosts()
}

#[cfg(any(target_os = "ios", target_os = "macos"))]
pub(crate) async fn discover_dnssd(timeout: Duration) -> Result<Discovery, String> {
    tokio::task::spawn_blocking(move || {
        let mut browser = super::dnssd::Browser::start(DNSSD_REGTYPE, MAX_DISCOVERED_HOSTS * 2)?;
        let mut discovery = Discovery::default();
        let mut tried = std::collections::HashSet::new();
        let mut deadline = std::time::Instant::now() + timeout;
        let mut settling = false;
        let mut saw_instances = 0usize;
        let mut resolve_errors: Vec<String> = Vec::new();
        let mut invalid_records = 0usize;

        while std::time::Instant::now() < deadline && discovery.hosts.len() < MAX_DISCOVERED_HOSTS {
            let batch = browser.poll_new(deadline, &tried);
            if batch.is_empty() {
                break;
            }
            for inst in &batch {
                tried.insert(inst.name.clone());
            }
            saw_instances += batch.len();
            // A name that carries the host's address needs no lookup, which is the step that
            // fails between an iPhone and an Android host (see `connect_instance_name`).
            let mut named = 0usize;
            let batch: Vec<_> = batch
                .into_iter()
                .filter(|inst| match host_from_instance_name(&inst.name) {
                    Some(host) => {
                        named += 1;
                        discovery.add(host);
                        false
                    }
                    None => true,
                })
                .collect();
            if named > 0 {
                super::sync_log::note(&format!(
                    "Bonjour found {named} pairing host(s) by name, without a lookup"
                ));
            }

            // Resolve every newly seen instance in parallel with a bounded per-instance
            // timeout so a stale cached record cannot starve a live host arriving on the LAN.
            let resolved_batch: Vec<Result<super::dnssd::Resolved, String>> =
                std::thread::scope(|scope| {
                    let handles: Vec<_> = batch
                        .iter()
                        .map(|inst| {
                            let budget = deadline
                                .saturating_duration_since(std::time::Instant::now())
                                .min(Duration::from_secs(5));
                            scope.spawn(move || {
                                if budget.is_zero() {
                                    return Err("budget exhausted".to_string());
                                }
                                super::dnssd::resolve(
                                    &inst.name,
                                    DNSSD_REGTYPE,
                                    &inst.domain,
                                    inst.interface_index,
                                    budget,
                                )
                            })
                        })
                        .collect();
                    handles
                        .into_iter()
                        .map(|handle| {
                            handle
                                .join()
                                .unwrap_or_else(|_| Err("resolve worker panicked".to_string()))
                        })
                        .collect()
                });

            for outcome in resolved_batch {
                match outcome {
                    Ok(resolved) => {
                        let host = pick_resolved_host(&resolved.addresses);
                        let property = |key: &str| resolved.properties.get(key).map(String::as_str);
                        let parsed = parsed_from_resolved(
                            host.as_deref(),
                            resolved.port,
                            property("sid"),
                            property("nonce"),
                            property("v"),
                        );
                        if matches!(parsed, Err(ResolveError::Invalid)) {
                            invalid_records += 1;
                        }
                        discovery.add(parsed);
                    }
                    Err(reason) => resolve_errors.push(reason),
                }
            }

            if !discovery.hosts.is_empty() && !settling {
                settling = true;
                deadline = deadline.min(std::time::Instant::now() + DISCOVERY_SETTLE);
            }
        }

        if discovery.hosts.is_empty() {
            if let Some(code) = browser.last_error() {
                super::sync_log::note(&format!("Bonjour browse error (DNS-SD {code})"));
            } else if saw_instances > 0 {
                let detail = if !resolve_errors.is_empty() {
                    resolve_errors.join("; ")
                } else if invalid_records > 0 {
                    format!("{invalid_records} record(s) rejected by validation")
                } else {
                    "no usable host".to_string()
                };
                super::sync_log::note(&format!(
                    "Bonjour saw {saw_instances} pairing host(s) but could not resolve: {detail}"
                ));
            }
        }
        Ok(discovery)
    })
    .await
    .map_err(|_| NOT_FOUND.to_string())?
}

#[cfg(any(
    not(any(target_os = "ios", target_os = "macos")),
    all(test, target_os = "macos")
))]
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
    fn link_code_is_twelve_unambiguous_letters() {
        for _ in 0..100 {
            let code = generate_link_code();
            assert!(is_link_code(&code), "{code}");
            assert!(is_valid_join_code(&code));
            assert!(!code.contains(['I', 'L', 'O']), "{code}");
        }
    }

    #[test]
    fn link_codes_differ() {
        let codes: std::collections::HashSet<_> = (0..50).map(|_| generate_link_code()).collect();
        assert_eq!(codes.len(), 50);
    }

    #[test]
    fn legacy_code_is_six_digits() {
        for _ in 0..100 {
            let code = generate_legacy_code();
            assert!(is_legacy_code(&code));
            assert!(!is_weak_legacy_code(&code));
            assert!(is_valid_join_code(&code));
        }
    }

    #[test]
    fn legacy_code_allows_leading_zeros() {
        assert!(is_valid_join_code("000042"));
        assert!(!is_weak_legacy_code("000042"));
    }

    #[test]
    fn rejects_simple_and_sequential_legacy_codes() {
        for code in ["000000", "111111", "123456", "234567", "654321", "987654"] {
            assert!(is_weak_legacy_code(code), "{code}");
        }
        assert!(!is_weak_legacy_code("482019"));
        assert!(!is_weak_legacy_code("102938"));
    }

    #[test]
    fn rejects_invalid_codes() {
        for code in [
            "",
            "12345",
            "1234567",
            "abcdef",
            "12345x",
            "KTQMPRXDHWA",
            "KTQMPRXDHWABC",
            "KTQMPRXDHWAO",
            "ktqmprxdhwab",
            "KTQMPR XDHWAB",
        ] {
            assert!(!is_valid_join_code(code), "{code}");
        }
    }

    #[test]
    fn a_typed_code_is_normalized() {
        assert_eq!(normalize_code(" ktq-mpr xdh-wab "), "KTQMPRXDHWAB");
        assert_eq!(normalize_code("482 913"), "482913");
        assert!(is_link_code(&normalize_code("ktq mpr xdh wab")));
    }

    /// The announcement must never carry the link code or a key: the code is
    /// the pairing secret, and everything announced is public.
    #[test]
    fn the_announcement_carries_only_the_session_id_nonce_and_version() {
        let properties = advertised_properties(Uuid::new_v4(), &[9u8; 16]);
        let keys: Vec<&str> = properties.iter().map(|(key, _)| *key).collect();
        assert_eq!(keys, ["sid", "nonce", "v"]);

        let code = generate_link_code();
        let legacy = generate_legacy_code();
        for _ in 0..50 {
            let name = generate_instance_name();
            assert!(name.starts_with("AIUT-") && name.len() == 13, "{name}");
            assert!(!name.contains(&code) && !name.contains(&legacy), "{name}");
            assert!(
                !name["AIUT-".len()..].bytes().all(|b| b.is_ascii_digit())
                    || name.len() != "AIUT-".len() + LEGACY_CODE_DIGITS,
                "an instance name must not look like a link code: {name}"
            );
        }
    }

    #[test]
    fn a_connect_name_carries_the_host_and_session_without_the_code() {
        let sid = Uuid::new_v4();
        let name = connect_instance_name("192.168.1.42", 51234, sid);
        // One DNS label at most, also as mdns-sd's host name.
        assert!(name.len() <= 63, "{name}");
        assert!(name.starts_with(INSTANCE_PREFIX));
        let host = host_from_instance_name(&name).unwrap().unwrap();
        assert_eq!(host.host, "192.168.1.42");
        assert_eq!(host.port, 51234);
        assert_eq!(host.session_id, sid);
        assert_eq!(host.session_nonce, session_nonce_for(sid));
        assert_eq!(host.session_nonce.len(), 16);
        // A responder's rename on a name conflict still reads.
        let renamed = host_from_instance_name(&format!("{name} (2)"))
            .unwrap()
            .unwrap();
        assert_eq!(renamed.session_id, sid);
    }

    #[test]
    fn only_connect_names_with_a_local_address_are_read_from_the_name() {
        // An older version's random name, and other services, are resolved instead.
        assert!(host_from_instance_name(&generate_instance_name()).is_none());
        assert!(host_from_instance_name("Living Room TV").is_none());
        assert!(host_from_instance_name("AIUT-zz").is_none());
        // A rogue name must not steer the joiner at a public address.
        let public = connect_instance_name("8.8.8.8", 443, Uuid::new_v4());
        assert_eq!(
            host_from_instance_name(&public).unwrap().unwrap_err(),
            ResolveError::Invalid
        );
        // No IPv4 address: a random name, found the usual way.
        assert!(
            host_from_instance_name(&connect_instance_name("fe80::1", 1, Uuid::new_v4())).is_none()
        );
    }

    #[test]
    fn the_session_nonce_is_fixed_per_session_and_differs_between_sessions() {
        let a = Uuid::new_v4();
        assert_eq!(session_nonce_for(a), session_nonce_for(a));
        assert_ne!(session_nonce_for(a), session_nonce_for(Uuid::new_v4()));
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

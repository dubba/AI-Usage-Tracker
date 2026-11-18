//! Choosing the address the host advertises and listens on.

use std::net::UdpSocket;

/// Interface name prefixes that never carry the Wi-Fi/Ethernet LAN the other
/// device is on: cellular data (`pdp_ip` on iOS, `rmnet`/`ccmni` on Android,
/// which often hold a carrier `10.x` address), VPN and tunnel adapters,
/// Apple peer-to-peer links, and virtual-machine or container bridges.
/// Lower-cased before comparison.
const NON_LAN_INTERFACE_PREFIXES: &[&str] = &[
    "pdp_ip",
    "rmnet",
    "ccmni",
    "v4-",
    "clat",
    "utun",
    "tun",
    "ipsec",
    "ppp",
    "wg",
    "tailscale",
    "zt",
    "awdl",
    "llw",
    "anpi",
    "bridge",
    "vmnet",
    "vboxnet",
    "docker",
    "veth",
    "br-",
    "vethernet",
];

fn is_non_lan_interface(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    NON_LAN_INTERFACE_PREFIXES
        .iter()
        .any(|prefix| name.starts_with(prefix))
}

fn is_rfc1918(ip: std::net::Ipv4Addr) -> bool {
    let octets = ip.octets();
    (octets[0] == 192 && octets[1] == 168)
        || octets[0] == 10
        || (octets[0] == 172 && (16..=31).contains(&octets[1]))
}

fn is_cgnat(ip: std::net::Ipv4Addr) -> bool {
    let octets = ip.octets();
    octets[0] == 100 && (64..=127).contains(&octets[1])
}

/// Picks the address to host a pairing session on from `(interface name,
/// IPv4)` pairs in system order. A private address on a Wi-Fi or Ethernet
/// interface wins over one on a cellular, VPN, or virtual interface: an
/// iPhone lists its cellular `pdp_ip0` (often a carrier `10.x` address)
/// before Wi-Fi `en0`, and hosting there makes the session unreachable from
/// the other device on the Wi-Fi.
pub(crate) fn select_lan_ipv4(
    candidates: &[(String, std::net::Ipv4Addr)],
) -> Option<std::net::Ipv4Addr> {
    let usable = || candidates.iter().filter(|(_, ip)| !ip.is_loopback());
    usable()
        .find(|(name, ip)| is_rfc1918(*ip) && !is_non_lan_interface(name))
        .or_else(|| usable().find(|(_, ip)| is_rfc1918(*ip)))
        .or_else(|| usable().find(|(_, ip)| !ip.is_link_local() && !is_cgnat(*ip)))
        .map(|(_, ip)| *ip)
}

/// The interface index of the local interface that holds `ip`, so discovery
/// can announce the session only where the listener is reachable.
#[cfg_attr(not(target_os = "ios"), allow(dead_code))]
pub(crate) fn interface_index_for_ip(ip: &str) -> Option<u32> {
    let ip = ip.parse::<std::net::IpAddr>().ok()?;
    if_addrs::get_if_addrs()
        .ok()?
        .into_iter()
        .find(|iface| iface.addr.ip() == ip)
        .and_then(|iface| iface.index)
}

pub fn get_local_lan_ip() -> String {
    if let Ok(interfaces) = if_addrs::get_if_addrs() {
        let candidates: Vec<(String, std::net::Ipv4Addr)> = interfaces
            .into_iter()
            .filter_map(|iface| match iface.addr.ip() {
                std::net::IpAddr::V4(ipv4) => Some((iface.name, ipv4)),
                std::net::IpAddr::V6(_) => None,
            })
            .collect();
        if let Some(ip) = select_lan_ipv4(&candidates) {
            return ip.to_string();
        }
    }
    if let Ok(socket) = UdpSocket::bind("0.0.0.0:0") {
        if socket.connect("8.8.8.8:80").is_ok() {
            if let Ok(addr) = socket.local_addr() {
                let ip = addr.ip();
                if !ip.is_loopback() && !ip.is_unspecified() {
                    return ip.to_string();
                }
            }
        }
    }
    "127.0.0.1".to_string()
}

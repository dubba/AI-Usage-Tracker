//! Link-code discovery through Apple's DNS-SD API (`dns_sd.h`, served by the
//! system's mDNSResponder), used on iOS instead of `mdns-sd`.
//!
//! `mdns-sd` sends and receives multicast on its own BSD sockets. iOS only
//! allows that for apps holding the restricted
//! `com.apple.developer.networking.multicast` entitlement, which a sideloaded
//! (SideStore) build cannot carry, so on an iPhone those sockets never reach
//! the LAN: the iPhone can neither be found by its code nor find an Android
//! host by code. Bonjour through mDNSResponder needs only the
//! `NSBonjourServices` and `NSLocalNetworkUsageDescription` keys that
//! `Info.ios.plist` already declares. Both speak standard mDNS / DNS-SD on
//! the wire, so an iPhone using this module and an Android device using
//! `mdns-sd` find each other in both directions.
//!
//! Also compiled into macOS test builds, where mDNSResponder offers the same
//! API, so the interop with `mdns-sd` is tested on a development machine.

use std::{
    collections::HashMap,
    ffi::{c_char, c_int, c_void, CStr, CString},
    net::{IpAddr, Ipv4Addr, Ipv6Addr},
    ptr,
    time::{Duration, Instant},
};

#[repr(C)]
struct DnsServiceOpaque {
    _private: [u8; 0],
}
type DnsServiceRef = *mut DnsServiceOpaque;
type DnsServiceFlags = u32;
type DnsServiceErrorType = i32;

const NO_ERROR: DnsServiceErrorType = 0;
const FLAGS_MORE_COMING: DnsServiceFlags = 0x1;
const FLAGS_ADD: DnsServiceFlags = 0x2;
/// Fail on a name conflict instead of renaming. Instance names are random,
/// so a conflict means something else is wrong.
const FLAGS_NO_AUTO_RENAME: DnsServiceFlags = 0x8;
const PROTOCOL_IPV4: u32 = 0x01;
const PROTOCOL_IPV6: u32 = 0x02;
const AF_INET: u8 = 2;
const AF_INET6: u8 = 30;
const POLLIN: i16 = 0x0001;

type RegisterReply = unsafe extern "C" fn(
    DnsServiceRef,
    DnsServiceFlags,
    DnsServiceErrorType,
    *const c_char,
    *const c_char,
    *const c_char,
    *mut c_void,
);
type BrowseReply = unsafe extern "C" fn(
    DnsServiceRef,
    DnsServiceFlags,
    u32,
    DnsServiceErrorType,
    *const c_char,
    *const c_char,
    *const c_char,
    *mut c_void,
);
type ResolveReply = unsafe extern "C" fn(
    DnsServiceRef,
    DnsServiceFlags,
    u32,
    DnsServiceErrorType,
    *const c_char,
    *const c_char,
    u16,
    u16,
    *const u8,
    *mut c_void,
);
type AddrInfoReply = unsafe extern "C" fn(
    DnsServiceRef,
    DnsServiceFlags,
    u32,
    DnsServiceErrorType,
    *const c_char,
    *const c_void,
    u32,
    *mut c_void,
);

#[repr(C)]
struct PollFd {
    fd: c_int,
    events: i16,
    revents: i16,
}

// libSystem exports DNS-SD on Apple platforms; no extra link flags needed.
extern "C" {
    #[allow(clippy::too_many_arguments)]
    fn DNSServiceRegister(
        sd_ref: *mut DnsServiceRef,
        flags: DnsServiceFlags,
        interface_index: u32,
        name: *const c_char,
        regtype: *const c_char,
        domain: *const c_char,
        host: *const c_char,
        port_be: u16,
        txt_len: u16,
        txt_record: *const c_void,
        callback: RegisterReply,
        context: *mut c_void,
    ) -> DnsServiceErrorType;
    fn DNSServiceBrowse(
        sd_ref: *mut DnsServiceRef,
        flags: DnsServiceFlags,
        interface_index: u32,
        regtype: *const c_char,
        domain: *const c_char,
        callback: BrowseReply,
        context: *mut c_void,
    ) -> DnsServiceErrorType;
    fn DNSServiceResolve(
        sd_ref: *mut DnsServiceRef,
        flags: DnsServiceFlags,
        interface_index: u32,
        name: *const c_char,
        regtype: *const c_char,
        domain: *const c_char,
        callback: ResolveReply,
        context: *mut c_void,
    ) -> DnsServiceErrorType;
    fn DNSServiceGetAddrInfo(
        sd_ref: *mut DnsServiceRef,
        flags: DnsServiceFlags,
        interface_index: u32,
        protocol: u32,
        hostname: *const c_char,
        callback: AddrInfoReply,
        context: *mut c_void,
    ) -> DnsServiceErrorType;
    fn DNSServiceRefSockFD(sd_ref: DnsServiceRef) -> c_int;
    fn DNSServiceProcessResult(sd_ref: DnsServiceRef) -> DnsServiceErrorType;
    fn DNSServiceRefDeallocate(sd_ref: DnsServiceRef);
    fn poll(fds: *mut PollFd, nfds: u32, timeout_ms: c_int) -> c_int;
}

/// Owns a DNS-SD operation and ends it when dropped.
struct ServiceRef(DnsServiceRef);

impl Drop for ServiceRef {
    fn drop(&mut self) {
        if !self.0.is_null() {
            // SAFETY: the ref came from a successful DNSService* call and is
            // deallocated exactly once, here.
            unsafe { DNSServiceRefDeallocate(self.0) };
        }
    }
}

/// A live Bonjour registration of the pairing service. Dropping it withdraws
/// the advertisement.
pub struct Registration {
    // Field order matters: the service is dropped before its reply slot.
    _service: ServiceRef,
    _outcome: OwnedOutcome,
}

// SAFETY: once `register` returns, a Registration offers no methods: the only
// thing done with it is dropping it, once, from whichever thread owns it,
// and DNS-SD allows a ref to be deallocated from any thread.
unsafe impl Send for Registration {}
unsafe impl Sync for Registration {}

/// Encodes TXT properties as DNS TXT strings (length byte + `key=value`).
fn encode_txt(properties: &[(&str, String)]) -> Result<Vec<u8>, String> {
    let mut txt = Vec::new();
    for (key, value) in properties {
        let entry = format!("{key}={value}");
        let len = u8::try_from(entry.len()).map_err(|_| "TXT entry too long".to_string())?;
        txt.push(len);
        txt.extend_from_slice(entry.as_bytes());
    }
    Ok(txt)
}

/// Decodes DNS TXT strings into `key -> value`. Malformed trailing data ends
/// parsing; entries without `=` are ignored.
fn decode_txt(bytes: &[u8]) -> HashMap<String, String> {
    let mut properties = HashMap::new();
    let mut rest = bytes;
    while let Some((&len, tail)) = rest.split_first() {
        let len = usize::from(len);
        if tail.len() < len {
            break;
        }
        let (entry, next) = tail.split_at(len);
        rest = next;
        let Ok(entry) = std::str::from_utf8(entry) else {
            continue;
        };
        if let Some((key, value)) = entry.split_once('=') {
            properties
                .entry(key.to_ascii_lowercase())
                .or_insert_with(|| value.to_string());
        }
    }
    properties
}

fn cstring(value: &str) -> Result<CString, String> {
    CString::new(value).map_err(|_| "Invalid DNS-SD name".to_string())
}

/// How long `register` waits for mDNSResponder to confirm the name (probing
/// takes under a second). Without an answer by then the registration is kept.
const REGISTER_CONFIRM_TIMEOUT: Duration = Duration::from_secs(3);

unsafe extern "C" fn on_register(
    _sd_ref: DnsServiceRef,
    _flags: DnsServiceFlags,
    error: DnsServiceErrorType,
    _name: *const c_char,
    _regtype: *const c_char,
    _domain: *const c_char,
    context: *mut c_void,
) {
    // SAFETY: context is the &mut Option<i32> passed by `register`, alive
    // while it pumps results; later replies are never read.
    let outcome = unsafe { &mut *context.cast::<Option<DnsServiceErrorType>>() };
    outcome.get_or_insert(error);
}

/// Advertises `instance` of `regtype` (e.g. `_aiut-pair._tcp`) on `port`.
/// `interface_index` limits the announcement to the interface the pairing
/// listener is bound on, so the address the other device resolves is the
/// one that accepts its connection; 0 means every interface. Blocks for up
/// to [`REGISTER_CONFIRM_TIMEOUT`] waiting for the name to be confirmed.
pub fn register(
    instance: &str,
    regtype: &str,
    port: u16,
    interface_index: u32,
    properties: &[(&str, String)],
) -> Result<Registration, String> {
    let name = cstring(instance)?;
    let regtype = cstring(regtype)?;
    let txt = encode_txt(properties)?;
    let txt_len = u16::try_from(txt.len()).map_err(|_| "TXT record too long".to_string())?;
    // Boxed so its address stays fixed for the registration's lifetime: a
    // reply arriving after this function returns is never processed, but
    // the pointer handed to DNS-SD must stay valid regardless.
    let outcome: Box<Option<DnsServiceErrorType>> = Box::new(None);
    let outcome_ptr = Box::into_raw(outcome);
    let mut sd_ref: DnsServiceRef = ptr::null_mut();
    // SAFETY: every pointer is valid for the call.
    let err = unsafe {
        DNSServiceRegister(
            &mut sd_ref,
            FLAGS_NO_AUTO_RENAME,
            interface_index,
            name.as_ptr(),
            regtype.as_ptr(),
            ptr::null(),
            ptr::null(),
            port.to_be(),
            txt_len,
            txt.as_ptr().cast(),
            on_register,
            outcome_ptr.cast(),
        )
    };
    if err != NO_ERROR || sd_ref.is_null() {
        // SAFETY: the registration failed, so DNS-SD holds no copy.
        drop(unsafe { Box::from_raw(outcome_ptr) });
        return Err(format!(
            "Failed to advertise pairing service (DNS-SD {err})"
        ));
    }
    let registration = Registration {
        _service: ServiceRef(sd_ref),
        _outcome: OwnedOutcome(outcome_ptr),
    };
    let deadline = Instant::now() + REGISTER_CONFIRM_TIMEOUT;
    // SAFETY: only read on this thread between ProcessResult calls.
    pump(&registration._service, deadline, || unsafe {
        (*outcome_ptr).is_some()
    });
    match unsafe { *outcome_ptr } {
        Some(code) if code != NO_ERROR => Err(format!(
            "Failed to advertise pairing service (DNS-SD {code})"
        )),
        _ => Ok(registration),
    }
}

/// Frees the registration's reply slot after the registration is gone.
struct OwnedOutcome(*mut Option<DnsServiceErrorType>);

impl Drop for OwnedOutcome {
    fn drop(&mut self) {
        // SAFETY: allocated by Box::into_raw in `register`; the ServiceRef
        // field is declared first, so it is dropped (and DNS-SD stops
        // calling back) before this runs.
        drop(unsafe { Box::from_raw(self.0) });
    }
}

/// What resolving one service instance found.
#[derive(Debug, Clone)]
pub struct Resolved {
    pub port: u16,
    pub properties: HashMap<String, String>,
    pub addresses: Vec<IpAddr>,
}

/// Waits up to `deadline` for results on `service`, dispatching callbacks,
/// until `done()` holds. Returns false on timeout or a DNS-SD error.
fn pump(service: &ServiceRef, deadline: Instant, mut done: impl FnMut() -> bool) -> bool {
    // SAFETY: the ref is live for the duration of this call.
    let fd = unsafe { DNSServiceRefSockFD(service.0) };
    if fd < 0 {
        return false;
    }
    while !done() {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return false;
        }
        let mut pfd = PollFd {
            fd,
            events: POLLIN,
            revents: 0,
        };
        let wait_ms = c_int::try_from(remaining.as_millis()).unwrap_or(c_int::MAX);
        // SAFETY: one valid pollfd.
        let ready = unsafe { poll(&mut pfd, 1, wait_ms) };
        if ready < 0 {
            if std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted {
                continue;
            }
            return false;
        }
        if ready == 0 {
            return false;
        }
        // SAFETY: the socket is readable, so this does not block; callbacks
        // run on this thread and only touch the context we passed.
        if unsafe { DNSServiceProcessResult(service.0) } != NO_ERROR {
            return false;
        }
    }
    true
}

/// One service instance heard during a Bonjour browse.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BrowsedInstance {
    pub name: String,
    pub interface_index: u32,
    pub domain: String,
}

struct BrowseState {
    instances: Vec<BrowsedInstance>,
    limit: usize,
    last_error: Option<DnsServiceErrorType>,
}

/// Frees the browser's callback state after the DNS-SD ref is deallocated.
struct OwnedBrowseState(*mut BrowseState);

impl Drop for OwnedBrowseState {
    fn drop(&mut self) {
        // SAFETY: allocated by Box::into_raw in `Browser::start`; the ServiceRef
        // field is declared first on `Browser`, so it is deallocated before this runs.
        drop(unsafe { Box::from_raw(self.0) });
    }
}

/// A live Bonjour browse that stays open across multiple resolve attempts so a
/// stale cached instance cannot end browsing before a live host answers.
pub struct Browser {
    // Field order matters: the service is dropped before its state pointer.
    service: ServiceRef,
    state: OwnedBrowseState,
}

unsafe extern "C" fn on_browse(
    _sd_ref: DnsServiceRef,
    flags: DnsServiceFlags,
    interface_index: u32,
    error: DnsServiceErrorType,
    service_name: *const c_char,
    _regtype: *const c_char,
    reply_domain: *const c_char,
    context: *mut c_void,
) {
    // SAFETY: context is the boxed BrowseState owned by `Browser`, only accessed
    // on the thread pumping `DNSServiceProcessResult`.
    let state = unsafe { &mut *context.cast::<BrowseState>() };
    if error != NO_ERROR {
        state.last_error.get_or_insert(error);
        return;
    }
    if flags & FLAGS_ADD == 0 || service_name.is_null() {
        return;
    }
    // SAFETY: DNS-SD passes NUL-terminated instance and domain names.
    let Ok(name) = unsafe { CStr::from_ptr(service_name) }.to_str() else {
        return;
    };
    let domain = if reply_domain.is_null() {
        "local.".to_string()
    } else {
        unsafe { CStr::from_ptr(reply_domain) }
            .to_str()
            .ok()
            .filter(|d| !d.is_empty())
            .unwrap_or("local.")
            .to_string()
    };
    if state.instances.len() < state.limit
        && !state.instances.iter().any(|known| known.name == name)
    {
        state.instances.push(BrowsedInstance {
            name: name.to_string(),
            interface_index,
            domain,
        });
    }
}

impl Browser {
    pub fn start(regtype: &str, limit: usize) -> Result<Self, String> {
        let regtype = cstring(regtype)?;
        let domain = cstring("local.")?;
        let state_ptr = Box::into_raw(Box::new(BrowseState {
            instances: Vec::new(),
            limit,
            last_error: None,
        }));
        let mut sd_ref: DnsServiceRef = ptr::null_mut();
        // SAFETY: valid pointers; `Browser` deallocates `sd_ref` before dropping `state_ptr`.
        let err = unsafe {
            DNSServiceBrowse(
                &mut sd_ref,
                0,
                0,
                regtype.as_ptr(),
                domain.as_ptr(),
                on_browse,
                state_ptr.cast(),
            )
        };
        if err != NO_ERROR || sd_ref.is_null() {
            // SAFETY: browse failed, so DNS-SD holds no copy of `state_ptr`.
            drop(unsafe { Box::from_raw(state_ptr) });
            return Err(format!("Failed to look for pairing devices (DNS-SD {err})"));
        }
        Ok(Self {
            service: ServiceRef(sd_ref),
            state: OwnedBrowseState(state_ptr),
        })
    }

    /// Pumps until `deadline` or until at least one instance whose name is not in `seen`
    /// arrives (or DNS-SD reports an error), then drains any queued replies and returns
    /// all unseen instances.
    pub fn poll_new(
        &mut self,
        deadline: Instant,
        seen: &std::collections::HashSet<String>,
    ) -> Vec<BrowsedInstance> {
        let state_ptr = self.state.0;
        let has_unseen = || {
            // SAFETY: only accessed on this thread between ProcessResult calls.
            let state = unsafe { &*state_ptr };
            state.last_error.is_some()
                || state
                    .instances
                    .iter()
                    .any(|item| !seen.contains(&item.name))
        };
        if !has_unseen() {
            pump(&self.service, deadline, has_unseen);
        }
        // Drain any additional replies that arrived in the same packet/batch.
        let drain_until = deadline.min(Instant::now() + Duration::from_millis(50));
        pump(&self.service, drain_until, || false);
        // SAFETY: only accessed on this thread between ProcessResult calls.
        let state = unsafe { &*state_ptr };
        state
            .instances
            .iter()
            .filter(|item| !seen.contains(&item.name))
            .cloned()
            .collect()
    }

    pub fn last_error(&self) -> Option<i32> {
        // SAFETY: only accessed on this thread.
        unsafe { (*self.state.0).last_error }
    }
}

struct ResolveState {
    found: Option<(u32, CString, u16, HashMap<String, String>)>,
    last_error: Option<DnsServiceErrorType>,
}

unsafe extern "C" fn on_resolve(
    _sd_ref: DnsServiceRef,
    _flags: DnsServiceFlags,
    interface_index: u32,
    error: DnsServiceErrorType,
    _fullname: *const c_char,
    host_target: *const c_char,
    port_be: u16,
    txt_len: u16,
    txt: *const u8,
    context: *mut c_void,
) {
    // SAFETY: context is the &mut ResolveState passed to DNSServiceResolve,
    // alive for the whole pump on this thread.
    let state = unsafe { &mut *context.cast::<ResolveState>() };
    if error != NO_ERROR {
        state.last_error.get_or_insert(error);
        return;
    }
    if host_target.is_null() || state.found.is_some() {
        return;
    }
    // SAFETY: DNS-SD passes a NUL-terminated host name and txt_len bytes of TXT.
    let host = unsafe { CStr::from_ptr(host_target) }.to_owned();
    let txt = if txt.is_null() {
        &[][..]
    } else {
        unsafe { std::slice::from_raw_parts(txt, usize::from(txt_len)) }
    };
    state.found = Some((
        interface_index,
        host,
        u16::from_be(port_be),
        decode_txt(txt),
    ));
}

struct AddrState {
    addresses: Vec<IpAddr>,
    batch_done: bool,
    last_error: Option<DnsServiceErrorType>,
}

/// Reads an IPv4 or IPv6 address out of a BSD `sockaddr` (Apple layout:
/// `sa_len`, `sa_family`, then the family's fields).
///
/// # Safety
/// `address` must point at a valid `sockaddr_in` or `sockaddr_in6`.
unsafe fn sockaddr_ip(address: *const c_void) -> Option<IpAddr> {
    let bytes = address.cast::<u8>();
    // SAFETY: every sockaddr starts with sa_len and sa_family.
    let family = unsafe { *bytes.add(1) };
    if family == AF_INET {
        // sockaddr_in: len, family, port (2), addr (4).
        let mut octets = [0u8; 4];
        // SAFETY: a sockaddr_in is 16 bytes.
        unsafe { ptr::copy_nonoverlapping(bytes.add(4), octets.as_mut_ptr(), 4) };
        return Some(IpAddr::V4(Ipv4Addr::from(octets)));
    }
    if family == AF_INET6 {
        // sockaddr_in6: len, family, port (2), flowinfo (4), addr (16).
        let mut octets = [0u8; 16];
        // SAFETY: a sockaddr_in6 is 28 bytes.
        unsafe { ptr::copy_nonoverlapping(bytes.add(8), octets.as_mut_ptr(), 16) };
        return Some(IpAddr::V6(Ipv6Addr::from(octets)));
    }
    None
}

unsafe extern "C" fn on_addr_info(
    _sd_ref: DnsServiceRef,
    flags: DnsServiceFlags,
    _interface_index: u32,
    error: DnsServiceErrorType,
    _hostname: *const c_char,
    address: *const c_void,
    _ttl: u32,
    context: *mut c_void,
) {
    // SAFETY: context is the &mut AddrState passed to DNSServiceGetAddrInfo.
    let state = unsafe { &mut *context.cast::<AddrState>() };
    // A missing AAAA record (common for IPv4-only mdns-sd hosts on Android) arrives as
    // `kDNSServiceErr_NoSuchRecord` with `FLAGS_MORE_COMING == 0`. Never end the batch on an
    // error or before at least one address has arrived, or the IPv4 A record can be missed.
    if error != NO_ERROR {
        state.last_error.get_or_insert(error);
        return;
    }
    if flags & FLAGS_ADD != 0 && !address.is_null() {
        // SAFETY: DNS-SD hands over a valid sockaddr for the protocol asked.
        if let Some(ip) = unsafe { sockaddr_ip(address) } {
            if !state.addresses.contains(&ip) {
                state.addresses.push(ip);
            }
        }
        if flags & FLAGS_MORE_COMING == 0 && !state.addresses.is_empty() {
            state.batch_done = true;
        }
    }
}

fn query_addresses(
    interface_index: u32,
    protocol: u32,
    host: &CString,
    deadline: Instant,
) -> Result<(Vec<IpAddr>, Option<i32>), String> {
    let mut addr_state = AddrState {
        addresses: Vec::new(),
        batch_done: false,
        last_error: None,
    };
    let mut sd_ref: DnsServiceRef = ptr::null_mut();
    // SAFETY: valid pointers; `addr_state` outlives `ServiceRef`.
    let err = unsafe {
        DNSServiceGetAddrInfo(
            &mut sd_ref,
            0,
            interface_index,
            protocol,
            host.as_ptr(),
            on_addr_info,
            (&mut addr_state as *mut AddrState).cast(),
        )
    };
    if err != NO_ERROR || sd_ref.is_null() {
        return Err(format!("addr start error (DNS-SD {err})"));
    }
    let service = ServiceRef(sd_ref);
    pump(&service, deadline, || addr_state.batch_done);
    drop(service);
    Ok((addr_state.addresses, addr_state.last_error))
}

fn resolve_service(
    name: &CString,
    regtype: &CString,
    domain: &CString,
    interface_index: u32,
    deadline: Instant,
) -> Result<(u32, CString, u16, HashMap<String, String>), String> {
    let mut resolve_state = ResolveState {
        found: None,
        last_error: None,
    };
    let mut sd_ref: DnsServiceRef = ptr::null_mut();
    // SAFETY: valid pointers; the context outlives the operation, which is
    // deallocated (ServiceRef drop) before resolve_state goes out of scope.
    let err = unsafe {
        DNSServiceResolve(
            &mut sd_ref,
            0,
            interface_index,
            name.as_ptr(),
            regtype.as_ptr(),
            domain.as_ptr(),
            on_resolve,
            (&mut resolve_state as *mut ResolveState).cast(),
        )
    };
    if err != NO_ERROR || sd_ref.is_null() {
        return Err(format!("resolve start error (DNS-SD {err})"));
    }
    let service = ServiceRef(sd_ref);
    let found = pump(&service, deadline, || {
        resolve_state.found.is_some() || resolve_state.last_error.is_some()
    });
    drop(service);
    if let Some(found) = resolve_state.found.take().filter(|_| found) {
        Ok(found)
    } else if let Some(code) = resolve_state.last_error {
        Err(format!("resolve callback error (DNS-SD {code})"))
    } else {
        Err("resolve timed out".to_string())
    }
}

/// Resolves `instance` of `regtype` in `domain` to its port, TXT properties,
/// and addresses, giving up after `timeout`. Blocking: run it off the async
/// runtime.
pub fn resolve(
    instance: &str,
    regtype: &str,
    domain: &str,
    interface_index: u32,
    timeout: Duration,
) -> Result<Resolved, String> {
    let deadline = Instant::now() + timeout;
    let name = cstring(instance)?;
    let regtype = cstring(regtype)?;
    let domain = cstring(domain)?;

    let first_resolve_deadline = if interface_index != 0 {
        deadline.min(Instant::now() + Duration::from_millis(2500))
    } else {
        deadline
    };
    let (resolved_if, host, port, properties) = match resolve_service(
        &name,
        &regtype,
        &domain,
        interface_index,
        first_resolve_deadline,
    ) {
        Ok(found) => found,
        Err(_) if interface_index != 0 && Instant::now() < deadline => {
            resolve_service(&name, &regtype, &domain, 0, deadline)?
        }
        Err(err) => return Err(err),
    };

    // Pairing hosts bind IPv4, so ask mDNSResponder for IPv4 first without IPv6 AAAA noise.
    let v4_first_deadline = if resolved_if != 0 {
        deadline.min(Instant::now() + Duration::from_millis(2000))
    } else {
        deadline
    };
    let (mut addresses, mut last_addr_err) =
        query_addresses(resolved_if, PROTOCOL_IPV4, &host, v4_first_deadline)?;
    if addresses.is_empty() && resolved_if != 0 && Instant::now() < deadline {
        let v4_any_deadline = deadline.min(Instant::now() + Duration::from_millis(1500));
        if let Ok((fallback, err)) = query_addresses(0, PROTOCOL_IPV4, &host, v4_any_deadline) {
            addresses.extend(fallback);
            if err.is_some() {
                last_addr_err = err;
            }
        }
    }
    if addresses.is_empty() && Instant::now() < deadline {
        if let Ok((v6, err)) = query_addresses(0, PROTOCOL_IPV6, &host, deadline) {
            addresses.extend(v6);
            if err.is_some() {
                last_addr_err = err;
            }
        }
    }

    if addresses.is_empty() {
        return Err(match last_addr_err {
            Some(code) => format!("addr lookup failed (DNS-SD {code})"),
            None => "addr lookup timed out".to_string(),
        });
    }
    Ok(Resolved {
        port,
        properties,
        addresses,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn txt_round_trips() {
        let txt = encode_txt(&[("sid", "abc".into()), ("v", "1".into())]).unwrap();
        assert_eq!(txt[0] as usize, "sid=abc".len());
        let decoded = decode_txt(&txt);
        assert_eq!(decoded.get("sid").map(String::as_str), Some("abc"));
        assert_eq!(decoded.get("v").map(String::as_str), Some("1"));
    }

    #[test]
    fn txt_decoding_tolerates_truncated_and_malformed_entries() {
        // A length byte that runs past the end, an entry without '=', and
        // invalid UTF-8 must not panic or produce entries.
        assert!(decode_txt(&[9, b'a', b'=']).is_empty());
        assert!(decode_txt(&[3, b'a', b'b', b'c']).is_empty());
        assert!(decode_txt(&[2, 0xff, 0xfe]).is_empty());
        let decoded = decode_txt(&[3, b'k', b'=', b'v', 1]);
        assert_eq!(decoded.get("k").map(String::as_str), Some("v"));
    }

    #[test]
    fn txt_rejects_oversized_entries() {
        assert!(encode_txt(&[("k", "x".repeat(300))]).is_err());
    }
}

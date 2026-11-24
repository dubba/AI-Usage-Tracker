//! Whether the phone is on Wi-Fi, recorded in the Sync Devices log when a code screen opens (link
//! codes need the same local network: a Wi-Fi network, or a hotspot this phone shares).

/// `true` when the phone is on a Wi-Fi network (Android: connected to one; iOS:
/// its Wi-Fi interface has an address), or when this platform does not
/// need a check (desktop). A hotspot this phone shares is not checked. A failure to ask the OS is
/// reported as `true`.
pub fn is_enabled() -> Result<bool, String> {
    #[cfg(target_os = "android")]
    {
        return android_is_enabled();
    }
    #[cfg(target_os = "ios")]
    {
        return Ok(ios_wifi_enabled());
    }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        Ok(true)
    }
}

#[cfg(target_os = "android")]
fn android_is_enabled() -> Result<bool, String> {
    crate::platform::android_context::with_activity("Unable to check Wi-Fi", |env, activity| {
        if env.exception_check().unwrap_or(false) {
            let _ = env.exception_clear();
        }
        let result = env.call_method(activity, "isWifiEnabled", "()Z", &[]);
        if env.exception_check().unwrap_or(false) {
            let _ = env.exception_clear();
            return Ok(true);
        }
        match result {
            Ok(value) => value.z().or(Ok(true)),
            Err(_) => Ok(true),
        }
    })
}

/// Wi-Fi-like interface names used on iOS (`en0`) and Android (`wlan0`).
#[cfg(any(test, target_os = "ios"))]
pub(crate) fn is_wifi_interface_name(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    name == "en0" || name.starts_with("wlan")
}

/// `true` when any listed interface looks like Wi-Fi and is not loopback.
#[cfg(any(test, target_os = "ios"))]
pub(crate) fn wifi_from_interfaces(candidates: impl IntoIterator<Item = impl AsRef<str>>) -> bool {
    candidates
        .into_iter()
        .any(|name| is_wifi_interface_name(name.as_ref()))
}

#[cfg(target_os = "ios")]
fn ios_wifi_enabled() -> bool {
    let Ok(ifaces) = if_addrs::get_if_addrs() else {
        return true;
    };
    wifi_from_interfaces(
        ifaces
            .iter()
            .filter(|iface| !iface.is_loopback())
            .map(|iface| iface.name.as_str()),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wifi_interface_names_match_phones() {
        assert!(is_wifi_interface_name("en0"));
        assert!(is_wifi_interface_name("EN0"));
        assert!(is_wifi_interface_name("wlan0"));
        assert!(is_wifi_interface_name("wlan1"));
        assert!(!is_wifi_interface_name("pdp_ip0"));
        assert!(!is_wifi_interface_name("rmnet0"));
        assert!(!is_wifi_interface_name("lo0"));
        assert!(!is_wifi_interface_name("en1"));
        assert!(!is_wifi_interface_name("eth0"));
    }

    #[test]
    fn wifi_from_interfaces_needs_a_wifi_name() {
        assert!(!wifi_from_interfaces(["pdp_ip0", "lo0"]));
        assert!(wifi_from_interfaces(["pdp_ip0", "en0"]));
        assert!(wifi_from_interfaces(["wlan0"]));
    }

    #[test]
    fn desktop_reports_wifi_as_enabled() {
        #[cfg(not(any(target_os = "android", target_os = "ios")))]
        assert!(is_enabled().expect("desktop wifi probe"));
    }
}

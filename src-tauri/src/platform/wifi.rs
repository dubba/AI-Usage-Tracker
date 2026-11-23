//! Whether Wi-Fi is on, and a way to open the system Wi-Fi panel so the user
//! can turn it on. Link-code pairing only works on the same local network:
//! a Wi-Fi network, or a hotspot this phone shares.

/// `true` when the Wi-Fi radio looks usable or this phone is sharing a
/// hotspot, or when this platform does not need a check (desktop). A failure
/// to ask the OS is reported as `true` so pairing is not blocked by a broken
/// probe.
pub fn is_enabled() -> Result<bool, String> {
    #[cfg(target_os = "android")]
    {
        return Ok(android_is_enabled()? || hotspot_active());
    }
    #[cfg(target_os = "ios")]
    {
        return Ok(ios_wifi_enabled() || hotspot_active());
    }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        Ok(true)
    }
}

/// Opens the OS Wi-Fi settings (Android system panel, iOS Settings). Desktop
/// is a no-op.
pub fn open_settings() -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        return android_open_settings();
    }
    #[cfg(target_os = "ios")]
    {
        return ios_open_settings();
    }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        Ok(())
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

#[cfg(target_os = "android")]
fn android_open_settings() -> Result<(), String> {
    crate::platform::android_context::with_activity(
        "Unable to open Wi-Fi settings",
        |env, activity| {
            let result = env.call_method(activity, "openWifiSettings", "()V", &[]);
            if env.exception_check().unwrap_or(false) {
                let _ = env.exception_clear();
                return Err("Unable to open Wi-Fi settings.".into());
            }
            result
                .map(|_| ())
                .map_err(|_| "Unable to open Wi-Fi settings.".into())
        },
    )
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

/// Interface names a phone's own hotspot uses. Android has no public way to
/// ask whether the hotspot is on, but while it is, an interface such as `ap0`,
/// `swlan0`, `softap0` or `wlan1` carries the hotspot's address. With the Wi-Fi
/// radio off no Wi-Fi network has an address, so any `wlan` interface that has
/// one is the hotspot too. iOS shows Personal Hotspot as `bridge100` only once
/// a device has joined it, so before that the app cannot tell it is on.
#[cfg(any(test, target_os = "android", target_os = "ios"))]
pub(crate) fn is_hotspot_interface_name(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    ["ap", "swlan", "softap", "wlan", "bridge"]
        .iter()
        .any(|prefix| {
            name.strip_prefix(prefix)
                .is_some_and(|rest| rest.chars().next().is_some_and(|c| c.is_ascii_digit()))
        })
}

/// `true` when a hotspot-named interface has a usable IPv4 address (not
/// loopback, link-local or unspecified).
#[cfg(any(test, target_os = "android", target_os = "ios"))]
pub(crate) fn hotspot_from_interfaces<'a>(
    interfaces: impl IntoIterator<Item = (&'a str, std::net::Ipv4Addr)>,
) -> bool {
    interfaces.into_iter().any(|(name, ip)| {
        is_hotspot_interface_name(name)
            && !ip.is_loopback()
            && !ip.is_link_local()
            && !ip.is_unspecified()
    })
}

#[cfg(any(target_os = "android", target_os = "ios"))]
fn hotspot_active() -> bool {
    let Ok(ifaces) = if_addrs::get_if_addrs() else {
        return false;
    };
    hotspot_from_interfaces(ifaces.iter().filter_map(|iface| match &iface.addr {
        if_addrs::IfAddr::V4(v4) => Some((iface.name.as_str(), v4.ip)),
        if_addrs::IfAddr::V6(_) => None,
    }))
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

#[cfg(target_os = "ios")]
fn ios_open_settings() -> Result<(), String> {
    use objc2::runtime::{AnyClass, AnyObject, Bool, Sel};
    use objc2::{msg_send, sel};

    unsafe {
        let Some(app_cls) = AnyClass::get(c"UIApplication") else {
            return Err("Unable to open Wi-Fi settings.".into());
        };
        let app: *mut AnyObject = msg_send![app_cls, sharedApplication];
        if app.is_null() {
            return Err("Unable to open Wi-Fi settings.".into());
        }
        let Some(url_cls) = AnyClass::get(c"NSURL") else {
            return Err("Unable to open Wi-Fi settings.".into());
        };
        let Some(str_cls) = AnyClass::get(c"NSString") else {
            return Err("Unable to open Wi-Fi settings.".into());
        };

        // App-Prefs opens the Wi-Fi pane on sideloaded iOS. The documented
        // fallback is this app's own Settings page.
        for url in [c"App-Prefs:root=WIFI", c"prefs:root=WIFI", c"app-settings:"] {
            let s: *mut AnyObject = msg_send![str_cls, stringWithUTF8String: url.as_ptr()];
            if s.is_null() {
                continue;
            }
            let nsurl: *mut AnyObject = msg_send![url_cls, URLWithString: s];
            if nsurl.is_null() {
                continue;
            }
            let open: Sel = sel!(openURL:);
            let _: () = msg_send![
                app,
                performSelectorOnMainThread: open,
                withObject: nsurl,
                waitUntilDone: Bool::YES
            ];
            return Ok(());
        }
    }
    Err("Unable to open Wi-Fi settings.".into())
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
    fn hotspot_interface_names_match_phones() {
        for name in ["ap0", "swlan0", "softap0", "wlan1", "WLAN0", "bridge100"] {
            assert!(is_hotspot_interface_name(name), "{name}");
        }
        for name in [
            "rmnet0",
            "rmnet_data1",
            "pdp_ip0",
            "tun0",
            "p2p-wlan0-0",
            "lo",
            "en0",
            "apple0",
            "wlan",
            "bridge",
        ] {
            assert!(!is_hotspot_interface_name(name), "{name}");
        }
    }

    #[test]
    fn hotspot_needs_an_address_on_a_hotspot_interface() {
        use std::net::Ipv4Addr;
        let hotspot = ("swlan0", Ipv4Addr::new(192, 168, 43, 1));
        let cellular = ("rmnet_data0", Ipv4Addr::new(10, 21, 4, 7));
        assert!(hotspot_from_interfaces([cellular, hotspot]));
        assert!(hotspot_from_interfaces([(
            "bridge100",
            Ipv4Addr::new(172, 20, 10, 1)
        )]));
        assert!(!hotspot_from_interfaces([cellular]));
        assert!(!hotspot_from_interfaces([(
            "ap0",
            Ipv4Addr::new(169, 254, 3, 4)
        )]));
        assert!(!hotspot_from_interfaces([("ap0", Ipv4Addr::UNSPECIFIED)]));
        assert!(!hotspot_from_interfaces([]));
    }

    #[test]
    fn desktop_reports_wifi_as_enabled() {
        #[cfg(not(any(target_os = "android", target_os = "ios")))]
        assert!(is_enabled().expect("desktop wifi probe"));
    }

    #[test]
    fn desktop_open_settings_is_a_noop() {
        #[cfg(not(any(target_os = "android", target_os = "ios")))]
        assert!(open_settings().is_ok());
    }
}

//! Android-only helper: binds the process to the Wi-Fi network while a
//! pairing session is active so that VPN/DNS-based ad blockers do not swallow
//! the LAN traffic pairing relies on.

#[cfg(target_os = "android")]
use jni::{objects::JValue, JNIEnv};

#[cfg(target_os = "android")]
pub fn set_pairing_lan_binding(enabled: bool) -> Result<(), String> {
    const PREFIX: &str = "Unable to configure pairing network";
    crate::platform::android_context::with_activity(PREFIX, |env, activity| {
        let result = env.call_method(
            activity,
            "setPairingLanBinding",
            "(Z)V",
            &[JValue::Bool(enabled as u8)],
        );
        check_call(env, result, PREFIX)
    })
}

/// Keeps the pairing tie to Wi-Fi when `interface` is the Wi-Fi network's, and drops it
/// otherwise (see `PairingNetwork.routePairingTo`).
#[cfg(target_os = "android")]
fn route_pairing_to(interface: &str) -> Result<(), String> {
    const PREFIX: &str = "Unable to route the pairing connection";
    crate::platform::android_context::with_activity(PREFIX, |env, activity| {
        let name = env
            .new_string(interface)
            .map_err(|error| format!("{PREFIX}: {error}"))?;
        let result = env.call_method(
            activity,
            "routePairingTo",
            "(Ljava/lang/String;)V",
            &[JValue::Object(&name.into())],
        );
        check_call(env, result, PREFIX)
    })
}

/// Before a joiner connects to `peer`: while pairing, the process is tied to the Wi-Fi network
/// (`set_pairing_lan_binding`), but a phone sharing its hotspot reaches a peer on that hotspot
/// through the hotspot interface, which the tie would bypass. So the tie stays only when the peer
/// is on the Wi-Fi network's subnet. A peer on no local subnet leaves the tie as it is. Other
/// platforms do nothing.
pub async fn route_pairing_connection(peer: std::net::IpAddr) {
    #[cfg(target_os = "android")]
    {
        let _ = tokio::task::spawn_blocking(move || {
            let Some(interface) = crate::pairing::transport::lan::local_interface_for_peer(peer)
            else {
                return;
            };
            if let Err(error) = route_pairing_to(&interface) {
                crate::diagnostics::warn(&error);
            }
        })
        .await;
    }
    #[cfg(not(target_os = "android"))]
    let _ = peer;
}

/// Maps a void JNI call result to `Err("{prefix}: {reason}")`, clearing any
/// pending Java exception so the attached thread is left usable.
#[cfg(target_os = "android")]
fn check_call(
    env: &mut JNIEnv,
    result: jni::errors::Result<jni::objects::JValueOwned>,
    prefix: &str,
) -> Result<(), String> {
    if env.exception_check().unwrap_or(false) {
        let throwable = env.exception_occurred().map_err(|e| e.to_string())?;
        let _ = env.exception_clear();
        let message = jni_exception_message(env, &throwable);
        return Err(format!("{prefix}: {message}"));
    }
    result
        .map(|_| ())
        .map_err(|error| format!("{prefix}: {error}"))
}

#[cfg(target_os = "android")]
fn jni_exception_message(env: &mut JNIEnv, throwable: &jni::objects::JThrowable) -> String {
    let fallback = "network configuration failed".to_string();
    env.call_method(throwable, "getMessage", "()Ljava/lang/String;", &[])
        .ok()
        .and_then(|value| value.l().ok())
        .map(|message| {
            let message: &jni::objects::JString = (&message).into();
            env.get_string(message)
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_else(|_| fallback.clone())
        })
        .filter(|message| !message.is_empty())
        .unwrap_or(fallback)
}

/// Posts a usage alert notification whose full text stays readable when the
/// notification is expanded on Android (the Tauri notification plugin only
/// sets the collapsed content text).
#[cfg(target_os = "android")]
pub fn post_expandable_notification(title: &str, body: &str) -> Result<(), String> {
    const PREFIX: &str = "Unable to post notification";
    crate::platform::android_context::with_activity(PREFIX, |env, activity| {
        let title_j = env
            .new_string(title)
            .map_err(|error| format!("{PREFIX}: {error}"))?;
        let body_j = env
            .new_string(body)
            .map_err(|error| format!("{PREFIX}: {error}"))?;
        let result = env.call_method(
            activity,
            "postExpandableNotification",
            "(Ljava/lang/String;Ljava/lang/String;)V",
            &[
                JValue::Object(&title_j.into()),
                JValue::Object(&body_j.into()),
            ],
        );
        check_call(env, result, PREFIX)
    })
}

#[cfg(not(target_os = "android"))]
pub fn set_pairing_lan_binding(_enabled: bool) -> Result<(), String> {
    Ok(())
}

/// Like [`set_pairing_lan_binding`] but detached on a background thread on
/// Android, so a misbehaving JNI/VPN call can never block pairing commands.
pub fn configure_pairing_network(bind: bool) {
    #[cfg(target_os = "android")]
    std::thread::spawn(move || {
        let _ = set_pairing_lan_binding(bind);
    });
    #[cfg(not(target_os = "android"))]
    {
        let _ = set_pairing_lan_binding(bind);
    }
}

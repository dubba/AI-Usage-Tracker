//! Code tied to one operating system or to the device: Android and macOS integration, the tray, autostart, Wi-Fi and the local network.

#[cfg(target_os = "android")]
pub(crate) mod android_context;
#[cfg(target_os = "android")]
pub(crate) mod android_keystore;
#[cfg(target_os = "android")]
pub(crate) mod apk_install;
pub(crate) mod autostart;
pub(crate) mod camera_permission;
pub(crate) mod fs_util;
pub(crate) mod lan_binding;
#[cfg(target_os = "macos")]
pub(crate) mod macos_notifications;
pub(crate) mod tray;
pub(crate) mod wifi;

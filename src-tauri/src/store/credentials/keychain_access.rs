//! Keeps the app's Keychain items readable while the phone is locked (iOS).
//!
//! An item saved without an accessibility setting is only readable while the
//! phone is unlocked. The background refresh (`platform/ios_background.rs`)
//! usually runs with the phone locked, so with such items every account would
//! fail to load its sign-in, and a token rotated by the provider could not be
//! written back. `kSecAttrAccessibleAfterFirstUnlock` keeps an item readable
//! and writable from the first unlock after a restart until the next restart.
//! The items stay in this app's Keychain, are not synced and are not exported.
//!
//! `keyring` does not expose the setting, so this changes it in place with
//! `SecItemUpdate`, which updates only the attribute and keeps the secret.
//! The first run after an update, while the phone is unlocked, converts the
//! items saved earlier. Later runs find nothing to change.

use super::keyring_store::{CREDENTIAL_SERVICE, LEGACY_CREDENTIAL_SERVICE};
use core_foundation::{
    base::TCFType,
    dictionary::{CFDictionary, CFDictionaryRef},
    string::{CFString, CFStringRef},
};

type OSStatus = i32;
const ERR_SEC_ITEM_NOT_FOUND: OSStatus = -25300;
const ERR_SEC_INTERACTION_NOT_ALLOWED: OSStatus = -25308;

#[link(name = "Security", kind = "framework")]
extern "C" {
    static kSecClass: CFStringRef;
    static kSecClassGenericPassword: CFStringRef;
    static kSecAttrService: CFStringRef;
    static kSecAttrAccessible: CFStringRef;
    static kSecAttrAccessibleAfterFirstUnlock: CFStringRef;
    fn SecItemUpdate(query: CFDictionaryRef, attributes_to_update: CFDictionaryRef) -> OSStatus;
}

/// Makes every item the app saved readable while the phone is locked. Does
/// nothing, quietly, when there are no items or the phone is locked right now.
pub(crate) fn allow_background_access() {
    for service in [CREDENTIAL_SERVICE, LEGACY_CREDENTIAL_SERVICE] {
        let status = set_after_first_unlock(service);
        if !matches!(
            status,
            0 | ERR_SEC_ITEM_NOT_FOUND | ERR_SEC_INTERACTION_NOT_ALLOWED
        ) {
            crate::diagnostics::warn(&format!(
                "Keychain background access could not be set (status {status})."
            ));
        }
    }
}

fn set_after_first_unlock(service: &str) -> OSStatus {
    // SAFETY: the constants are Security framework globals that live for the
    // whole process, so wrapping them under the get rule only retains them.
    // `SecItemUpdate` copies both dictionaries and keeps no reference.
    unsafe {
        let query = CFDictionary::from_CFType_pairs(&[
            (
                CFString::wrap_under_get_rule(kSecClass).as_CFType(),
                CFString::wrap_under_get_rule(kSecClassGenericPassword).as_CFType(),
            ),
            (
                CFString::wrap_under_get_rule(kSecAttrService).as_CFType(),
                CFString::new(service).as_CFType(),
            ),
        ]);
        let update = CFDictionary::from_CFType_pairs(&[(
            CFString::wrap_under_get_rule(kSecAttrAccessible).as_CFType(),
            CFString::wrap_under_get_rule(kSecAttrAccessibleAfterFirstUnlock).as_CFType(),
        )]);
        SecItemUpdate(query.as_concrete_TypeRef(), update.as_concrete_TypeRef())
    }
}

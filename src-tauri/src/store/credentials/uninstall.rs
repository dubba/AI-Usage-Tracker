//! Removing every Windows Credential Manager entry this app wrote, when it is uninstalled
//! (`crate::uninstall`). The store's own cleanup (`legacy_cleanup`) removes the entries of the
//! accounts it knows; an uninstall also has to catch entries no stored account lists any more, so
//! it lists every generic credential and deletes the ones whose name this app could have written.
//!
//! keyring 3 names a Windows credential `{user}.{service}`, user first. A name counts only when
//! the service is one of the app's two and the user is one the app writes: the bridge token,
//! `account:{id}`, or a chunk `account:{id}:chunk:{generation}:{index}`. Secrets are never read.

use super::chunking::{CREDENTIAL_GENERATION_LENGTH, MAX_CREDENTIAL_CHUNKS};
use super::keyring_store::{BRIDGE_TOKEN_USER, CREDENTIAL_SERVICE, LEGACY_CREDENTIAL_SERVICE};

/// The services the app's credentials are saved under, current first.
pub(crate) const SERVICES: [&str; 2] = [CREDENTIAL_SERVICE, LEGACY_CREDENTIAL_SERVICE];
/// What `account_credential_user` and `credential_chunk_user` start an account's user with.
pub(crate) const ACCOUNT_USER_PREFIX: &str = "account:";
/// What `credential_chunk_user` puts between the account id and the chunk's generation.
pub(crate) const CHUNK_MARKER: &str = ":chunk:";
/// Longer names are not the app's: an account id is at most 64 characters.
pub(crate) const MAX_TARGET_CHARS: usize = 256;
pub(crate) const MAX_ACCOUNT_ID_CHARS: usize = 64;

/// Whether `target` is a credential name the app writes under one of `services`.
pub(crate) fn is_app_credential_target(target: &str, services: &[&str]) -> bool {
    if target.is_empty()
        || target.chars().count() > MAX_TARGET_CHARS
        || target
            .chars()
            .any(|ch| ch.is_whitespace() || ch == '\0' || ch == '\\' || ch == '/')
    {
        return false;
    }
    services.iter().any(|service| {
        target
            .strip_suffix(service)
            .and_then(|rest| rest.strip_suffix('.'))
            .is_some_and(is_app_credential_user)
    })
}

fn is_app_credential_user(user: &str) -> bool {
    if user == BRIDGE_TOKEN_USER {
        return true;
    }
    let Some(rest) = user.strip_prefix(ACCOUNT_USER_PREFIX) else {
        return false;
    };
    let Some((id, chunk)) = rest.split_once(CHUNK_MARKER) else {
        return is_account_id(rest);
    };
    let Some((generation, index)) = chunk.rsplit_once(':') else {
        return false;
    };
    is_account_id(id)
        && generation.len() == CREDENTIAL_GENERATION_LENGTH
        && generation.bytes().all(|byte| byte.is_ascii_alphanumeric())
        && (1..=2).contains(&index.len())
        && index.bytes().all(|byte| byte.is_ascii_digit())
        && index
            .parse::<usize>()
            .is_ok_and(|index| index < MAX_CREDENTIAL_CHUNKS)
}

fn is_account_id(id: &str) -> bool {
    (1..=MAX_ACCOUNT_ID_CHARS).contains(&id.len())
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

/// Deletes every generic credential the app wrote under `services`. False when the list could
/// not be read or an entry could not be deleted (one already gone counts as deleted).
#[cfg(windows)]
pub(crate) fn remove_app_credentials(services: &[&str]) -> bool {
    let Some(targets) = windows::generic_credential_targets() else {
        return false;
    };
    let mut removed_all = true;
    for target in targets
        .iter()
        .filter(|target| is_app_credential_target(target, services))
    {
        removed_all &= windows::delete_generic_credential(target);
    }
    removed_all
}

#[cfg(windows)]
mod windows {
    use windows_sys::Win32::Foundation::{GetLastError, ERROR_NOT_FOUND};
    use windows_sys::Win32::Security::Credentials::{
        CredDeleteW, CredEnumerateW, CredFree, CREDENTIALW, CRED_TYPE_GENERIC,
    };

    /// The names of every generic credential the user has, or `None` when the list cannot be
    /// read. Only `Type` and `TargetName` are looked at; the secret is never read.
    pub(super) fn generic_credential_targets() -> Option<Vec<String>> {
        let mut count: u32 = 0;
        let mut list: *mut *mut CREDENTIALW = std::ptr::null_mut();
        // SAFETY: a null filter lists every credential; on success Windows sets `count` and
        // `list` to an array of `count` credential pointers, freed below with `CredFree`.
        let listed = unsafe { CredEnumerateW(std::ptr::null(), 0, &mut count, &mut list) };
        if listed == 0 {
            // SAFETY: reads the calling thread's last error, set by the call above.
            return (unsafe { GetLastError() } == ERROR_NOT_FOUND).then(Vec::new);
        }
        let mut names = Vec::new();
        for index in 0..count as usize {
            // SAFETY: `index < count`, so the pointer is inside the array Windows returned, and a
            // non-null entry points to a credential that lives until `CredFree`.
            let credential = unsafe { *list.add(index) };
            if credential.is_null() {
                continue;
            }
            // SAFETY: see above.
            let credential = unsafe { &*credential };
            if credential.Type != CRED_TYPE_GENERIC || credential.TargetName.is_null() {
                continue;
            }
            // SAFETY: `TargetName` is a NUL-terminated UTF-16 string owned by the array.
            names.push(unsafe { wide_to_string(credential.TargetName) });
        }
        // SAFETY: `list` came from `CredEnumerateW` and is freed once.
        unsafe { CredFree(list.cast()) };
        Some(names)
    }

    /// Deletes the generic credential named `target`. True when it is gone (or was already).
    pub(super) fn delete_generic_credential(target: &str) -> bool {
        let wide: Vec<u16> = target.encode_utf16().chain(std::iter::once(0)).collect();
        // SAFETY: `wide` is NUL-terminated and outlives the call.
        let deleted = unsafe { CredDeleteW(wide.as_ptr(), CRED_TYPE_GENERIC, 0) };
        // SAFETY: reads the calling thread's last error, set by the call above.
        deleted != 0 || unsafe { GetLastError() } == ERROR_NOT_FOUND
    }

    /// # Safety
    /// `text` must point to a NUL-terminated UTF-16 string.
    unsafe fn wide_to_string(text: *const u16) -> String {
        let mut len = 0;
        // SAFETY: the caller promises a terminating NUL, so every read before it is in bounds.
        while unsafe { *text.add(len) } != 0 {
            len += 1;
        }
        // SAFETY: the `len` units before the NUL were just read.
        String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(text, len) })
    }
}

#[cfg(test)]
mod tests;

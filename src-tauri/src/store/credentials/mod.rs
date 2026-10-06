pub(super) mod cache;
pub(super) mod chunking;
#[cfg(not(target_os = "android"))]
pub(super) mod keyring_store;

use self::cache::{
    cached_secret, cached_secret_is_clean, forget_secret, mark_secret_clean, remember_secret,
    remember_secret_with_state,
};
#[cfg(all(not(target_os = "android"), not(debug_assertions)))]
use self::chunking::{
    decode_provider_secret, delete_credential_generation, parse_credential_manifest,
    read_credential_generation,
};
// Only the chunked format (Windows and other non-macOS desktops) writes credentials in pieces.
#[cfg(all(
    not(any(target_os = "macos", target_os = "android")),
    not(debug_assertions)
))]
use self::chunking::{
    generate_credential_generation, read_credential_manifest, split_utf16_chunks,
    write_credential_generation, write_credential_manifest, CredentialGeneration,
    CredentialManifest, CHUNKED_CREDENTIAL_FORMAT, CREDENTIAL_CHUNK_UTF16_UNITS,
    MAX_CREDENTIAL_CHUNKS,
};
#[cfg(all(not(target_os = "android"), not(debug_assertions)))]
use self::keyring_store::{
    account_credential_entry, account_credential_user, credential_chunk_user, credential_entry,
    credential_entry_for, delete_credential, delete_legacy_credential, BRIDGE_TOKEN_USER,
    CREDENTIAL_SERVICE, LEGACY_CREDENTIAL_SERVICE,
};
#[cfg(any(target_os = "android", debug_assertions))]
use crate::credential_file::{platform_cipher, read_credential_file, write_credential_file};
#[cfg(any(target_os = "android", debug_assertions))]
use crate::fs_util::ensure_private_dir;
use crate::model::ProviderSecret;
#[cfg(any(target_os = "android", debug_assertions))]
use crate::store::DATA_DIRS;
use crate::store::{check_account_id, is_valid_account_id, StoreError};
use rand::{distributions::Alphanumeric, Rng};
#[cfg(any(target_os = "android", debug_assertions))]
use std::{fs, path::PathBuf};

/// What a pass over the credential folder did.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct UpgradeReport {
    /// Plaintext files rewritten sealed.
    pub upgraded: usize,
    /// Files that are still plaintext because they could not be sealed (or
    /// could not even be read). These stay usable but unprotected.
    pub failed: usize,
    /// Account ids whose `{id}.json` file is still plaintext. Other files,
    /// such as the local API token, are counted in `failed` but are not accounts.
    pub failed_accounts: Vec<String>,
}

pub fn save_provider_secret(account_id: &str, secret: &ProviderSecret) -> Result<(), StoreError> {
    save_provider_secret_with(account_id, secret, persist_provider_secret)
}

pub(crate) fn save_provider_secret_with(
    account_id: &str,
    secret: &ProviderSecret,
    persist: impl FnOnce(&str, &ProviderSecret) -> Result<(), StoreError>,
) -> Result<(), StoreError> {
    check_account_id(account_id)?;
    if cached_secret_is_clean(account_id, secret) {
        return Ok(());
    }
    // Cache the new secret before touching the native store. If the write
    // fails, later loads still return this secret (not the stale, possibly
    // revoked one) and the next save retries the write.
    remember_secret_with_state(account_id, secret.clone(), true);
    persist(account_id, secret)?;
    mark_secret_clean(account_id, secret);
    Ok(())
}

#[cfg(any(target_os = "android", debug_assertions))]
pub(crate) fn persist_provider_secret(
    account_id: &str,
    secret: &ProviderSecret,
) -> Result<(), StoreError> {
    let payload =
        serde_json::to_vec(secret).map_err(|error| StoreError::Invalid(error.to_string()))?;
    for _ in 0..3 {
        let dir = match current_credentials_dir() {
            Ok(d) => d,
            Err(_) => continue,
        };
        let _ = ensure_private_dir(&dir);
        let path = dir.join(format!("{account_id}.json"));
        match write_credential_file(platform_cipher(), &path, &payload) {
            Ok(()) => return Ok(()),
            Err(_) => {
                let mut dirs = DATA_DIRS.write();
                dirs.retain(|p| p.exists());
            }
        }
    }
    let dir = current_credentials_dir()?;
    let path = dir.join(format!("{account_id}.json"));
    write_credential_file(platform_cipher(), &path, &payload).map_err(StoreError::Credential)?;
    Ok(())
}

#[cfg(all(target_os = "macos", not(debug_assertions)))]
pub(crate) fn persist_provider_secret(
    account_id: &str,
    secret: &ProviderSecret,
) -> Result<(), StoreError> {
    let payload =
        serde_json::to_string(secret).map_err(|error| StoreError::Invalid(error.to_string()))?;
    account_credential_entry(account_id)?
        .set_password(&payload)
        .map_err(|error| StoreError::Credential(error.to_string()))
}

#[cfg(all(
    not(any(target_os = "macos", target_os = "android")),
    not(debug_assertions)
))]
pub(crate) fn persist_provider_secret(
    account_id: &str,
    secret: &ProviderSecret,
) -> Result<(), StoreError> {
    let payload =
        serde_json::to_string(secret).map_err(|error| StoreError::Invalid(error.to_string()))?;
    let chunks = split_utf16_chunks(&payload, CREDENTIAL_CHUNK_UTF16_UNITS);
    if chunks.is_empty() || chunks.len() > MAX_CREDENTIAL_CHUNKS {
        return Err(StoreError::Invalid(format!(
            "provider credentials require {} keyring chunks; supported range is 1-{MAX_CREDENTIAL_CHUNKS}",
            chunks.len()
        )));
    }

    let current_manifest = read_credential_manifest(account_id)?;
    if let Some(previous) = current_manifest
        .as_ref()
        .and_then(|manifest| manifest.previous.as_ref())
    {
        delete_credential_generation(account_id, previous)?;
    }

    let active = CredentialGeneration {
        generation: generate_credential_generation(),
        chunks: chunks.len(),
    };
    write_credential_generation(account_id, &active, &chunks)?;

    let manifest = CredentialManifest {
        format: CHUNKED_CREDENTIAL_FORMAT.into(),
        active: active.clone(),
        previous: current_manifest
            .as_ref()
            .map(|manifest| manifest.active.clone()),
    };
    if let Err(error) = write_credential_manifest(account_id, &manifest) {
        let _ = delete_credential_generation(account_id, &active);
        return Err(error);
    }

    if let Some(previous) = manifest.previous.as_ref() {
        if delete_credential_generation(account_id, previous).is_ok() {
            let cleaned_manifest = CredentialManifest {
                previous: None,
                ..manifest
            };
            let _ = write_credential_manifest(account_id, &cleaned_manifest);
        }
    }

    Ok(())
}

#[cfg(all(not(target_os = "android"), not(debug_assertions)))]
pub(crate) fn load_keychain_secret(account_id: &str) -> Result<ProviderSecret, StoreError> {
    let user = account_credential_user(account_id);
    let (stored, from_legacy) = match credential_entry(&user)?.get_password() {
        Ok(value) => (value, false),
        Err(keyring::Error::NoEntry) => (
            credential_entry_for(LEGACY_CREDENTIAL_SERVICE, &user)?
                .get_password()
                .map_err(|error| StoreError::Credential(error.to_string()))?,
            true,
        ),
        Err(error) => return Err(StoreError::Credential(error.to_string())),
    };

    let manifest = parse_credential_manifest(&stored)?;
    let secret = if let Some(manifest) = manifest.as_ref() {
        let payload = read_credential_generation(account_id, &manifest.active)?;
        decode_provider_secret(&payload)?
    } else {
        decode_provider_secret(&stored)?
    };

    #[cfg(target_os = "macos")]
    let should_migrate = from_legacy || manifest.is_some();
    #[cfg(not(target_os = "macos"))]
    let should_migrate = from_legacy;

    if should_migrate && persist_provider_secret(account_id, &secret).is_ok() {
        let _ = delete_legacy_credential(&user);
        if let Some(manifest) = manifest.as_ref() {
            for generation in std::iter::once(&manifest.active).chain(manifest.previous.as_ref()) {
                for index in 0..generation.chunks {
                    let chunk_user =
                        credential_chunk_user(account_id, &generation.generation, index);
                    let _ = delete_legacy_credential(&chunk_user);
                    let _ = delete_credential(&chunk_user);
                }
            }
        }
    }

    Ok(secret)
}

#[cfg(any(target_os = "android", debug_assertions))]
pub fn load_provider_secret(account_id: &str) -> Result<ProviderSecret, StoreError> {
    check_account_id(account_id)?;
    if let Some(secret) = cached_secret(account_id) {
        return Ok(secret);
    }
    let filename = format!("{account_id}.json");
    let path = find_credential_file(&filename)
        .or_else(|| current_credentials_dir().ok().map(|d| d.join(&filename)));

    if let Some(path) = path.as_ref().filter(|p| p.exists()) {
        let data = read_credential_file(platform_cipher(), path).map_err(StoreError::Credential)?;
        let secret: ProviderSecret = serde_json::from_slice(&data)
            .map_err(|error| StoreError::Invalid(error.to_string()))?;
        remember_secret(account_id, secret.clone());
        return Ok(secret);
    }

    Err(StoreError::Credential(
        "No matching entry found in secure storage".into(),
    ))
}

#[cfg(all(not(target_os = "android"), not(debug_assertions)))]
pub fn load_provider_secret(account_id: &str) -> Result<ProviderSecret, StoreError> {
    check_account_id(account_id)?;
    if let Some(secret) = cached_secret(account_id) {
        return Ok(secret);
    }
    let secret = load_keychain_secret(account_id)?;
    remember_secret(account_id, secret.clone());
    Ok(secret)
}

#[cfg(all(not(target_os = "android"), not(debug_assertions)))]
pub(crate) fn delete_keychain_secret(account_id: &str) -> Result<(), StoreError> {
    let user = account_credential_user(account_id);
    let mut first_error = None;
    let mut manifests = Vec::new();

    match credential_entry_for(CREDENTIAL_SERVICE, &user)?.get_password() {
        Ok(stored) => {
            if let Some(manifest) = parse_credential_manifest(&stored)? {
                manifests.push(manifest);
            }
        }
        Err(keyring::Error::NoEntry) => {
            match credential_entry_for(LEGACY_CREDENTIAL_SERVICE, &user)?.get_password() {
                Ok(stored) => {
                    if let Some(manifest) = parse_credential_manifest(&stored)? {
                        manifests.push(manifest);
                    }
                }
                Err(keyring::Error::NoEntry) => {}
                Err(error) => {
                    first_error.get_or_insert(StoreError::Credential(error.to_string()));
                }
            }
        }
        Err(error) => {
            first_error.get_or_insert(StoreError::Credential(error.to_string()));
        }
    }

    for manifest in &manifests {
        for generation in std::iter::once(&manifest.active).chain(manifest.previous.as_ref()) {
            if let Err(error) = delete_credential_generation(account_id, generation) {
                first_error.get_or_insert(error);
            }
        }
    }

    if let Err(error) = delete_credential(&user) {
        first_error.get_or_insert(error);
    }

    if let Some(error) = first_error {
        Err(error)
    } else {
        Ok(())
    }
}

#[cfg(any(target_os = "android", debug_assertions))]
pub fn delete_secret(account_id: &str) -> Result<(), StoreError> {
    if !is_valid_account_id(account_id) {
        // Nothing can have been stored under an id we refuse to write, and
        // refusing here would make such an account impossible to remove.
        forget_secret(account_id);
        return Ok(());
    }
    let filename = format!("{account_id}.json");
    let dirs = DATA_DIRS.read().clone();
    for base in dirs {
        let path = base.join("credentials").join(&filename);
        if path.exists() {
            fs::remove_file(&path).map_err(|error| StoreError::Io(error.to_string()))?;
        }
    }
    forget_secret(account_id);
    Ok(())
}

#[cfg(all(not(target_os = "android"), not(debug_assertions)))]
pub fn delete_secret(account_id: &str) -> Result<(), StoreError> {
    if !is_valid_account_id(account_id) {
        forget_secret(account_id);
        return Ok(());
    }
    let res = delete_keychain_secret(account_id);
    forget_secret(account_id);
    res
}

#[cfg(any(target_os = "android", debug_assertions))]
pub fn load_or_create_bridge_token() -> Result<String, StoreError> {
    if let Some(path) = find_credential_file("bridge-token.txt") {
        // An unreadable token (for example a sealed file whose key is gone)
        // falls through to a fresh one.
        if let Ok(bytes) = read_credential_file(platform_cipher(), &path) {
            let trimmed = String::from_utf8_lossy(&bytes).trim().to_string();
            if trimmed.len() >= 32 {
                return Ok(trimmed);
            }
        }
    }
    let dir = current_credentials_dir()?;
    let path = dir.join("bridge-token.txt");
    let token = generate_bridge_token();
    write_credential_file(platform_cipher(), &path, token.as_bytes())
        .map_err(StoreError::Credential)?;
    Ok(token)
}

#[cfg(all(not(target_os = "android"), not(debug_assertions)))]
pub fn load_or_create_bridge_token() -> Result<String, StoreError> {
    let entry = credential_entry(BRIDGE_TOKEN_USER)?;
    match entry.get_password() {
        Ok(value) if value.len() >= 32 => Ok(value),
        Ok(_) | Err(keyring::Error::NoEntry) => {
            if let Ok(value) =
                credential_entry_for(LEGACY_CREDENTIAL_SERVICE, BRIDGE_TOKEN_USER)?.get_password()
            {
                if value.len() >= 32 {
                    entry
                        .set_password(&value)
                        .map_err(|error| StoreError::Credential(error.to_string()))?;
                    let _ = delete_legacy_credential(BRIDGE_TOKEN_USER);
                    return Ok(value);
                }
            }
            let token = generate_bridge_token();
            entry
                .set_password(&token)
                .map_err(|error| StoreError::Credential(error.to_string()))?;
            Ok(token)
        }
        Err(error) => Err(StoreError::Credential(error.to_string())),
    }
}

#[cfg(any(target_os = "android", debug_assertions))]
pub fn rotate_bridge_token() -> Result<String, StoreError> {
    let dir = current_credentials_dir()?;
    let path = dir.join("bridge-token.txt");
    let token = generate_bridge_token();
    write_credential_file(platform_cipher(), &path, token.as_bytes())
        .map_err(StoreError::Credential)?;
    Ok(token)
}

#[cfg(all(not(target_os = "android"), not(debug_assertions)))]
pub fn rotate_bridge_token() -> Result<String, StoreError> {
    let token = generate_bridge_token();
    let entry = credential_entry(BRIDGE_TOKEN_USER)?;
    entry
        .set_password(&token)
        .map_err(|error| StoreError::Credential(error.to_string()))?;
    Ok(token)
}

pub(crate) fn generate_bridge_token() -> String {
    rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(64)
        .map(char::from)
        .collect()
}

/// Seals any plaintext credential files left by earlier versions (Android).
/// A no-op where there is no platform cipher. `failed` in the result is how
/// many credentials are still stored unencrypted.
#[cfg(any(target_os = "android", debug_assertions))]
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub fn upgrade_plaintext_credentials() -> UpgradeReport {
    match current_credentials_dir() {
        Ok(dir) => crate::credential_file::upgrade_directory(platform_cipher(), &dir),
        Err(_) => Default::default(),
    }
}

/// Desktop release builds keep credentials in the OS keychain, not in files.
#[cfg(all(not(target_os = "android"), not(debug_assertions)))]
pub fn upgrade_plaintext_credentials() -> UpgradeReport {
    Default::default()
}

#[cfg(any(target_os = "android", debug_assertions))]
pub(crate) fn current_credentials_dir() -> Result<PathBuf, StoreError> {
    let mut dirs = DATA_DIRS.write();
    dirs.retain(|p| p.exists());
    let base = dirs.first().cloned().ok_or_else(|| {
        StoreError::Credential("Storage directory has not been initialized".into())
    })?;
    drop(dirs);
    let dir = base.join("credentials");
    ensure_private_dir(&dir).map_err(StoreError::Io)?;
    Ok(dir)
}

#[cfg(any(target_os = "android", debug_assertions))]
pub(crate) fn find_credential_file(filename: &str) -> Option<PathBuf> {
    let dirs = DATA_DIRS.read().clone();
    for base in dirs {
        let path = base.join("credentials").join(filename);
        if path.exists() {
            return Some(path);
        }
    }
    None
}

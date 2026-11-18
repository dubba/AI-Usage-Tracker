//! Removing every keychain entry an account owns, in both services (L-81).
//!
//! An account's credential has a root entry (`account:{id}`) under the current
//! service and, from older versions, possibly another under the legacy
//! service. A root holds the secret itself or a chunk manifest whose chunk
//! entries (`account:{id}:chunk:{generation}:{index}`) can sit under either
//! service. Both roots are always read, so a current root can no longer hide
//! a legacy manifest and its chunks.
//!
//! Chunks are deleted before the root that lists them, and a root is kept
//! while any of its chunks failed to delete. An interrupted or failed cleanup
//! therefore always leaves a root pointing at what is left, and the next
//! attempt (the next load, or the user retrying a removal, which is refused
//! until it succeeds) finishes the job.
#![cfg_attr(any(target_os = "android", debug_assertions), allow(dead_code))]

use super::chunking::{parse_credential_manifest, CredentialManifest};
use super::keyring_store::{
    account_credential_user, credential_chunk_user, CREDENTIAL_SERVICE, LEGACY_CREDENTIAL_SERVICE,
};
use crate::store::StoreError;

const SERVICES: [&str; 2] = [CREDENTIAL_SERVICE, LEGACY_CREDENTIAL_SERVICE];

/// The two keychain calls cleanup needs. Release builds use the OS keychain
/// ([`Keychain`]); tests use an in-memory store that can fail on demand.
pub(crate) trait CredentialBackend {
    /// `Ok(None)` when there is no such entry.
    fn get(&self, service: &str, user: &str) -> Result<Option<String>, StoreError>;
    /// A missing entry counts as deleted.
    fn delete(&self, service: &str, user: &str) -> Result<(), StoreError>;
}

/// The OS keychain (Keychain on Apple platforms, Credential Manager on Windows).
pub(crate) struct Keychain;

impl CredentialBackend for Keychain {
    fn get(&self, service: &str, user: &str) -> Result<Option<String>, StoreError> {
        match super::keyring_store::credential_entry_for(service, user)?.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(StoreError::Credential(error.to_string())),
        }
    }

    fn delete(&self, service: &str, user: &str) -> Result<(), StoreError> {
        match super::keyring_store::credential_entry_for(service, user)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(StoreError::Credential(error.to_string())),
        }
    }
}

/// Deletes every chunk `manifest` lists, under both services. Generations in
/// `keep` are skipped. Returns the first error after trying every chunk.
fn delete_manifest_chunks(
    backend: &impl CredentialBackend,
    account_id: &str,
    manifest: &CredentialManifest,
    keep: &[&str],
) -> Result<(), StoreError> {
    let mut first_error = None;
    for generation in std::iter::once(&manifest.active).chain(manifest.previous.as_ref()) {
        if keep.contains(&generation.generation.as_str()) {
            continue;
        }
        for index in 0..generation.chunks {
            let user = credential_chunk_user(account_id, &generation.generation, index);
            for service in SERVICES {
                if let Err(error) = backend.delete(service, &user) {
                    first_error.get_or_insert(error);
                }
            }
        }
    }
    first_error.map_or(Ok(()), Err)
}

/// The manifest a root entry holds, if it is one. A root that is not valid
/// JSON is a plain secret; a manifest with invalid generations is treated as
/// having no chunks to delete, so the root itself can still be removed.
fn root_manifest(stored: &str) -> Option<CredentialManifest> {
    parse_credential_manifest(stored).ok().flatten()
}

/// Removes everything an account has under `service`: the chunks its root
/// lists (except generations in `keep`), then the root. The root stays when a
/// chunk could not be deleted, so a retry can still find the rest.
fn delete_service_root(
    backend: &impl CredentialBackend,
    account_id: &str,
    service: &str,
    keep: &[&str],
) -> Result<(), StoreError> {
    let user = account_credential_user(account_id);
    let Some(stored) = backend.get(service, &user)? else {
        return Ok(());
    };
    if let Some(manifest) = root_manifest(&stored) {
        delete_manifest_chunks(backend, account_id, &manifest, keep)?;
    }
    backend.delete(service, &user)
}

/// Removes every entry the account has under both services. Each service is
/// tried even when the other fails; the first error is returned.
pub(crate) fn delete_account_credentials(
    backend: &impl CredentialBackend,
    account_id: &str,
) -> Result<(), StoreError> {
    let mut first_error = None;
    for service in SERVICES {
        if let Err(error) = delete_service_root(backend, account_id, service, &[]) {
            first_error.get_or_insert(error);
        }
    }
    first_error.map_or(Ok(()), Err)
}

/// Finishes a migration away from the legacy service: removes the legacy root
/// and the chunks it lists. Generations the current root still uses are kept.
/// Nothing to do (the common case) costs one read.
pub(crate) fn remove_legacy_credentials(
    backend: &impl CredentialBackend,
    account_id: &str,
) -> Result<(), StoreError> {
    let current = backend
        .get(CREDENTIAL_SERVICE, &account_credential_user(account_id))?
        .as_deref()
        .and_then(root_manifest);
    let keep: Vec<&str> = current
        .iter()
        .flat_map(|manifest| std::iter::once(&manifest.active).chain(manifest.previous.as_ref()))
        .map(|generation| generation.generation.as_str())
        .collect();
    delete_service_root(backend, account_id, LEGACY_CREDENTIAL_SERVICE, &keep)
}

#[cfg(test)]
mod tests;

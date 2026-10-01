#![cfg_attr(debug_assertions, allow(dead_code))]

use crate::store::StoreError;
#[cfg(not(target_os = "android"))]
#[allow(unused_imports)]
use keyring::Entry;

pub(crate) const CREDENTIAL_SERVICE: &str = "ai-usage-tracker";

pub(crate) const LEGACY_CREDENTIAL_SERVICE: &str = "paseo-usage-bridge";

pub(crate) const BRIDGE_TOKEN_USER: &str = "bridge-api-token";

#[cfg(not(target_os = "android"))]
pub(crate) fn account_credential_user(account_id: &str) -> String {
    format!("account:{account_id}")
}

#[cfg(not(target_os = "android"))]
pub(crate) fn account_credential_entry(account_id: &str) -> Result<Entry, StoreError> {
    credential_entry(&account_credential_user(account_id))
}

#[cfg(not(target_os = "android"))]
pub(crate) fn credential_chunk_user(account_id: &str, generation: &str, index: usize) -> String {
    format!("account:{account_id}:chunk:{generation}:{index}")
}

#[cfg(not(target_os = "android"))]
pub(crate) fn credential_entry(user: &str) -> Result<Entry, StoreError> {
    credential_entry_for(CREDENTIAL_SERVICE, user)
}

#[cfg(not(target_os = "android"))]
pub(crate) fn credential_entry_for(service: &str, user: &str) -> Result<Entry, StoreError> {
    Entry::new(service, user).map_err(|error| StoreError::Credential(error.to_string()))
}

#[cfg(not(target_os = "android"))]
pub(crate) fn read_password(user: &str) -> Result<String, StoreError> {
    read_optional_password(user)?.ok_or_else(|| StoreError::Credential("No matching entry".into()))
}

#[cfg(not(target_os = "android"))]
pub(crate) fn read_optional_password(user: &str) -> Result<Option<String>, StoreError> {
    match credential_entry_for(CREDENTIAL_SERVICE, user)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => {
            match credential_entry_for(LEGACY_CREDENTIAL_SERVICE, user)?.get_password() {
                Ok(value) => Ok(Some(value)),
                Err(keyring::Error::NoEntry) => Ok(None),
                Err(error) => Err(StoreError::Credential(error.to_string())),
            }
        }
        Err(error) => Err(StoreError::Credential(error.to_string())),
    }
}

#[cfg(not(target_os = "android"))]
pub(crate) fn delete_legacy_credential(user: &str) -> Result<(), StoreError> {
    match credential_entry_for(LEGACY_CREDENTIAL_SERVICE, user)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(StoreError::Credential(error.to_string())),
    }
}

#[cfg(not(target_os = "android"))]
pub(crate) fn delete_credential(user: &str) -> Result<(), StoreError> {
    let mut first_error = None;
    for service in [CREDENTIAL_SERVICE, LEGACY_CREDENTIAL_SERVICE] {
        match credential_entry_for(service, user)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(error) => {
                first_error.get_or_insert(StoreError::Credential(error.to_string()));
            }
        }
    }
    match first_error {
        Some(error) => Err(error),
        None => Ok(()),
    }
}

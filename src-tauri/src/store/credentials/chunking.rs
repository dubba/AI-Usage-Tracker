#![cfg_attr(any(target_os = "android", debug_assertions), allow(dead_code))]

#[cfg(not(target_os = "android"))]
use super::keyring_store::{
    account_credential_entry, account_credential_user, credential_chunk_user, credential_entry,
    delete_credential, read_optional_password, read_password,
};
use crate::model::{OAuthSecret, ProviderSecret};
use crate::store::StoreError;
use rand::{distributions::Alphanumeric, Rng};
use serde::{Deserialize, Serialize};

pub(crate) const CHUNKED_CREDENTIAL_FORMAT: &str = "chunked-v1";

#[cfg_attr(target_os = "macos", allow(dead_code))]
pub(crate) const CREDENTIAL_CHUNK_UTF16_UNITS: usize = 1200;

pub(crate) const MAX_CREDENTIAL_CHUNKS: usize = 32;

pub(crate) const CREDENTIAL_GENERATION_LENGTH: usize = 16;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CredentialGeneration {
    pub(in crate::store) generation: String,
    pub(in crate::store) chunks: usize,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CredentialManifest {
    pub(in crate::store) format: String,
    pub(in crate::store) active: CredentialGeneration,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(in crate::store) previous: Option<CredentialGeneration>,
}

#[cfg(not(target_os = "android"))]
#[cfg_attr(target_os = "macos", allow(dead_code))]
pub(crate) fn read_credential_manifest(
    account_id: &str,
) -> Result<Option<CredentialManifest>, StoreError> {
    match read_optional_password(&account_credential_user(account_id))? {
        Some(value) => parse_credential_manifest(&value),
        None => Ok(None),
    }
}

#[cfg(not(target_os = "android"))]
pub(crate) fn parse_credential_manifest(
    value: &str,
) -> Result<Option<CredentialManifest>, StoreError> {
    let Ok(manifest) = serde_json::from_str::<CredentialManifest>(value) else {
        return Ok(None);
    };
    if manifest.format != CHUNKED_CREDENTIAL_FORMAT {
        return Ok(None);
    }
    validate_credential_generation(&manifest.active)?;
    if let Some(previous) = manifest.previous.as_ref() {
        validate_credential_generation(previous)?;
    }
    Ok(Some(manifest))
}

#[cfg(not(target_os = "android"))]
pub(crate) fn validate_credential_generation(
    generation: &CredentialGeneration,
) -> Result<(), StoreError> {
    if generation.chunks == 0 || generation.chunks > MAX_CREDENTIAL_CHUNKS {
        return Err(StoreError::Invalid(format!(
            "credential manifest contains an invalid chunk count: {}",
            generation.chunks
        )));
    }
    if generation.generation.len() != CREDENTIAL_GENERATION_LENGTH
        || !generation
            .generation
            .bytes()
            .all(|value| value.is_ascii_alphanumeric())
    {
        return Err(StoreError::Invalid(
            "credential manifest contains an invalid generation identifier".into(),
        ));
    }
    Ok(())
}

#[cfg(not(target_os = "android"))]
#[cfg_attr(target_os = "macos", allow(dead_code))]
pub(crate) fn write_credential_manifest(
    account_id: &str,
    manifest: &CredentialManifest,
) -> Result<(), StoreError> {
    let payload =
        serde_json::to_string(manifest).map_err(|error| StoreError::Invalid(error.to_string()))?;
    account_credential_entry(account_id)?
        .set_password(&payload)
        .map_err(|error| StoreError::Credential(error.to_string()))
}

#[cfg(not(target_os = "android"))]
#[cfg_attr(target_os = "macos", allow(dead_code))]
pub(crate) fn write_credential_generation(
    account_id: &str,
    generation: &CredentialGeneration,
    chunks: &[String],
) -> Result<(), StoreError> {
    validate_credential_generation(generation)?;
    if chunks.len() != generation.chunks {
        return Err(StoreError::Invalid(
            "credential chunk count does not match its manifest".into(),
        ));
    }

    let mut written = 0;
    for (index, chunk) in chunks.iter().enumerate() {
        let user = credential_chunk_user(account_id, &generation.generation, index);
        match credential_entry(&user)?.set_password(chunk) {
            Ok(()) => written += 1,
            Err(error) => {
                for cleanup_index in 0..written {
                    let cleanup_user =
                        credential_chunk_user(account_id, &generation.generation, cleanup_index);
                    if let Ok(entry) = credential_entry(&cleanup_user) {
                        let _ = entry.delete_credential();
                    }
                }
                return Err(StoreError::Credential(error.to_string()));
            }
        }
    }
    Ok(())
}

#[cfg(not(target_os = "android"))]
pub(crate) fn read_credential_generation(
    account_id: &str,
    generation: &CredentialGeneration,
) -> Result<String, StoreError> {
    validate_credential_generation(generation)?;
    let mut payload = String::new();
    for index in 0..generation.chunks {
        let user = credential_chunk_user(account_id, &generation.generation, index);
        let chunk = read_password(&user)?;
        payload.push_str(&chunk);
    }
    Ok(payload)
}

#[cfg(not(target_os = "android"))]
pub(crate) fn delete_credential_generation(
    account_id: &str,
    generation: &CredentialGeneration,
) -> Result<(), StoreError> {
    validate_credential_generation(generation)?;
    let mut first_error = None;
    for index in 0..generation.chunks {
        let user = credential_chunk_user(account_id, &generation.generation, index);
        if let Err(error) = delete_credential(&user) {
            first_error.get_or_insert(error);
        }
    }
    match first_error {
        Some(error) => Err(error),
        None => Ok(()),
    }
}

pub(crate) fn decode_provider_secret(payload: &str) -> Result<ProviderSecret, StoreError> {
    match serde_json::from_str::<ProviderSecret>(payload) {
        Ok(secret) => Ok(secret),
        Err(provider_error) => serde_json::from_str::<OAuthSecret>(payload)
            .map(ProviderSecret::Openai)
            .map_err(|legacy_error| {
                StoreError::Invalid(format!(
                    "unable to decode provider credentials ({provider_error}); legacy credentials also failed ({legacy_error})"
                ))
            }),
    }
}

#[cfg_attr(target_os = "macos", allow(dead_code))]
pub(crate) fn split_utf16_chunks(value: &str, max_utf16_units: usize) -> Vec<String> {
    if value.is_empty() || max_utf16_units == 0 {
        return Vec::new();
    }

    let mut chunks = Vec::new();
    let mut start = 0;
    let mut used_units = 0;
    for (index, character) in value.char_indices() {
        let character_units = character.len_utf16();
        if used_units + character_units > max_utf16_units {
            chunks.push(value[start..index].to_string());
            start = index;
            used_units = 0;
        }
        used_units += character_units;
    }
    chunks.push(value[start..].to_string());
    chunks
}

#[cfg_attr(target_os = "macos", allow(dead_code))]
pub(crate) fn generate_credential_generation() -> String {
    rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(CREDENTIAL_GENERATION_LENGTH)
        .map(char::from)
        .collect()
}

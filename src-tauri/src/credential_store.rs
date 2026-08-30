use crate::{model::ProviderSecret, store::StoreError};

#[cfg(not(target_os = "macos"))]
use crate::store;

#[cfg(target_os = "macos")]
use crate::model::OAuthSecret;
#[cfg(target_os = "macos")]
use keyring::Entry;
#[cfg(target_os = "macos")]
use serde::Deserialize;

#[cfg(target_os = "macos")]
const CREDENTIAL_SERVICE: &str = "ai-usage-tracker";
#[cfg(target_os = "macos")]
const LEGACY_CREDENTIAL_SERVICE: &str = "paseo-usage-bridge";
#[cfg(target_os = "macos")]
const CHUNKED_CREDENTIAL_FORMAT: &str = "chunked-v1";
#[cfg(target_os = "macos")]
const MAX_CREDENTIAL_CHUNKS: usize = 32;
#[cfg(target_os = "macos")]
const CREDENTIAL_GENERATION_LENGTH: usize = 16;

#[cfg(target_os = "macos")]
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CredentialGeneration {
    generation: String,
    chunks: usize,
}

#[cfg(target_os = "macos")]
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CredentialManifest {
    format: String,
    active: CredentialGeneration,
    #[serde(default)]
    previous: Option<CredentialGeneration>,
}

#[cfg(not(target_os = "macos"))]
pub(super) fn save_provider_secret(
    account_id: &str,
    secret: &ProviderSecret,
) -> Result<(), StoreError> {
    store::save_provider_secret(account_id, secret)
}

#[cfg(not(target_os = "macos"))]
pub(super) fn load_provider_secret(account_id: &str) -> Result<ProviderSecret, StoreError> {
    store::load_provider_secret(account_id)
}

#[cfg(target_os = "macos")]
pub(super) fn save_provider_secret(
    account_id: &str,
    secret: &ProviderSecret,
) -> Result<(), StoreError> {
    let payload =
        serde_json::to_string(secret).map_err(|error| StoreError::Invalid(error.to_string()))?;
    account_credential_entry(account_id)?
        .set_password(&payload)
        .map_err(|error| StoreError::Credential(error.to_string()))
}

#[cfg(target_os = "macos")]
pub(super) fn load_provider_secret(account_id: &str) -> Result<ProviderSecret, StoreError> {
    let user = format!("account:{account_id}");
    let (stored, from_legacy) = read_password(&user)?;
    let entry = credential_entry(&user)?;

    if let Some(manifest) = parse_credential_manifest(&stored)? {
        let payload = read_credential_generation(account_id, &manifest.active)?;
        let secret = decode_provider_secret(&payload)?;

        // Older releases used Windows-sized credential chunks on every platform. Once all
        // chunks have been approved and read successfully, replace the manifest with the
        // complete secret so future refreshes require only one macOS Keychain item.
        if entry.set_password(&payload).is_ok() {
            discard_legacy_credentials(account_id, Some(&manifest));
        }
        return Ok(secret);
    }

    let secret = decode_provider_secret(&stored)?;
    if from_legacy && entry.set_password(&stored).is_ok() {
        discard_legacy_credentials(account_id, None);
    }
    Ok(secret)
}

#[cfg(target_os = "macos")]
fn account_credential_entry(account_id: &str) -> Result<Entry, StoreError> {
    credential_entry(&format!("account:{account_id}"))
}

#[cfg(target_os = "macos")]
fn credential_entry(user: &str) -> Result<Entry, StoreError> {
    credential_entry_for(CREDENTIAL_SERVICE, user)
}

#[cfg(target_os = "macos")]
fn credential_entry_for(service: &str, user: &str) -> Result<Entry, StoreError> {
    Entry::new(service, user).map_err(|error| StoreError::Credential(error.to_string()))
}

#[cfg(target_os = "macos")]
fn delete_legacy_entry(user: &str) -> Result<(), StoreError> {
    match credential_entry_for(LEGACY_CREDENTIAL_SERVICE, user)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(StoreError::Credential(error.to_string())),
    }
}

fn discard_legacy_credentials(account_id: &str, manifest: Option<&CredentialManifest>) {
    let user = format!("account:{account_id}");
    let _ = delete_legacy_entry(&user);
    let Some(manifest) = manifest else {
        return;
    };
    for generation in std::iter::once(&manifest.active).chain(manifest.previous.as_ref()) {
        for index in 0..generation.chunks {
            let chunk_user = credential_chunk_user(account_id, &generation.generation, index);
            let _ = delete_legacy_entry(&chunk_user);
        }
    }
}

fn read_password(user: &str) -> Result<(String, bool), StoreError> {
    match credential_entry_for(CREDENTIAL_SERVICE, user)?.get_password() {
        Ok(value) => Ok((value, false)),
        Err(keyring::Error::NoEntry) => match credential_entry_for(LEGACY_CREDENTIAL_SERVICE, user)?
            .get_password()
        {
            Ok(value) => Ok((value, true)),
            Err(error) => Err(StoreError::Credential(error.to_string())),
        },
        Err(error) => Err(StoreError::Credential(error.to_string())),
    }
}

#[cfg(target_os = "macos")]
fn credential_chunk_user(account_id: &str, generation: &str, index: usize) -> String {
    format!("account:{account_id}:chunk:{generation}:{index}")
}

#[cfg(target_os = "macos")]
fn parse_credential_manifest(value: &str) -> Result<Option<CredentialManifest>, StoreError> {
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

#[cfg(target_os = "macos")]
fn validate_credential_generation(
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

#[cfg(target_os = "macos")]
fn read_credential_generation(
    account_id: &str,
    generation: &CredentialGeneration,
) -> Result<String, StoreError> {
    validate_credential_generation(generation)?;
    let mut payload = String::new();
    for index in 0..generation.chunks {
        let user = credential_chunk_user(account_id, &generation.generation, index);
        let (chunk, _) = read_password(&user)?;
        payload.push_str(&chunk);
    }
    Ok(payload)
}

#[cfg(target_os = "macos")]
fn decode_provider_secret(payload: &str) -> Result<ProviderSecret, StoreError> {
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

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    #[test]
    fn recognizes_legacy_chunked_manifest() {
        let manifest = r#"{
            "format":"chunked-v1",
            "active":{"generation":"AbCdEf0123456789","chunks":3},
            "previous":null
        }"#;
        let parsed = parse_credential_manifest(manifest).unwrap().unwrap();
        assert_eq!(parsed.active.chunks, 3);
    }

    #[test]
    fn ignores_regular_provider_secret_json() {
        assert!(parse_credential_manifest(r#"{"openai":{"accessToken":"token"}}"#)
            .unwrap()
            .is_none());
    }
}

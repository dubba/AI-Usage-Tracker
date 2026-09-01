use crate::{
    fs_util::{atomic_write_private, ensure_private_file},
    model::{Account, OAuthSecret, Provider, ProviderSecret, UsageSnapshot},
};
#[cfg(not(target_os = "android"))]
use keyring::Entry;
use parking_lot::{Mutex, RwLock};
use rand::{distributions::Alphanumeric, Rng};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::LazyLock,
};

static SECRET_CACHE: LazyLock<Mutex<HashMap<String, ProviderSecret>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static DATA_DIR: LazyLock<RwLock<Option<PathBuf>>> =
    LazyLock::new(|| RwLock::new(None));

pub fn set_data_dir(path: PathBuf) {
    *DATA_DIR.write() = Some(path);
}

#[cfg(target_os = "android")]
fn credentials_dir() -> Result<PathBuf, StoreError> {
    let base = DATA_DIR
        .read()
        .clone()
        .ok_or_else(|| StoreError::Credential("Storage directory has not been initialized".into()))?;
    let dir = base.join("credentials");
    fs::create_dir_all(&dir).map_err(|e| StoreError::Io(e.to_string()))?;
    ensure_private_file(&dir).map_err(StoreError::Io)?;
    Ok(dir)
}
use thiserror::Error;

const CREDENTIAL_SERVICE: &str = "ai-usage-tracker";
const LEGACY_CREDENTIAL_SERVICE: &str = "paseo-usage-bridge";
const BRIDGE_TOKEN_USER: &str = "bridge-api-token";
const CHUNKED_CREDENTIAL_FORMAT: &str = "chunked-v1";
#[allow(dead_code)]
const CREDENTIAL_CHUNK_UTF16_UNITS: usize = 1200;
const MAX_CREDENTIAL_CHUNKS: usize = 32;
const CREDENTIAL_GENERATION_LENGTH: usize = 16;

#[derive(Debug, Error)]
pub enum StoreError {
    #[error("credential store error: {0}")]
    Credential(String),
    #[error("metadata store error: {0}")]
    Io(String),
    #[error("invalid metadata: {0}")]
    Invalid(String),
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AccountFile {
    version: u32,
    accounts: Vec<Account>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct CredentialGeneration {
    generation: String,
    chunks: usize,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct CredentialManifest {
    format: String,
    active: CredentialGeneration,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    previous: Option<CredentialGeneration>,
}

pub struct AccountStore {
    data_dir: PathBuf,
    accounts: RwLock<Vec<Account>>,
}

impl AccountStore {
    pub fn load(data_dir: PathBuf) -> Result<Self, StoreError> {
        set_data_dir(data_dir.clone());
        fs::create_dir_all(&data_dir).map_err(|error| StoreError::Io(error.to_string()))?;
        let accounts = read_account_file(&data_dir)?;
        ensure_private_file(&account_path(&data_dir)).map_err(StoreError::Io)?;
        ensure_private_file(&data_dir.join("accounts.json.bak")).map_err(StoreError::Io)?;
        Ok(Self {
            data_dir,
            accounts: RwLock::new(accounts),
        })
    }

    pub fn list(&self) -> Vec<Account> {
        let mut accounts = self.accounts.read().clone();
        accounts.sort_by(|left, right| left.label.to_lowercase().cmp(&right.label.to_lowercase()));
        accounts
    }

    pub fn get(&self, id: &str) -> Option<Account> {
        self.accounts
            .read()
            .iter()
            .find(|account| account.id == id)
            .cloned()
    }

    pub fn upsert(&self, account: Account) -> Result<Account, StoreError> {
        let mut accounts = self.accounts.write();
        let saved = if let Some(existing) = accounts
            .iter_mut()
            .find(|candidate| candidate.id == account.id)
        {
            merge_account(existing, account);
            existing.touch();
            existing.clone()
        } else {
            accounts.push(account.clone());
            account
        };
        write_account_file(&self.data_dir, &accounts)?;
        Ok(saved)
    }

    pub fn mutate<F>(&self, id: &str, update: F) -> Result<Account, StoreError>
    where
        F: FnOnce(&mut Account),
    {
        let mut accounts = self.accounts.write();
        let account = accounts
            .iter_mut()
            .find(|account| account.id == id)
            .ok_or_else(|| StoreError::Invalid("account not found".into()))?;
        update(account);
        account.touch();
        let result = account.clone();
        write_account_file(&self.data_dir, &accounts)?;
        Ok(result)
    }

    pub fn remove(&self, id: &str) -> Result<(), StoreError> {
        self.remove_after_secret_result(id, delete_secret(id))
    }

    fn remove_after_secret_result(
        &self,
        id: &str,
        secret: Result<(), StoreError>,
    ) -> Result<(), StoreError> {
        secret.map_err(|error| {
            StoreError::Credential(format!(
                "Unable to delete saved credentials; the account was not removed ({error})"
            ))
        })?;
        self.remove_account_metadata(id)
    }

    fn remove_account_metadata(&self, id: &str) -> Result<(), StoreError> {
        let mut accounts = self.accounts.write();
        if !accounts.iter().any(|account| account.id == id) {
            return Ok(());
        }
        let remaining: Vec<_> = accounts
            .iter()
            .filter(|account| account.id != id)
            .cloned()
            .collect();
        write_account_file(&self.data_dir, &remaining)?;
        *accounts = remaining;
        Ok(())
    }

    pub fn persist_account(
        &self,
        account: Account,
        secret: &ProviderSecret,
    ) -> Result<Account, StoreError> {
        let id = account.id.clone();
        let existed = self.get(&id).is_some();
        save_provider_secret(&id, secret)?;
        match self.upsert(account) {
            Ok(saved) => Ok(saved),
            Err(error) => {
                if !existed {
                    let _ = delete_secret(&id);
                }
                Err(error)
            }
        }
    }

    pub fn find_duplicate(
        &self,
        provider: &Provider,
        account_id: Option<&str>,
        email: Option<&str>,
    ) -> Option<Account> {
        self.accounts
            .read()
            .iter()
            .find(|account| {
                if &account.provider != provider {
                    return false;
                }
                account_id
                    .filter(|value| !value.is_empty())
                    .is_some_and(|value| account.effective_account_id() == Some(value))
                    || email
                        .filter(|value| !value.is_empty())
                        .is_some_and(|value| {
                            account
                                .email
                                .as_deref()
                                .is_some_and(|candidate| candidate.eq_ignore_ascii_case(value))
                        })
            })
            .cloned()
    }
}

fn merge_account(existing: &mut Account, incoming: Account) {
    existing.label = incoming.label;
    existing.provider = incoming.provider;
    if incoming.email.is_some() {
        existing.email = incoming.email;
    }
    if incoming.provider_account_id.is_some() {
        existing.provider_account_id = incoming.provider_account_id;
    }
    if incoming.chatgpt_account_id.is_some() {
        existing.chatgpt_account_id = incoming.chatgpt_account_id;
    }
    if incoming.plan.is_some() {
        existing.plan = incoming.plan;
    }
    existing.auth_required = incoming.auth_required;
    existing.last_error = incoming.last_error;
    existing.last_usage = newer_usage(existing.last_usage.take(), incoming.last_usage);
}

fn newer_usage(
    existing: Option<UsageSnapshot>,
    incoming: Option<UsageSnapshot>,
) -> Option<UsageSnapshot> {
    match (existing, incoming) {
        (None, incoming) => incoming,
        (existing, None) => existing,
        (Some(left), Some(right)) => {
            if right.fetched_at >= left.fetched_at {
                Some(right)
            } else {
                Some(left)
            }
        }
    }
}

pub fn save_provider_secret(account_id: &str, secret: &ProviderSecret) -> Result<(), StoreError> {
    if cached_secret(account_id).as_ref() == Some(secret) {
        return Ok(());
    }
    persist_provider_secret(account_id, secret)?;
    remember_secret(account_id, secret.clone());
    Ok(())
}

#[cfg(target_os = "android")]
fn persist_provider_secret(account_id: &str, secret: &ProviderSecret) -> Result<(), StoreError> {
    let payload =
        serde_json::to_vec(secret).map_err(|error| StoreError::Invalid(error.to_string()))?;
    let dir = credentials_dir()?;
    let path = dir.join(format!("{account_id}.json"));
    atomic_write_private(&path, &payload).map_err(StoreError::Credential)?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn persist_provider_secret(account_id: &str, secret: &ProviderSecret) -> Result<(), StoreError> {
    let payload =
        serde_json::to_string(secret).map_err(|error| StoreError::Invalid(error.to_string()))?;
    account_credential_entry(account_id)?
        .set_password(&payload)
        .map_err(|error| StoreError::Credential(error.to_string()))
}

#[cfg(not(any(target_os = "macos", target_os = "android")))]
fn persist_provider_secret(account_id: &str, secret: &ProviderSecret) -> Result<(), StoreError> {
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

#[cfg(target_os = "android")]
pub fn load_provider_secret(account_id: &str) -> Result<ProviderSecret, StoreError> {
    if let Some(secret) = cached_secret(account_id) {
        return Ok(secret);
    }
    let dir = credentials_dir()?;
    let path = dir.join(format!("{account_id}.json"));
    if !path.exists() {
        return Err(StoreError::Credential("No matching entry found in secure storage".into()));
    }
    let data = fs::read(&path).map_err(|error| StoreError::Credential(error.to_string()))?;
    let secret: ProviderSecret =
        serde_json::from_slice(&data).map_err(|error| StoreError::Invalid(error.to_string()))?;
    remember_secret(account_id, secret.clone());
    Ok(secret)
}

#[cfg(not(target_os = "android"))]
pub fn load_provider_secret(account_id: &str) -> Result<ProviderSecret, StoreError> {
    if let Some(secret) = cached_secret(account_id) {
        return Ok(secret);
    }
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
    #[cfg(not(any(target_os = "macos", target_os = "android")))]
    let should_migrate = from_legacy;

    if should_migrate && persist_provider_secret(account_id, &secret).is_ok() {
        let _ = delete_legacy_credential(&user);
        if let Some(manifest) = manifest.as_ref() {
            for generation in std::iter::once(&manifest.active).chain(manifest.previous.as_ref()) {
                for index in 0..generation.chunks {
                    let chunk_user = credential_chunk_user(
                        account_id,
                        &generation.generation,
                        index,
                    );
                    let _ = delete_legacy_credential(&chunk_user);
                    let _ = delete_credential(&chunk_user);
                }
            }
        }
    }

    remember_secret(account_id, secret.clone());
    Ok(secret)
}

#[cfg(target_os = "android")]
pub fn delete_secret(account_id: &str) -> Result<(), StoreError> {
    if let Ok(dir) = credentials_dir() {
        let path = dir.join(format!("{account_id}.json"));
        if path.exists() {
            let _ = fs::remove_file(path);
        }
    }
    forget_secret(account_id);
    Ok(())
}

#[cfg(not(target_os = "android"))]
pub fn delete_secret(account_id: &str) -> Result<(), StoreError> {
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

    match first_error {
        Some(error) => Err(error),
        None => {
            forget_secret(account_id);
            Ok(())
        }
    }
}

#[cfg(target_os = "android")]
pub fn load_or_create_bridge_token() -> Result<String, StoreError> {
    let dir = credentials_dir()?;
    let path = dir.join("bridge-token.txt");
    if path.exists() {
        if let Ok(value) = fs::read_to_string(&path) {
            let trimmed = value.trim().to_string();
            if trimmed.len() >= 32 {
                return Ok(trimmed);
            }
        }
    }
    let token = generate_bridge_token();
    atomic_write_private(&path, token.as_bytes()).map_err(StoreError::Credential)?;
    Ok(token)
}

#[cfg(not(target_os = "android"))]
pub fn load_or_create_bridge_token() -> Result<String, StoreError> {
    let entry = credential_entry(BRIDGE_TOKEN_USER)?;
    match entry.get_password() {
        Ok(value) if value.len() >= 32 => Ok(value),
        Ok(_) | Err(keyring::Error::NoEntry) => {
            if let Ok(value) = credential_entry_for(LEGACY_CREDENTIAL_SERVICE, BRIDGE_TOKEN_USER)?
                .get_password()
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

#[cfg(target_os = "android")]
pub fn rotate_bridge_token() -> Result<String, StoreError> {
    let dir = credentials_dir()?;
    let path = dir.join("bridge-token.txt");
    let token = generate_bridge_token();
    atomic_write_private(&path, token.as_bytes()).map_err(StoreError::Credential)?;
    Ok(token)
}

#[cfg(not(target_os = "android"))]
pub fn rotate_bridge_token() -> Result<String, StoreError> {
    let token = generate_bridge_token();
    let entry = credential_entry(BRIDGE_TOKEN_USER)?;
    entry
        .set_password(&token)
        .map_err(|error| StoreError::Credential(error.to_string()))?;
    Ok(token)
}

fn cached_secret(account_id: &str) -> Option<ProviderSecret> {
    SECRET_CACHE.lock().get(account_id).cloned()
}

fn remember_secret(account_id: &str, secret: ProviderSecret) {
    SECRET_CACHE.lock().insert(account_id.to_string(), secret);
}

fn forget_secret(account_id: &str) {
    SECRET_CACHE.lock().remove(account_id);
}

#[cfg(not(target_os = "android"))]
fn account_credential_user(account_id: &str) -> String {
    format!("account:{account_id}")
}

#[cfg(not(target_os = "android"))]
fn account_credential_entry(account_id: &str) -> Result<Entry, StoreError> {
    credential_entry(&account_credential_user(account_id))
}

#[cfg(not(target_os = "android"))]
fn credential_chunk_user(account_id: &str, generation: &str, index: usize) -> String {
    format!("account:{account_id}:chunk:{generation}:{index}")
}

#[cfg(not(target_os = "android"))]
fn credential_entry(user: &str) -> Result<Entry, StoreError> {
    credential_entry_for(CREDENTIAL_SERVICE, user)
}

#[cfg(not(target_os = "android"))]
fn credential_entry_for(service: &str, user: &str) -> Result<Entry, StoreError> {
    Entry::new(service, user).map_err(|error| StoreError::Credential(error.to_string()))
}

#[cfg(not(target_os = "android"))]
fn read_password(user: &str) -> Result<String, StoreError> {
    read_optional_password(user)?.ok_or_else(|| StoreError::Credential("No matching entry".into()))
}

#[cfg(not(target_os = "android"))]
fn read_optional_password(user: &str) -> Result<Option<String>, StoreError> {
    match credential_entry_for(CREDENTIAL_SERVICE, user)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => match credential_entry_for(LEGACY_CREDENTIAL_SERVICE, user)?
            .get_password()
        {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(StoreError::Credential(error.to_string())),
        },
        Err(error) => Err(StoreError::Credential(error.to_string())),
    }
}

#[cfg(not(target_os = "android"))]
fn delete_legacy_credential(user: &str) -> Result<(), StoreError> {
    match credential_entry_for(LEGACY_CREDENTIAL_SERVICE, user)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(StoreError::Credential(error.to_string())),
    }
}

#[cfg(not(target_os = "android"))]
fn delete_credential(user: &str) -> Result<(), StoreError> {
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

#[cfg(not(target_os = "android"))]
#[allow(dead_code)]
fn read_credential_manifest(account_id: &str) -> Result<Option<CredentialManifest>, StoreError> {
    match read_optional_password(&account_credential_user(account_id))? {
        Some(value) => parse_credential_manifest(&value),
        None => Ok(None),
    }
}

#[cfg(not(target_os = "android"))]
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

#[cfg(not(target_os = "android"))]
fn validate_credential_generation(generation: &CredentialGeneration) -> Result<(), StoreError> {
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
#[allow(dead_code)]
fn write_credential_manifest(
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
#[allow(dead_code)]
fn write_credential_generation(
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
fn read_credential_generation(
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
fn delete_credential_generation(
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

#[allow(dead_code)]
fn split_utf16_chunks(value: &str, max_utf16_units: usize) -> Vec<String> {
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

#[allow(dead_code)]
fn generate_credential_generation() -> String {
    rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(CREDENTIAL_GENERATION_LENGTH)
        .map(char::from)
        .collect()
}

fn generate_bridge_token() -> String {
    rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(64)
        .map(char::from)
        .collect()
}

fn account_path(data_dir: &Path) -> PathBuf {
    data_dir.join("accounts.json")
}

fn read_account_file(data_dir: &Path) -> Result<Vec<Account>, StoreError> {
    let path = account_path(data_dir);
    let backup = data_dir.join("accounts.json.bak");
    let source = if path.exists() {
        path
    } else if backup.exists() {
        backup
    } else {
        return Ok(Vec::new());
    };
    let raw = fs::read_to_string(source).map_err(|error| StoreError::Io(error.to_string()))?;
    let parsed: AccountFile =
        serde_json::from_str(&raw).map_err(|error| StoreError::Invalid(error.to_string()))?;
    Ok(parsed.accounts)
}

fn write_account_file(data_dir: &Path, accounts: &[Account]) -> Result<(), StoreError> {
    let file = AccountFile {
        version: 2,
        accounts: accounts.to_vec(),
    };
    let payload =
        serde_json::to_vec_pretty(&file).map_err(|error| StoreError::Invalid(error.to_string()))?;
    let path = account_path(data_dir);
    if path.exists() {
        let backup = data_dir.join("accounts.json.bak");
        let existing = fs::read(&path).map_err(|error| StoreError::Io(error.to_string()))?;
        atomic_write_private(&backup, &existing).map_err(StoreError::Io)?;
    }
    atomic_write_private(&path, &payload).map_err(StoreError::Io)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::now_rfc3339;
    use tempfile::tempdir;

    const WINDOWS_CREDENTIAL_BLOB_LIMIT_BYTES: usize = 2560;

    #[test]
    fn metadata_round_trip() {
        let dir = tempdir().unwrap();
        let store = AccountStore::load(dir.path().to_path_buf()).unwrap();
        let now = now_rfc3339();
        store
            .upsert(Account {
                id: "one".into(),
                label: "Main".into(),
                provider: Provider::Openai,
                email: Some("main@example.com".into()),
                provider_account_id: Some("account-1".into()),
                chatgpt_account_id: Some("account-1".into()),
                plan: Some("plus".into()),
                created_at: now.clone(),
                updated_at: now,
                last_usage: None,
                last_error: None,
                auth_required: false,
            })
            .unwrap();
        let reopened = AccountStore::load(dir.path().to_path_buf()).unwrap();
        assert_eq!(reopened.list().len(), 1);
        assert_eq!(reopened.list()[0].label, "Main");
        assert_eq!(reopened.list()[0].provider, Provider::Openai);
    }

    #[cfg(unix)]
    #[test]
    fn account_metadata_files_are_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempdir().unwrap();
        let store = AccountStore::load(dir.path().to_path_buf()).unwrap();
        store.upsert(sample_account("one", "Main")).unwrap();
        store
            .mutate("one", |account| account.label = "Renamed".into())
            .unwrap();
        for name in ["accounts.json", "accounts.json.bak"] {
            let path = dir.path().join(name);
            let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "{name} should be owner-only");
        }
    }

    #[test]
    fn legacy_account_defaults_to_openai() {
        let raw = r#"{
          "version": 1,
          "accounts": [{
            "id": "legacy",
            "label": "Legacy",
            "email": null,
            "chatgptAccountId": "acct",
            "plan": "plus",
            "createdAt": "2026-01-01T00:00:00Z",
            "updatedAt": "2026-01-01T00:00:00Z",
            "lastUsage": null,
            "lastError": null,
            "authRequired": false
          }]
        }"#;
        let parsed: AccountFile = serde_json::from_str(raw).unwrap();
        assert_eq!(parsed.accounts[0].provider, Provider::Openai);
        assert_eq!(parsed.accounts[0].effective_account_id(), Some("acct"));
    }

    #[test]
    fn large_provider_secret_round_trips_through_chunks() {
        let secret = ProviderSecret::Openai(OAuthSecret {
            access_token: "a".repeat(4200),
            refresh_token: "r".repeat(500),
            id_token: Some("i".repeat(3600)),
            expires_at: 1_800_000_000_000,
        });
        let payload = serde_json::to_string(&secret).unwrap();
        let chunks = split_utf16_chunks(&payload, CREDENTIAL_CHUNK_UTF16_UNITS);
        assert!(chunks.len() > 1);
        assert!(chunks
            .iter()
            .all(|chunk| chunk.encode_utf16().count() * 2 <= WINDOWS_CREDENTIAL_BLOB_LIMIT_BYTES));
        let joined = chunks.concat();
        let decoded = decode_provider_secret(&joined).unwrap();
        match decoded {
            ProviderSecret::Openai(decoded) => {
                assert_eq!(decoded.access_token.len(), 4200);
                assert_eq!(decoded.refresh_token.len(), 500);
                assert_eq!(decoded.id_token.unwrap().len(), 3600);
            }
            _ => panic!("expected OpenAI credentials"),
        }
    }

    #[test]
    fn chunk_split_respects_utf16_surrogate_pairs() {
        let payload = format!(
            "{}{}",
            "x".repeat(CREDENTIAL_CHUNK_UTF16_UNITS - 1),
            "😀".repeat(5)
        );
        let chunks = split_utf16_chunks(&payload, CREDENTIAL_CHUNK_UTF16_UNITS);
        assert_eq!(chunks.concat(), payload);
        assert!(chunks
            .iter()
            .all(|chunk| chunk.encode_utf16().count() * 2 <= WINDOWS_CREDENTIAL_BLOB_LIMIT_BYTES));
    }

    #[test]
    fn legacy_single_entry_secret_still_decodes() {
        let legacy = OAuthSecret {
            access_token: "access".into(),
            refresh_token: "refresh".into(),
            id_token: None,
            expires_at: 123,
        };
        let payload = serde_json::to_string(&legacy).unwrap();
        let decoded = decode_provider_secret(&payload).unwrap();
        assert!(matches!(decoded, ProviderSecret::Openai(_)));
    }

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

    #[test]
    fn upsert_preserves_newer_usage_when_reconnecting() {
        use crate::model::UsageFreshness;
        let dir = tempdir().unwrap();
        let store = AccountStore::load(dir.path().to_path_buf()).unwrap();
        let mut current = sample_account("one", "Main");
        current.email = Some("old@example.com".into());
        current.last_usage = Some(UsageSnapshot {
            plan: Some("plus".into()),
            email: Some("old@example.com".into()),
            windows: Vec::new(),
            credits_usd: None,
            unlimited_credits: false,
            fetched_at: "2026-08-30T12:00:00Z".into(),
            freshness: UsageFreshness::Live,
            source: "wham".into(),
        });
        store.upsert(current).unwrap();

        let mut incoming = sample_account("one", "Renamed");
        incoming.email = Some("new@example.com".into());
        incoming.last_usage = Some(UsageSnapshot {
            plan: Some("plus".into()),
            email: Some("new@example.com".into()),
            windows: Vec::new(),
            credits_usd: None,
            unlimited_credits: false,
            fetched_at: "2026-08-30T11:00:00Z".into(),
            freshness: UsageFreshness::Live,
            source: "wham".into(),
        });
        let saved = store.upsert(incoming).unwrap();
        assert_eq!(saved.label, "Renamed");
        assert_eq!(saved.email.as_deref(), Some("new@example.com"));
        assert_eq!(
            saved.last_usage.as_ref().map(|usage| usage.fetched_at.as_str()),
            Some("2026-08-30T12:00:00Z")
        );
    }

    fn sample_account(id: &str, label: &str) -> Account {
        let now = now_rfc3339();
        Account {
            id: id.into(),
            label: label.into(),
            provider: Provider::Openai,
            email: None,
            provider_account_id: None,
            chatgpt_account_id: None,
            plan: None,
            created_at: now.clone(),
            updated_at: now,
            last_usage: None,
            last_error: None,
            auth_required: false,
        }
    }

    #[test]
    fn remove_keeps_account_when_secret_delete_fails() {
        let dir = tempdir().unwrap();
        let store = AccountStore::load(dir.path().to_path_buf()).unwrap();
        store.upsert(sample_account("one", "Main")).unwrap();

        let error = store
            .remove_after_secret_result("one", Err(StoreError::Credential("denied".into())))
            .unwrap_err();
        assert!(error
            .to_string()
            .contains("Unable to delete saved credentials; the account was not removed"));
        assert_eq!(store.list().len(), 1);
        assert_eq!(store.list()[0].id, "one");
    }

    #[test]
    fn cached_secret_skips_keychain_read_and_unchanged_write() {
        let id = "cache-skip-keychain-io";
        forget_secret(id);
        let secret = ProviderSecret::Openai(OAuthSecret {
            access_token: "access".into(),
            refresh_token: "refresh".into(),
            id_token: None,
            expires_at: 1,
        });
        remember_secret(id, secret.clone());
        assert_eq!(load_provider_secret(id).unwrap(), secret);
        save_provider_secret(id, &secret).unwrap();
        forget_secret(id);
    }

    #[test]
    fn remove_drops_account_after_secret_delete() {
        let dir = tempdir().unwrap();
        let store = AccountStore::load(dir.path().to_path_buf()).unwrap();
        store.upsert(sample_account("one", "Main")).unwrap();
        store
            .remove_after_secret_result("one", Ok(()))
            .unwrap();
        assert!(store.list().is_empty());
        let reopened = AccountStore::load(dir.path().to_path_buf()).unwrap();
        assert!(reopened.list().is_empty());
    }
}

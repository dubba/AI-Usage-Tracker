#[cfg(any(target_os = "android", debug_assertions))]
use crate::credential_file::{platform_cipher, read_credential_file, write_credential_file};
use crate::{
    fs_util::{atomic_write_private, ensure_private_dir, ensure_private_file},
    model::{Account, OAuthSecret, Provider, ProviderSecret, UsageSnapshot},
};
#[cfg(not(target_os = "android"))]
#[allow(unused_imports)]
use keyring::Entry;
use parking_lot::{Mutex, RwLock};
use rand::{distributions::Alphanumeric, Rng};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        LazyLock,
    },
    time::{Duration, Instant},
};
use zeroize::Zeroize;

pub const SECRET_CACHE_TTL: Duration = Duration::from_secs(300);

struct CachedSecret {
    secret: ProviderSecret,
    cached_at: Instant,
    /// True while this secret has not been durably written to the native
    /// store. Refresh tokens rotate, so the previous stored value may already
    /// be revoked: a dirty entry must outlive the cache TTL and be retried,
    /// otherwise a failed write would strand the account.
    dirty: bool,
}

impl Drop for CachedSecret {
    fn drop(&mut self) {
        self.secret.zeroize();
    }
}

static SECRET_CACHE: LazyLock<Mutex<HashMap<String, CachedSecret>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static DATA_DIRS: LazyLock<RwLock<Vec<PathBuf>>> = LazyLock::new(|| RwLock::new(Vec::new()));

const MAX_ACCOUNT_ID_LEN: usize = 64;
/// Oldest deleted-account ids are dropped past this many.
const MAX_TOMBSTONES: usize = 500;

/// Account ids become credential file names and keychain entry names, and
/// arrive from pairing peers, so they must stay a plain token: no path
/// separators, dots, or other characters. Locally generated ids are UUIDs.
pub fn is_valid_account_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_ACCOUNT_ID_LEN
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

fn check_account_id(id: &str) -> Result<(), StoreError> {
    if is_valid_account_id(id) {
        Ok(())
    } else {
        Err(StoreError::Invalid("invalid account id".into()))
    }
}

pub fn set_data_dir(path: PathBuf) {
    let mut dirs = DATA_DIRS.write();
    dirs.retain(|p| p.exists());
    if let Some(pos) = dirs.iter().position(|p| p == &path) {
        dirs.remove(pos);
    }
    dirs.insert(0, path);
}

#[cfg(any(target_os = "android", debug_assertions))]
fn current_credentials_dir() -> Result<PathBuf, StoreError> {
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

/// Seals any plaintext credential files left by earlier versions (Android).
/// A no-op where there is no platform cipher. `failed` in the result is how
/// many credentials are still stored unencrypted.
#[cfg(any(target_os = "android", debug_assertions))]
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub fn upgrade_plaintext_credentials() -> crate::credential_file::UpgradeReport {
    match current_credentials_dir() {
        Ok(dir) => crate::credential_file::upgrade_directory(platform_cipher(), &dir),
        Err(_) => Default::default(),
    }
}

/// Desktop release builds keep credentials in the OS keychain, not in files.
#[cfg(all(not(target_os = "android"), not(debug_assertions)))]
pub fn upgrade_plaintext_credentials() -> crate::credential_file::UpgradeReport {
    Default::default()
}

#[cfg(any(target_os = "android", debug_assertions))]
fn find_credential_file(filename: &str) -> Option<PathBuf> {
    let dirs = DATA_DIRS.read().clone();
    for base in dirs {
        let path = base.join("credentials").join(filename);
        if path.exists() {
            return Some(path);
        }
    }
    None
}
use thiserror::Error;

const CREDENTIAL_SERVICE: &str = "ai-usage-tracker";
const LEGACY_CREDENTIAL_SERVICE: &str = "paseo-usage-bridge";
#[allow(dead_code)]
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

/// Tracks recently deleted account ids so a peer device does not resurrect
/// them during pairing syncs.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TombstoneFile {
    deleted_account_ids: Vec<String>,
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
    /// Bumped on every in-memory change, under the `accounts` lock. Lets the
    /// (slow) file write happen outside that lock without an older snapshot
    /// ever overwriting a newer one.
    version: AtomicU64,
    /// Highest version already written to disk; also serializes writers.
    written_version: Mutex<u64>,
    /// Serializes read-modify-write of the deleted-accounts file.
    tombstone_lock: Mutex<()>,
}

impl AccountStore {
    pub fn load(data_dir: PathBuf) -> Result<Self, StoreError> {
        set_data_dir(data_dir.clone());
        // Protect the application directory itself (listing/traversal), not
        // just the files inside it.
        ensure_private_dir(&data_dir).map_err(StoreError::Io)?;
        let accounts = read_account_file(&data_dir)?;
        ensure_private_file(&account_path(&data_dir)).map_err(StoreError::Io)?;
        ensure_private_file(&data_dir.join("accounts.json.bak")).map_err(StoreError::Io)?;
        // Prune tombstones for live accounts (upgrade wipe-fix: old deleted-accounts.json may contain live ids)
        {
            let live_ids: std::collections::HashSet<String> =
                accounts.iter().map(|a| a.id.clone()).collect();
            let mut tombstones = read_tombstone_file(&data_dir);
            let before = tombstones.deleted_account_ids.len();
            tombstones
                .deleted_account_ids
                .retain(|id| !live_ids.contains(id));
            if tombstones.deleted_account_ids.len() != before {
                let _ = write_tombstone_file(&data_dir, &tombstones);
            }
        }
        Ok(Self {
            data_dir,
            accounts: RwLock::new(accounts),
            version: AtomicU64::new(0),
            written_version: Mutex::new(0),
            tombstone_lock: Mutex::new(()),
        })
    }

    /// Writes `snapshot` unless a newer one already reached the disk. Callers
    /// must not hold the `accounts` lock: the write does file I/O (and on
    /// Windows spawns processes), and readers such as the UI and the local API
    /// should not wait for it.
    fn commit_snapshot(&self, snapshot: &[Account], version: u64) -> Result<(), StoreError> {
        let mut written = self.written_version.lock();
        if version <= *written {
            return Ok(());
        }
        write_account_file(&self.data_dir, snapshot)?;
        *written = version;
        Ok(())
    }

    fn next_version(&self) -> u64 {
        self.version.fetch_add(1, Ordering::SeqCst) + 1
    }

    pub fn list(&self) -> Vec<Account> {
        let mut accounts = self.accounts.read().clone();
        accounts.sort_by_key(|left| left.label.to_lowercase());
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
        let (saved, snapshot, version) = {
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
            (saved, accounts.clone(), self.next_version())
        };
        self.commit_snapshot(&snapshot, version)?;
        Ok(saved)
    }

    pub fn mutate<F>(&self, id: &str, update: F) -> Result<Account, StoreError>
    where
        F: FnOnce(&mut Account),
    {
        let (result, snapshot, version) = {
            let mut accounts = self.accounts.write();
            let account = accounts
                .iter_mut()
                .find(|account| account.id == id)
                .ok_or_else(|| StoreError::Invalid("account not found".into()))?;
            update(account);
            account.touch();
            let result = account.clone();
            (result, accounts.clone(), self.next_version())
        };
        self.commit_snapshot(&snapshot, version)?;
        Ok(result)
    }

    pub fn remove(&self, id: &str) -> Result<(), StoreError> {
        self.remove_after_secret_result(id, delete_secret(id))?;
        self.record_deletion(id);
        Ok(())
    }

    #[cfg(test)]
    pub fn tombstones(&self) -> Vec<String> {
        read_tombstone_file(&self.data_dir).deleted_account_ids
    }

    /// Applies `change` to the tombstone list and saves it if `change` reports
    /// that something changed. Serialized, so two callers (a removal and a
    /// pairing import, say) cannot each read the same list and overwrite the
    /// other's update. Tombstones only stop a peer from resurrecting a removed
    /// account, so a failed save is logged rather than failing the caller.
    fn update_tombstones(&self, change: impl FnOnce(&mut Vec<String>) -> bool) {
        let _guard = self.tombstone_lock.lock();
        let mut tombstones = read_tombstone_file(&self.data_dir);
        if !change(&mut tombstones.deleted_account_ids) {
            return;
        }
        if let Err(error) = write_tombstone_file(&self.data_dir, &tombstones) {
            crate::diagnostics::warn(&format!("Unable to save the deleted-account list: {error}"));
        }
    }

    pub fn merge_tombstones(&self, deleted_ids: &[String]) {
        if deleted_ids.is_empty() {
            return;
        }
        self.update_tombstones(|ids| {
            let before = ids.len();
            for id in deleted_ids {
                if !ids.iter().any(|existing| existing == id) {
                    ids.push(id.clone());
                }
            }
            if ids.len() > MAX_TOMBSTONES {
                let excess = ids.len() - MAX_TOMBSTONES;
                ids.drain(..excess);
            }
            ids.len() != before
        });
    }

    pub fn clear_tombstone(&self, id: &str) {
        self.update_tombstones(|ids| {
            let before = ids.len();
            ids.retain(|existing| existing != id);
            ids.len() != before
        });
    }

    fn record_deletion(&self, id: &str) {
        self.merge_tombstones(&[id.to_string()]);
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
        // Removal writes first and only then changes memory, so a failed write
        // leaves the account in place. It is rare, so it keeps the lock.
        let version = self.next_version();
        self.commit_snapshot(&remaining, version)?;
        *accounts = remaining;
        Ok(())
    }

    pub fn persist_account(
        &self,
        account: Account,
        secret: &ProviderSecret,
    ) -> Result<Account, StoreError> {
        set_data_dir(self.data_dir.clone());
        check_account_id(&account.id)?;
        let id = account.id.clone();
        // Snapshot the previous secret so a metadata-write failure restores
        // the prior generation instead of leaving the new secret orphaned
        // (new accounts) or silently rotated (existing accounts).
        let previous_secret = load_provider_secret(&id).ok();
        save_provider_secret(&id, secret)?;
        match self.upsert(account) {
            Ok(saved) => Ok(saved),
            Err(error) => {
                match previous_secret {
                    Some(previous) => {
                        let _ = save_provider_secret(&id, &previous);
                    }
                    None => {
                        let _ = delete_secret(&id);
                    }
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
                // Conflicting emails prove these are different people, even if a
                // provider-side id (projects, legacy caches) happens to match.
                if let (Some(a), Some(b)) = (account.email.as_deref(), email) {
                    if !a.is_empty() && !b.is_empty() && !a.eq_ignore_ascii_case(b) {
                        return false;
                    }
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
    save_provider_secret_with(account_id, secret, persist_provider_secret)
}

fn save_provider_secret_with(
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
fn persist_provider_secret(account_id: &str, secret: &ProviderSecret) -> Result<(), StoreError> {
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
fn persist_provider_secret(account_id: &str, secret: &ProviderSecret) -> Result<(), StoreError> {
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

#[cfg(all(not(target_os = "android"), not(debug_assertions)))]
fn load_keychain_secret(account_id: &str) -> Result<ProviderSecret, StoreError> {
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
fn delete_keychain_secret(account_id: &str) -> Result<(), StoreError> {
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

fn prune_secret_cache(cache: &mut HashMap<String, CachedSecret>) {
    cache.retain(|_, entry| entry.dirty || entry.cached_at.elapsed() < SECRET_CACHE_TTL);
}

fn cached_secret(account_id: &str) -> Option<ProviderSecret> {
    let mut cache = SECRET_CACHE.lock();
    prune_secret_cache(&mut cache);
    cache.get(account_id).map(|entry| entry.secret.clone())
}

/// True only when `secret` is cached and already persisted, so a save can be
/// skipped. A dirty entry always needs another write attempt.
fn cached_secret_is_clean(account_id: &str, secret: &ProviderSecret) -> bool {
    let mut cache = SECRET_CACHE.lock();
    prune_secret_cache(&mut cache);
    cache
        .get(account_id)
        .is_some_and(|entry| !entry.dirty && &entry.secret == secret)
}

fn remember_secret(account_id: &str, secret: ProviderSecret) {
    // A clean read from the native store must never overwrite a newer secret
    // that is still waiting to be written.
    if SECRET_CACHE
        .lock()
        .get(account_id)
        .is_some_and(|entry| entry.dirty)
    {
        return;
    }
    remember_secret_with_state(account_id, secret, false);
}

fn remember_secret_with_state(account_id: &str, secret: ProviderSecret, dirty: bool) {
    let mut cache = SECRET_CACHE.lock();
    prune_secret_cache(&mut cache);
    cache.insert(
        account_id.to_string(),
        CachedSecret {
            secret,
            cached_at: Instant::now(),
            dirty,
        },
    );
}

fn mark_secret_clean(account_id: &str, secret: &ProviderSecret) {
    let mut cache = SECRET_CACHE.lock();
    if let Some(entry) = cache.get_mut(account_id) {
        // Only clear the flag if no newer secret replaced ours meanwhile.
        if &entry.secret == secret {
            entry.dirty = false;
            entry.cached_at = Instant::now();
        }
    }
}

fn forget_secret(account_id: &str) {
    let mut cache = SECRET_CACHE.lock();
    if let Some(mut entry) = cache.remove(account_id) {
        entry.secret.zeroize();
    }
}

#[cfg(not(target_os = "android"))]
#[allow(dead_code)]
fn account_credential_user(account_id: &str) -> String {
    format!("account:{account_id}")
}

#[cfg(not(target_os = "android"))]
#[allow(dead_code)]
fn account_credential_entry(account_id: &str) -> Result<Entry, StoreError> {
    credential_entry(&account_credential_user(account_id))
}

#[cfg(not(target_os = "android"))]
#[allow(dead_code)]
fn credential_chunk_user(account_id: &str, generation: &str, index: usize) -> String {
    format!("account:{account_id}:chunk:{generation}:{index}")
}

#[cfg(not(target_os = "android"))]
#[allow(dead_code)]
fn credential_entry(user: &str) -> Result<Entry, StoreError> {
    credential_entry_for(CREDENTIAL_SERVICE, user)
}

#[cfg(not(target_os = "android"))]
#[allow(dead_code)]
fn credential_entry_for(service: &str, user: &str) -> Result<Entry, StoreError> {
    Entry::new(service, user).map_err(|error| StoreError::Credential(error.to_string()))
}

#[cfg(not(target_os = "android"))]
#[allow(dead_code)]
fn read_password(user: &str) -> Result<String, StoreError> {
    read_optional_password(user)?.ok_or_else(|| StoreError::Credential("No matching entry".into()))
}

#[cfg(not(target_os = "android"))]
#[allow(dead_code)]
fn read_optional_password(user: &str) -> Result<Option<String>, StoreError> {
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
#[allow(dead_code)]
fn delete_legacy_credential(user: &str) -> Result<(), StoreError> {
    match credential_entry_for(LEGACY_CREDENTIAL_SERVICE, user)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(StoreError::Credential(error.to_string())),
    }
}

#[cfg(not(target_os = "android"))]
#[allow(dead_code)]
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
#[allow(dead_code)]
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
#[allow(dead_code)]
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
#[allow(dead_code)]
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
#[allow(dead_code)]
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

#[allow(dead_code)]
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

pub(crate) fn generate_bridge_token() -> String {
    rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(64)
        .map(char::from)
        .collect()
}

fn account_path(data_dir: &Path) -> PathBuf {
    data_dir.join("accounts.json")
}

fn tombstone_path(data_dir: &Path) -> PathBuf {
    data_dir.join("deleted-accounts.json")
}

fn read_tombstone_file(data_dir: &Path) -> TombstoneFile {
    let path = tombstone_path(data_dir);
    let raw = match fs::read_to_string(&path) {
        Ok(raw) => raw,
        // No file yet is the normal case.
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return TombstoneFile::default()
        }
        Err(error) => {
            crate::diagnostics::warn(&format!("Unable to read the deleted-account list: {error}"));
            return TombstoneFile::default();
        }
    };
    serde_json::from_str(&raw).unwrap_or_else(|error| {
        // Start over rather than fail: the list is only a resurrection guard.
        crate::diagnostics::warn(&format!(
            "The deleted-account list is unreadable and will be rebuilt: {error}"
        ));
        TombstoneFile::default()
    })
}

fn write_tombstone_file(data_dir: &Path, tombstones: &TombstoneFile) -> Result<(), StoreError> {
    let raw = serde_json::to_string(tombstones)
        .map_err(|error| StoreError::Invalid(error.to_string()))?;
    atomic_write_private(&tombstone_path(data_dir), raw.as_bytes())
        .map_err(|error| StoreError::Io(error.to_string()))?;
    ensure_private_file(&tombstone_path(data_dir)).map_err(StoreError::Io)?;
    Ok(())
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
        let existing = fs::read(&path).map_err(|error| StoreError::Io(error.to_string()))?;
        if existing == payload {
            // Nothing changed: skip the write and keep the backup as the
            // genuinely previous version.
            return Ok(());
        }
        refresh_account_backup(&path, &data_dir.join("accounts.json.bak"), &existing)?;
    }
    atomic_write_private(&path, &payload).map_err(StoreError::Io)
}

/// Makes `backup` a copy of the current accounts file before it is replaced.
///
/// The file is never modified in place (writes replace it atomically), so a
/// hard link keeps the old version alive without copying or syncing any data,
/// and it inherits the owner-only permissions the file already has. Falls back
/// to a real copy where hard links are unavailable.
fn refresh_account_backup(path: &Path, backup: &Path, existing: &[u8]) -> Result<(), StoreError> {
    let staging = backup.with_extension("bak.tmp");
    let _ = fs::remove_file(&staging);
    if fs::hard_link(path, &staging).is_ok() {
        if fs::rename(&staging, backup).is_ok() {
            return Ok(());
        }
        let _ = fs::remove_file(&staging);
    }
    atomic_write_private(backup, existing).map_err(StoreError::Io)
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
    fn backup_holds_the_previous_version_and_identical_writes_are_skipped() {
        let dir = tempdir().unwrap();
        let store = AccountStore::load(dir.path().to_path_buf()).unwrap();
        store.upsert(sample_account("one", "First")).unwrap();
        let after_first = fs::read(dir.path().join("accounts.json")).unwrap();

        store
            .mutate("one", |account| account.label = "Second".into())
            .unwrap();
        let after_second = fs::read(dir.path().join("accounts.json")).unwrap();
        assert_ne!(after_first, after_second);
        // The backup is the version before the latest write.
        assert_eq!(
            fs::read(dir.path().join("accounts.json.bak")).unwrap(),
            after_first
        );

        // Re-writing identical contents must not touch the backup.
        let accounts = store.list();
        write_account_file(dir.path(), &accounts).unwrap();
        assert_eq!(
            fs::read(dir.path().join("accounts.json")).unwrap(),
            after_second
        );
        assert_eq!(
            fs::read(dir.path().join("accounts.json.bak")).unwrap(),
            after_first
        );
        assert!(!dir.path().join("accounts.json.bak.tmp").exists());
    }

    #[test]
    fn concurrent_updates_leave_the_latest_state_on_disk() {
        let dir = tempdir().unwrap();
        let store = std::sync::Arc::new(AccountStore::load(dir.path().to_path_buf()).unwrap());
        for index in 0..4 {
            store
                .upsert(sample_account(&format!("acc-{index}"), "Start"))
                .unwrap();
        }
        let handles: Vec<_> = (0..8)
            .map(|worker| {
                let store = store.clone();
                std::thread::spawn(move || {
                    for round in 0..20 {
                        let id = format!("acc-{}", (worker + round) % 4);
                        store
                            .mutate(&id, |account| {
                                account.label = format!("w{worker}-r{round}");
                            })
                            .unwrap();
                    }
                })
            })
            .collect();
        for handle in handles {
            handle.join().unwrap();
        }

        // Whatever interleaving happened, disk must match memory.
        let mut in_memory: Vec<_> = store
            .list()
            .into_iter()
            .map(|account| (account.id, account.label))
            .collect();
        let reopened = AccountStore::load(dir.path().to_path_buf()).unwrap();
        let mut on_disk: Vec<_> = reopened
            .list()
            .into_iter()
            .map(|account| (account.id, account.label))
            .collect();
        in_memory.sort();
        on_disk.sort();
        assert_eq!(in_memory, on_disk);
    }

    #[test]
    fn a_failed_write_is_retried_by_the_next_change() {
        let dir = tempdir().unwrap();
        let store = AccountStore::load(dir.path().to_path_buf()).unwrap();
        store.upsert(sample_account("one", "Start")).unwrap();

        // A directory where the file goes makes the replace fail.
        let path = dir.path().join("accounts.json");
        let saved = fs::read(&path).unwrap();
        fs::remove_file(&path).unwrap();
        fs::create_dir(&path).unwrap();
        assert!(store
            .mutate("one", |account| account.label = "Lost".into())
            .is_err());
        fs::remove_dir(&path).unwrap();
        fs::write(&path, saved).unwrap();

        // The next change writes everything, including the failed one.
        store
            .mutate("one", |account| {
                account.updated_at = "2026-01-01T00:00:00Z".into()
            })
            .unwrap();
        let reopened = AccountStore::load(dir.path().to_path_buf()).unwrap();
        assert_eq!(reopened.list()[0].label, "Lost");
    }

    #[test]
    fn concurrent_tombstone_updates_are_not_lost() {
        let dir = tempdir().unwrap();
        let store = std::sync::Arc::new(AccountStore::load(dir.path().to_path_buf()).unwrap());
        let handles: Vec<_> = (0..16)
            .map(|worker| {
                let store = store.clone();
                std::thread::spawn(move || {
                    for round in 0..10 {
                        store.merge_tombstones(&[format!("gone-{worker}-{round}")]);
                    }
                })
            })
            .collect();
        for handle in handles {
            handle.join().unwrap();
        }
        assert_eq!(store.tombstones().len(), 160);

        // Clearing while others add must not resurrect or drop the rest.
        let clearer = {
            let store = store.clone();
            std::thread::spawn(move || {
                for worker in 0..16 {
                    store.clear_tombstone(&format!("gone-{worker}-0"));
                }
            })
        };
        let adder = {
            let store = store.clone();
            std::thread::spawn(move || {
                for round in 0..20 {
                    store.merge_tombstones(&[format!("late-{round}")]);
                }
            })
        };
        clearer.join().unwrap();
        adder.join().unwrap();
        let ids = store.tombstones();
        assert_eq!(ids.len(), 160 - 16 + 20);
        assert!(ids
            .iter()
            .all(|id| !id.ends_with("-0") || id.starts_with("late")));
    }

    #[test]
    fn tombstone_list_is_capped_and_a_corrupt_file_is_rebuilt() {
        let dir = tempdir().unwrap();
        let store = AccountStore::load(dir.path().to_path_buf()).unwrap();
        let many: Vec<String> = (0..MAX_TOMBSTONES + 25)
            .map(|i| format!("id-{i}"))
            .collect();
        store.merge_tombstones(&many);
        let ids = store.tombstones();
        assert_eq!(ids.len(), MAX_TOMBSTONES);
        assert_eq!(ids[0], "id-25", "the oldest entries are dropped");

        fs::write(dir.path().join("deleted-accounts.json"), b"{not json").unwrap();
        assert!(store.tombstones().is_empty());
        store.merge_tombstones(&["fresh".to_string()]);
        assert_eq!(store.tombstones(), vec!["fresh".to_string()]);
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
        assert!(
            parse_credential_manifest(r#"{"openai":{"accessToken":"token"}}"#)
                .unwrap()
                .is_none()
        );
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
            saved
                .last_usage
                .as_ref()
                .map(|usage| usage.fetched_at.as_str()),
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
        store.remove_after_secret_result("one", Ok(())).unwrap();
        assert!(store.list().is_empty());
        let reopened = AccountStore::load(dir.path().to_path_buf()).unwrap();
        assert!(reopened.list().is_empty());
    }

    fn sample_openai_secret(token: &str) -> ProviderSecret {
        ProviderSecret::Openai(OAuthSecret {
            access_token: format!("access-{token}"),
            refresh_token: format!("refresh-{token}"),
            id_token: None,
            expires_at: 1,
        })
    }

    #[test]
    fn failed_write_keeps_rotated_secret_and_retries() {
        let id = "test-dirty-secret-retry";
        forget_secret(id);
        let original = sample_openai_secret("old");
        save_provider_secret_with(id, &original, |_, _| Ok(())).unwrap();

        let rotated = sample_openai_secret("new");
        let failed = save_provider_secret_with(id, &rotated, |_, _| {
            Err(StoreError::Credential("keychain locked".into()))
        });
        assert!(failed.is_err());
        // Loads must return the rotated secret, not the stale stored one.
        assert_eq!(cached_secret(id), Some(rotated.clone()));
        // A dirty entry never expires with the cache TTL.
        SECRET_CACHE.lock().get_mut(id).unwrap().cached_at =
            Instant::now() - SECRET_CACHE_TTL - Duration::from_secs(1);
        assert_eq!(cached_secret(id), Some(rotated.clone()));

        // Saving the same secret again must attempt the write, not skip it.
        let mut attempts = 0;
        save_provider_secret_with(id, &rotated, |_, _| {
            attempts += 1;
            Ok(())
        })
        .unwrap();
        assert_eq!(attempts, 1);
        assert!(!SECRET_CACHE.lock().get(id).unwrap().dirty);

        // Once clean, an identical save is skipped again.
        save_provider_secret_with(id, &rotated, |_, _| {
            panic!("clean cached secret must not be rewritten")
        })
        .unwrap();
        forget_secret(id);
    }

    #[test]
    fn clean_read_does_not_overwrite_pending_secret() {
        let id = "test-dirty-not-clobbered";
        forget_secret(id);
        let pending = sample_openai_secret("pending");
        remember_secret_with_state(id, pending.clone(), true);
        remember_secret(id, sample_openai_secret("stale"));
        assert_eq!(cached_secret(id), Some(pending));
        forget_secret(id);
    }

    #[test]
    fn account_ids_must_be_plain_tokens() {
        assert!(is_valid_account_id("4f0e8a3c-2b7d-4c1e-9a55-0d3f6b1e7c22"));
        assert!(is_valid_account_id("account_1"));
        for bad in [
            "",
            "../accounts",
            "..",
            "a/b",
            "a\\b",
            "name.json",
            "with space",
            "nul\0byte",
            &"x".repeat(65),
        ] {
            assert!(!is_valid_account_id(bad), "{bad:?} should be rejected");
        }
    }

    #[test]
    fn invalid_account_ids_never_reach_credential_storage() {
        let dir = tempdir().unwrap();
        set_data_dir(dir.path().to_path_buf());
        let secret = sample_openai_secret("traversal");
        assert!(save_provider_secret("../accounts", &secret).is_err());
        assert!(load_provider_secret("../accounts").is_err());
        // Removal of an account with a bad id must not be blocked.
        assert!(delete_secret("../accounts").is_ok());
        assert!(!dir.path().join("accounts.json").exists());

        let store = AccountStore::load(dir.path().to_path_buf()).unwrap();
        assert!(store
            .persist_account(sample_account("../accounts", "Evil"), &secret)
            .is_err());
        assert!(store.list().is_empty());
    }

    #[test]
    fn file_storage_secret_round_trip() {
        let dir = tempdir().unwrap();
        set_data_dir(dir.path().to_path_buf());
        let id = "test-file-storage-round-trip";
        forget_secret(id);
        let secret = ProviderSecret::Openai(OAuthSecret {
            access_token: "file_access".into(),
            refresh_token: "file_refresh".into(),
            id_token: None,
            expires_at: 12345,
        });
        save_provider_secret(id, &secret).unwrap();
        forget_secret(id);
        let loaded = load_provider_secret(id).unwrap();
        assert_eq!(loaded, secret);
        delete_secret(id).unwrap();
        forget_secret(id);
        assert!(load_provider_secret(id).is_err());
    }
}

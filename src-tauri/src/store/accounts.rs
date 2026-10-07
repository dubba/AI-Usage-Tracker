use super::credentials::{delete_secret, load_provider_secret, save_provider_secret};
use super::{check_account_id, set_data_dir, StoreError};
use crate::fs_util::{atomic_write_private, ensure_private_dir, ensure_private_file};
use crate::model::{Account, Provider, ProviderSecret, UsageSnapshot};
use parking_lot::{Mutex, RwLock};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

/// Oldest deleted-account ids are dropped past this many.
pub(crate) const MAX_TOMBSTONES: usize = 500;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AccountFile {
    version: u32,
    pub(in crate::store) accounts: Vec<Account>,
}

/// Tracks recently deleted account ids so a peer device does not resurrect
/// them during pairing syncs.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TombstoneFile {
    deleted_account_ids: Vec<String>,
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

    pub(in crate::store) fn remove_after_secret_result(
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

    /// The stored account a finished reconnect should update. The account the user asked to
    /// reconnect wins, unless the sign-in proves it belongs to someone else; otherwise the
    /// provider identity decides, the same way a fresh connection does.
    pub fn account_to_update(
        &self,
        provider: &Provider,
        reconnect_account_id: Option<&str>,
        account_id: Option<&str>,
        email: Option<&str>,
    ) -> Option<Account> {
        let target = reconnect_account_id
            .and_then(|id| self.get(id))
            .filter(|account| &account.provider == provider)
            .filter(|account| {
                let known = account.effective_account_id();
                let signed_in = account_id.filter(|value| !value.is_empty());
                let ids_conflict = matches!((known, signed_in), (Some(a), Some(b)) if a != b);
                let emails_conflict = matches!(
                    (account.email.as_deref(), email),
                    (Some(a), Some(b))
                        if !a.is_empty() && !b.is_empty() && !a.eq_ignore_ascii_case(b)
                );
                // A different email is definitive. An id on its own can be a different
                // identifier scheme from the one stored earlier, so it only counts when
                // neither side has an email to compare.
                let email_known = account
                    .email
                    .as_deref()
                    .is_some_and(|value| !value.is_empty())
                    && email.is_some_and(|value| !value.is_empty());
                !emails_conflict && (email_known || !ids_conflict)
            });
        target.or_else(|| self.find_duplicate(provider, account_id, email))
    }
}

pub(crate) fn merge_account(existing: &mut Account, incoming: Account) {
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

pub(crate) fn newer_usage(
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

pub(crate) fn account_path(data_dir: &Path) -> PathBuf {
    data_dir.join("accounts.json")
}

pub(crate) fn tombstone_path(data_dir: &Path) -> PathBuf {
    data_dir.join("deleted-accounts.json")
}

pub(crate) fn read_tombstone_file(data_dir: &Path) -> TombstoneFile {
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

pub(crate) fn write_tombstone_file(
    data_dir: &Path,
    tombstones: &TombstoneFile,
) -> Result<(), StoreError> {
    let raw = serde_json::to_string(tombstones)
        .map_err(|error| StoreError::Invalid(error.to_string()))?;
    atomic_write_private(&tombstone_path(data_dir), raw.as_bytes())
        .map_err(|error| StoreError::Io(error.to_string()))?;
    ensure_private_file(&tombstone_path(data_dir)).map_err(StoreError::Io)?;
    Ok(())
}

pub(crate) fn read_account_file(data_dir: &Path) -> Result<Vec<Account>, StoreError> {
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

pub(crate) fn write_account_file(data_dir: &Path, accounts: &[Account]) -> Result<(), StoreError> {
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
pub(crate) fn refresh_account_backup(
    path: &Path,
    backup: &Path,
    existing: &[u8],
) -> Result<(), StoreError> {
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

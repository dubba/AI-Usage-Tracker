//! Saved data: account metadata and credentials, and the other files the app keeps (settings,
//! alerts, groups, account order).
//!
//! - [`accounts`]: account metadata (`accounts.json`, its backup, and the deleted-accounts list).
//! - [`credentials`]: the secrets behind each account and the local API token, kept in the
//!   platform's secure storage (see `credential_store.md`).
//!
//! The two are separate on purpose: metadata may be read, copied and diffed freely, while a
//! credential only ever goes through `credentials`.

pub(crate) mod account_order;
mod accounts;
pub(crate) mod alerts;
pub(crate) mod buckets;
#[cfg(any(target_os = "android", debug_assertions))]
pub(crate) mod credential_file;
mod credentials;
pub(crate) mod installation;
pub(crate) mod json_file;
pub(crate) mod settings;
#[cfg(test)]
mod tests;

pub use accounts::AccountStore;
pub(crate) use credentials::generate_bridge_token;
pub use installation::ensure_clean_installation;
// Only `credential_file` names this type, and it is compiled under the same cfg (see above).
#[cfg(all(target_os = "ios", not(debug_assertions)))]
pub use credentials::allow_background_credential_access;
#[cfg(any(target_os = "android", debug_assertions))]
pub use credentials::UpgradeReport;
pub use credentials::{
    load_or_create_bridge_token, load_provider_secret, rotate_bridge_token, save_provider_secret,
    upgrade_plaintext_credentials,
};

use parking_lot::RwLock;
use std::{path::PathBuf, sync::LazyLock};
use thiserror::Error;

pub(crate) static DATA_DIRS: LazyLock<RwLock<Vec<PathBuf>>> =
    LazyLock::new(|| RwLock::new(Vec::new()));

const MAX_ACCOUNT_ID_LEN: usize = 64;

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

pub(crate) fn check_account_id(id: &str) -> Result<(), StoreError> {
    if is_valid_account_id(id) {
        Ok(())
    } else {
        Err(StoreError::Invalid("invalid account id".into()))
    }
}

/// Tests share one process, and credential saves follow whichever directory was
/// set last. A test that waits between a load and a save holds the guard from
/// [`pin_data_dir_for_test`], or another test can aim that save at a directory
/// it then deletes.
#[cfg(test)]
static DATA_DIR_TEST_LOCK: LazyLock<std::sync::Mutex<()>> =
    LazyLock::new(|| std::sync::Mutex::new(()));

pub fn set_data_dir(path: PathBuf) {
    #[cfg(test)]
    let _guard = DATA_DIR_TEST_LOCK
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    set_data_dir_unlocked(path);
}

fn set_data_dir_unlocked(path: PathBuf) {
    let mut dirs = DATA_DIRS.write();
    dirs.retain(|p| p.exists());
    if let Some(pos) = dirs.iter().position(|p| p == &path) {
        dirs.remove(pos);
    }
    dirs.insert(0, path);
}

/// Points credential saves at `path` and keeps them there until the guard drops.
///
/// The guard is not `Send`. Hold it in a `current_thread` test.
#[cfg(test)]
pub struct DataDirPin {
    _guard: std::sync::MutexGuard<'static, ()>,
}

#[cfg(test)]
pub fn pin_data_dir_for_test(path: PathBuf) -> DataDirPin {
    let guard = DATA_DIR_TEST_LOCK
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    set_data_dir_unlocked(path);
    DataDirPin { _guard: guard }
}

#[derive(Debug, Error)]
pub enum StoreError {
    #[error("credential store error: {0}")]
    Credential(String),
    #[error("metadata store error: {0}")]
    Io(String),
    #[error("invalid metadata: {0}")]
    Invalid(String),
}

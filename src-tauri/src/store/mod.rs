//! Saved account data and credentials.
//!
//! - [`accounts`]: account metadata (`accounts.json`, its backup, and the deleted-accounts list).
//! - [`credentials`]: the secrets behind each account and the local API token, kept in the
//!   platform's secure storage (see `credential_store.md`).
//!
//! The two are separate on purpose: metadata may be read, copied and diffed freely, while a
//! credential only ever goes through `credentials`.

mod accounts;
mod credentials;
#[cfg(test)]
mod tests;

pub use accounts::AccountStore;
pub(crate) use credentials::generate_bridge_token;
pub use credentials::{
    load_or_create_bridge_token, load_provider_secret, rotate_bridge_token, save_provider_secret,
    upgrade_plaintext_credentials,
};
// Named by `credential_file`, which only exists in debug and Android builds.
#[cfg(any(target_os = "android", debug_assertions))]
pub use credentials::UpgradeReport;

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

pub fn set_data_dir(path: PathBuf) {
    let mut dirs = DATA_DIRS.write();
    dirs.retain(|p| p.exists());
    if let Some(pos) = dirs.iter().position(|p| p == &path) {
        dirs.remove(pos);
    }
    dirs.insert(0, path);
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

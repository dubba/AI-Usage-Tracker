//! Installation lifecycle and fresh-install detection.
//!
//! On operating systems where secure storage (such as the iOS Keychain) persists
//! across app uninstall and reinstall, or where a user removes their application data
//! directory before launching the app, a fresh installation must start clean rather
//! than inheriting stale credentials from a deleted instance.

use std::path::Path;

pub const INSTALLATION_RECEIPT_FILE: &str = ".installation_receipt";

const KNOWN_METADATA_FILES: &[&str] = &[
    "accounts.json",
    "accounts.json.bak",
    "app-settings.json",
    "usage-alerts.json",
    "account-order.json",
    "account-buckets.json",
];

/// Returns true if `data_dir` contains any existing metadata files from a prior
/// installation of the app.
pub fn has_existing_metadata(data_dir: &Path) -> bool {
    KNOWN_METADATA_FILES
        .iter()
        .any(|file| data_dir.join(file).exists())
}

/// Ensures that a fresh installation (or a reinstall following an uninstall)
/// starts with a clean slate and does not inherit stale credentials.
///
/// - If `.installation_receipt` exists, this is a normal subsequent launch and no
///   action is taken.
/// - If `.installation_receipt` does not exist, but existing metadata files are found,
///   this is an in-place upgrade from an older version that predated the receipt:
///   the receipt is written and existing credentials are preserved.
/// - If neither the receipt nor any metadata files exist, this is a fresh install or
///   reinstall following an uninstall: lingering keychain credentials from any prior
///   run are purged, and the receipt is written.
pub fn ensure_clean_installation(data_dir: &Path) {
    let receipt_path = data_dir.join(INSTALLATION_RECEIPT_FILE);
    if receipt_path.exists() {
        return;
    }

    if !has_existing_metadata(data_dir) {
        #[cfg(any(target_os = "macos", target_os = "ios"))]
        {
            if let Err(err) =
                crate::store::credentials::keyring_store::purge_all_keychain_credentials()
            {
                crate::diagnostics::error(&format!(
                    "Failed to purge lingering keychain credentials: {err}"
                ));
            }
        }
    }

    if let Err(err) = crate::platform::fs_util::ensure_private_dir(data_dir)
        .map_err(|e| e.to_string())
        .and_then(|_| crate::platform::fs_util::atomic_write_private(&receipt_path, b"installed\n"))
    {
        crate::diagnostics::error(&format!("Failed to write installation receipt: {err}"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn fresh_directory_has_no_existing_metadata() {
        let dir = tempdir().unwrap();
        assert!(!has_existing_metadata(dir.path()));
    }

    #[test]
    fn known_metadata_files_are_detected() {
        for file in KNOWN_METADATA_FILES {
            let dir = tempdir().unwrap();
            let file_path = dir.path().join(file);
            fs::write(&file_path, b"{}").unwrap();
            assert!(
                has_existing_metadata(dir.path()),
                "expected {file} to be recognized as existing metadata"
            );
        }
    }

    #[test]
    fn clean_installation_writes_receipt_and_is_idempotent() {
        let dir = tempdir().unwrap();
        let receipt = dir.path().join(INSTALLATION_RECEIPT_FILE);

        assert!(!receipt.exists());
        ensure_clean_installation(dir.path());
        assert!(receipt.exists());
        assert_eq!(fs::read(&receipt).unwrap(), b"installed\n");

        // Calling again does not error or overwrite with different contents.
        ensure_clean_installation(dir.path());
        assert_eq!(fs::read(&receipt).unwrap(), b"installed\n");
    }

    #[test]
    fn upgrading_existing_installation_creates_receipt_without_error() {
        let dir = tempdir().unwrap();
        let accounts_path = dir.path().join("accounts.json");
        fs::write(&accounts_path, b"[]").unwrap();

        let receipt = dir.path().join(INSTALLATION_RECEIPT_FILE);
        assert!(!receipt.exists());

        ensure_clean_installation(dir.path());
        assert!(receipt.exists());
        assert_eq!(fs::read(&accounts_path).unwrap(), b"[]");
    }
}

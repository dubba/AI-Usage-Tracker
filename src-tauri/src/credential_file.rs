//! On-disk credential files, used where there is no OS keychain to lean on
//! (Android) and by development builds.
//!
//! On Android the payload is sealed with a non-exportable Android Keystore key
//! before it touches the disk, so the private app folder alone (a rooted phone,
//! a forensic image, a copied data directory) no longer yields refresh tokens
//! or the local API token. Development builds keep plain files on purpose.
//!
//! Sealed files start with [`SEALED_MAGIC`]. Files without it are plaintext
//! written by earlier versions; they still load and are upgraded in place.

use crate::fs_util::atomic_write_private;
use std::{fs, path::Path};

/// Marks a sealed credential file. Plaintext credentials are JSON or a bare
/// token, neither of which can start with these bytes.
const SEALED_MAGIC: &[u8] = b"AIUT-SEALED-1\n";

/// Seals and opens credential bytes. `context` (the file name) is bound into
/// the ciphertext so sealed files cannot be swapped between accounts.
pub trait SecretCipher: Send + Sync {
    fn seal(&self, plaintext: &[u8], context: &[u8]) -> Result<Vec<u8>, String>;
    fn open(&self, sealed: &[u8], context: &[u8]) -> Result<Vec<u8>, String>;
}

/// The cipher for this platform: the Android Keystore on Android, none
/// elsewhere (desktop release builds use the OS keychain instead of files).
pub fn platform_cipher() -> Option<&'static dyn SecretCipher> {
    #[cfg(target_os = "android")]
    {
        Some(&crate::android_keystore::AndroidKeystore)
    }
    #[cfg(not(target_os = "android"))]
    {
        None
    }
}

fn context_for(path: &Path) -> Vec<u8> {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned().into_bytes())
        .unwrap_or_default()
}

/// Bytes to store for `plaintext`: sealed when a cipher is available.
pub fn seal_for_storage(
    cipher: Option<&dyn SecretCipher>,
    plaintext: &[u8],
    context: &[u8],
) -> Result<Vec<u8>, String> {
    let Some(cipher) = cipher else {
        return Ok(plaintext.to_vec());
    };
    let sealed = cipher.seal(plaintext, context)?;
    let mut stored = Vec::with_capacity(SEALED_MAGIC.len() + sealed.len());
    stored.extend_from_slice(SEALED_MAGIC);
    stored.extend_from_slice(&sealed);
    Ok(stored)
}

/// What a stored file contains, and whether it should be rewritten sealed.
pub struct Opened {
    pub plaintext: Vec<u8>,
    pub needs_upgrade: bool,
}

pub fn open_stored(
    cipher: Option<&dyn SecretCipher>,
    stored: &[u8],
    context: &[u8],
) -> Result<Opened, String> {
    match stored.strip_prefix(SEALED_MAGIC) {
        Some(sealed) => {
            let cipher = cipher.ok_or_else(|| {
                "This credential is encrypted, but secure storage is unavailable.".to_string()
            })?;
            Ok(Opened {
                plaintext: cipher.open(sealed, context)?,
                needs_upgrade: false,
            })
        }
        None => Ok(Opened {
            plaintext: stored.to_vec(),
            needs_upgrade: cipher.is_some(),
        }),
    }
}

pub fn write_credential_file(
    cipher: Option<&dyn SecretCipher>,
    path: &Path,
    plaintext: &[u8],
) -> Result<(), String> {
    let stored = seal_for_storage(cipher, plaintext, &context_for(path))?;
    atomic_write_private(path, &stored)
}

/// Reads a credential file. A plaintext file from an earlier version is
/// returned as is and rewritten sealed (best effort: a failed upgrade must not
/// lock the user out of a credential that still reads fine, but it is logged
/// and counted, and the next startup or dashboard refresh tries again).
pub fn read_credential_file(
    cipher: Option<&dyn SecretCipher>,
    path: &Path,
) -> Result<Vec<u8>, String> {
    let stored = fs::read(path).map_err(|error| error.to_string())?;
    let opened = open_stored(cipher, &stored, &context_for(path))?;
    if opened.needs_upgrade && write_credential_file(cipher, path, &opened.plaintext).is_err() {
        crate::diagnostics::warn(
            "A saved sign-in could not be encrypted with secure storage; it will be retried.",
        );
    }
    Ok(opened.plaintext)
}

/// What a pass over the credential folder did.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct UpgradeReport {
    /// Plaintext files rewritten sealed.
    pub upgraded: usize,
    /// Files that are still plaintext because they could not be sealed (or
    /// could not even be read). These stay usable but unprotected.
    pub failed: usize,
}

/// Seals every plaintext credential file in `dir`. Run at startup so nothing
/// stays readable just because its account has not been refreshed yet, and
/// again while any file is still plaintext.
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub fn upgrade_directory(cipher: Option<&dyn SecretCipher>, dir: &Path) -> UpgradeReport {
    let mut report = UpgradeReport::default();
    if cipher.is_none() {
        return report;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return report;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() || path.extension().is_some_and(|ext| ext == "tmp") {
            continue;
        }
        let Ok(stored) = fs::read(&path) else {
            report.failed += 1;
            continue;
        };
        if stored.starts_with(SEALED_MAGIC) {
            continue;
        }
        if write_credential_file(cipher, &path, &stored).is_ok() {
            report.upgraded += 1;
        } else {
            report.failed += 1;
        }
    }
    if report.failed > 0 {
        crate::diagnostics::warn(&format!(
            "{} saved sign-in(s) could not be encrypted with secure storage; they will be retried.",
            report.failed
        ));
    }
    report
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    /// Stand-in for the Keystore: reversible, and refuses a different context
    /// the way authenticated encryption does.
    struct FakeCipher;

    impl SecretCipher for FakeCipher {
        fn seal(&self, plaintext: &[u8], context: &[u8]) -> Result<Vec<u8>, String> {
            let mut out = vec![context.len() as u8];
            out.extend_from_slice(context);
            out.extend(plaintext.iter().rev());
            Ok(out)
        }

        fn open(&self, sealed: &[u8], context: &[u8]) -> Result<Vec<u8>, String> {
            let len = *sealed.first().ok_or("empty")? as usize;
            if sealed.get(1..1 + len) != Some(context) {
                return Err("authentication failed".into());
            }
            Ok(sealed[1 + len..].iter().rev().copied().collect())
        }
    }

    const SECRET: &[u8] = br#"{"provider":"openai","credentials":{"accessToken":"a"}}"#;

    #[test]
    fn sealed_files_hide_the_plaintext_and_round_trip() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("acct.json");
        write_credential_file(Some(&FakeCipher), &path, SECRET).unwrap();

        let on_disk = fs::read(&path).unwrap();
        assert!(on_disk.starts_with(SEALED_MAGIC));
        assert!(!on_disk.windows(6).any(|window| window == b"openai"));
        assert_eq!(
            read_credential_file(Some(&FakeCipher), &path).unwrap(),
            SECRET
        );
    }

    #[test]
    fn without_a_cipher_files_stay_plain() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("acct.json");
        write_credential_file(None, &path, SECRET).unwrap();
        assert_eq!(fs::read(&path).unwrap(), SECRET);
        assert_eq!(read_credential_file(None, &path).unwrap(), SECRET);
    }

    #[test]
    fn plaintext_from_an_earlier_version_loads_and_is_upgraded() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("acct.json");
        fs::write(&path, SECRET).unwrap();

        assert_eq!(
            read_credential_file(Some(&FakeCipher), &path).unwrap(),
            SECRET
        );
        // The read rewrote it sealed, and it still reads back.
        assert!(fs::read(&path).unwrap().starts_with(SEALED_MAGIC));
        assert_eq!(
            read_credential_file(Some(&FakeCipher), &path).unwrap(),
            SECRET
        );
    }

    #[test]
    fn a_sealed_file_cannot_be_moved_to_another_account() {
        let dir = tempdir().unwrap();
        let first = dir.path().join("first.json");
        let second = dir.path().join("second.json");
        write_credential_file(Some(&FakeCipher), &first, SECRET).unwrap();
        fs::copy(&first, &second).unwrap();
        assert!(read_credential_file(Some(&FakeCipher), &second).is_err());
    }

    #[test]
    fn a_sealed_file_without_secure_storage_is_an_error_not_garbage() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("acct.json");
        write_credential_file(Some(&FakeCipher), &path, SECRET).unwrap();
        let error = read_credential_file(None, &path).unwrap_err();
        assert!(error.contains("secure storage"), "{error}");
    }

    #[test]
    fn a_failed_upgrade_still_returns_the_credential() {
        struct BrokenSeal;
        impl SecretCipher for BrokenSeal {
            fn seal(&self, _: &[u8], _: &[u8]) -> Result<Vec<u8>, String> {
                Err("keystore unavailable".into())
            }
            fn open(&self, _: &[u8], _: &[u8]) -> Result<Vec<u8>, String> {
                Err("keystore unavailable".into())
            }
        }
        let dir = tempdir().unwrap();
        let path = dir.path().join("acct.json");
        fs::write(&path, SECRET).unwrap();
        assert_eq!(
            read_credential_file(Some(&BrokenSeal), &path).unwrap(),
            SECRET
        );
        // Left as it was rather than damaged.
        assert_eq!(fs::read(&path).unwrap(), SECRET);
    }

    #[test]
    fn directory_upgrade_seals_plaintext_files_once() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("a.json"), SECRET).unwrap();
        fs::write(dir.path().join("bridge-token.txt"), b"t".repeat(64)).unwrap();
        write_credential_file(Some(&FakeCipher), &dir.path().join("b.json"), SECRET).unwrap();

        assert_eq!(
            upgrade_directory(Some(&FakeCipher), dir.path()),
            UpgradeReport {
                upgraded: 2,
                failed: 0
            }
        );
        assert_eq!(
            upgrade_directory(Some(&FakeCipher), dir.path()),
            UpgradeReport::default()
        );
        for name in ["a.json", "b.json", "bridge-token.txt"] {
            assert!(fs::read(dir.path().join(name))
                .unwrap()
                .starts_with(SEALED_MAGIC));
        }
        assert_eq!(
            read_credential_file(Some(&FakeCipher), &dir.path().join("bridge-token.txt")).unwrap(),
            b"t".repeat(64)
        );
        // Nothing to do without a cipher (desktop development builds).
        assert_eq!(
            upgrade_directory(None, dir.path()),
            UpgradeReport::default()
        );
    }

    #[test]
    fn directory_upgrade_counts_files_it_could_not_seal_and_retries_them() {
        use std::sync::atomic::{AtomicBool, Ordering};
        struct Flaky(AtomicBool);
        impl SecretCipher for Flaky {
            fn seal(&self, plaintext: &[u8], context: &[u8]) -> Result<Vec<u8>, String> {
                if self.0.load(Ordering::SeqCst) {
                    return Err("keystore unavailable".into());
                }
                FakeCipher.seal(plaintext, context)
            }
            fn open(&self, sealed: &[u8], context: &[u8]) -> Result<Vec<u8>, String> {
                FakeCipher.open(sealed, context)
            }
        }
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("a.json"), SECRET).unwrap();
        fs::write(dir.path().join("b.json"), SECRET).unwrap();
        let cipher = Flaky(AtomicBool::new(true));

        // Nothing is damaged or lost while sealing keeps failing.
        assert_eq!(
            upgrade_directory(Some(&cipher), dir.path()),
            UpgradeReport {
                upgraded: 0,
                failed: 2
            }
        );
        assert_eq!(fs::read(dir.path().join("a.json")).unwrap(), SECRET);

        // Once the keystore recovers, the next pass seals them.
        cipher.0.store(false, Ordering::SeqCst);
        assert_eq!(
            upgrade_directory(Some(&cipher), dir.path()),
            UpgradeReport {
                upgraded: 2,
                failed: 0
            }
        );
        assert!(fs::read(dir.path().join("b.json"))
            .unwrap()
            .starts_with(SEALED_MAGIC));
    }
}

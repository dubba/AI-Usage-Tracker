use std::{fs, io::Write, path::Path};

#[cfg(unix)]
pub const PRIVATE_FILE_MODE: u32 = 0o600;
#[cfg(unix)]
pub const PRIVATE_DIR_MODE: u32 = 0o700;

#[cfg(unix)]
pub fn restrict_private_permissions(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let mode = if path.is_dir() {
        PRIVATE_DIR_MODE
    } else {
        PRIVATE_FILE_MODE
    };
    fs::set_permissions(path, fs::Permissions::from_mode(mode)).map_err(|error| {
        format!(
            "Unable to restrict permissions for {}: {error}",
            path.display()
        )
    })
}

/// Windows owner-only ACL hardening via `icacls`.
///
/// Removes inherited ACEs and grants full control to the current user only
/// (`(OI)(CI)` object/container inherit for directories, plain `F` for
/// files). Fails closed: if the ACL cannot be applied, the caller must treat
/// the file/dir as unprotected and abort the write rather than leaving a
/// world-readable secret behind.
///
/// Secrets themselves live in Windows Credential Manager (DPAPI-backed) via
/// the `keyring` crate in release builds; this function protects the metadata
/// and debug-fallback files that remain on disk.
#[cfg(windows)]
pub fn restrict_private_permissions(path: &Path) -> Result<(), String> {
    use std::process::Command;

    let username = std::env::var("USERNAME").map_err(|_| {
        "Unable to determine the current user for file ACL hardening".to_string()
    })?;
    if username.trim().is_empty() || username.contains(['/', '\\', '"']) {
        return Err("Invalid username for file ACL hardening".into());
    }
    let grant = if path.is_dir() {
        format!("{username}:(OI)(CI)F")
    } else {
        format!("{username}:F")
    };
    let output = Command::new("icacls")
        .arg(path)
        .arg("/inheritance:r")
        .arg("/grant:r")
        .arg(&grant)
        .output()
        .map_err(|error| format!("Unable to harden file permissions (icacls): {error}"))?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "Unable to restrict permissions for {}: {}",
            path.display(),
            detail.trim()
        ));
    }
    Ok(())
}

#[cfg(not(any(unix, windows)))]
pub fn restrict_private_permissions(_path: &Path) -> Result<(), String> {
    // Unknown platform: no OS primitive available. Fail closed so callers do
    // not silently leave secrets world-readable.
    Err("Private file permissions are not supported on this platform".into())
}

pub fn ensure_private_file(path: &Path) -> Result<(), String> {
    if path.exists() {
        restrict_private_permissions(path)?;
    }
    Ok(())
}

/// Creates `dir` (including parents) and forces owner-only permissions on it.
/// Every application directory that holds metadata or debug-fallback secrets
/// must go through this instead of a bare `create_dir_all`.
pub fn ensure_private_dir(dir: &Path) -> Result<(), String> {
    fs::create_dir_all(dir)
        .map_err(|error| format!("Unable to create {}: {error}", dir.display()))?;
    restrict_private_permissions(dir)
}

/// Atomic, owner-only file write with no remove-then-rename window.
///
/// The payload is written to a `tempfile` in the same directory (same
/// filesystem, `O_EXCL`), hardened, `fsync`ed, then atomically persisted over
/// the destination (`rename` on Unix, `MoveFileEx(REPLACE_EXISTING)` on
/// Windows via `tempfile::persist`). There is never a moment where the
/// destination is absent, and a crash can only leave the old file or the new
/// file — never a half-written one.
pub fn atomic_write_private(path: &Path, payload: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or_else(|| {
        format!(
            "Unable to determine parent directory for {}",
            path.display()
        )
    })?;
    ensure_private_dir(parent)?;

    let mut tmp = tempfile::NamedTempFile::new_in(parent)
        .map_err(|error| format!("Unable to create temp file for {}: {error}", path.display()))?;
    tmp.write_all(payload)
        .map_err(|error| format!("Unable to write {}: {error}", path.display()))?;
    tmp.as_file()
        .sync_all()
        .map_err(|error| format!("Unable to sync {}: {error}", path.display()))?;
    // Harden the temp inode before it becomes visible at the destination.
    // tempfile creates 0600 on Unix already; this also covers umask gaps and
    // applies the Windows owner-only ACL.
    if let Err(error) = restrict_private_permissions(tmp.path()) {
        let _ = tmp.close();
        return Err(error);
    }
    tmp.persist(path)
        .map_err(|error| format!("Unable to replace {}: {error}", path.display()))?;
    // Re-apply on the destination: on Windows a replace may retain the old
    // destination ACL, on Unix the mode comes from the temp inode.
    restrict_private_permissions(path)?;
    // Best-effort durability of the directory entry itself.
    if let Ok(dir_file) = fs::File::open(parent) {
        let _ = dir_file.sync_all();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn atomic_write_private_creates_owner_only_files() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("secret.json");
        atomic_write_private(&path, b"{\"token\":1}").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"{\"token\":1}");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, PRIVATE_FILE_MODE);
        }
    }

    #[test]
    fn atomic_write_private_replaces_existing_contents() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("accounts.json");
        atomic_write_private(&path, b"first").unwrap();
        atomic_write_private(&path, b"second").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"second");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, PRIVATE_FILE_MODE);
        }
    }

    #[test]
    fn atomic_replace_never_leaves_destination_absent() {
        // Repeated replaces must always leave either the old or the new
        // contents behind — never a missing file (the old remove+rename
        // fallback briefly unlinked the destination).
        let directory = tempdir().unwrap();
        let path = directory.path().join("accounts.json");
        atomic_write_private(&path, b"v0").unwrap();
        for i in 1..20 {
            let payload = format!("v{i}");
            atomic_write_private(&path, payload.as_bytes()).unwrap();
            assert!(path.exists());
            assert_eq!(fs::read(&path).unwrap(), payload.as_bytes());
        }
    }

    #[cfg(unix)]
    #[test]
    fn ensure_private_dir_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let directory = tempdir().unwrap();
        let nested = directory.path().join("a").join("b");
        ensure_private_dir(&nested).unwrap();
        let mode = fs::metadata(&nested).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, PRIVATE_DIR_MODE);
    }
}

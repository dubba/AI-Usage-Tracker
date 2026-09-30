use parking_lot::Mutex;
use std::{
    collections::HashSet,
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::LazyLock,
};

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
/// The grant names the user by SID (`*S-1-…`), not by the `USERNAME`
/// environment variable, which is unreliable on domain accounts and can be
/// changed by anything that starts this process. Both helper tools run from
/// `System32` by absolute path so nothing on `PATH` or in the working
/// directory can stand in for them.
///
/// Secrets themselves live in Windows Credential Manager (DPAPI-backed) via
/// the `keyring` crate in release builds; this function protects the metadata
/// and debug-fallback files that remain on disk.
#[cfg(windows)]
pub fn restrict_private_permissions(path: &Path) -> Result<(), String> {
    use std::process::Command;

    let sid = current_user_sid()?;
    let grant = if path.is_dir() {
        format!("*{sid}:(OI)(CI)F")
    } else {
        format!("*{sid}:F")
    };
    let output = Command::new(system32_tool("icacls.exe"))
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

/// A tool from the Windows `System32` folder, by absolute path.
#[cfg(windows)]
fn system32_tool(name: &str) -> PathBuf {
    let root = std::env::var_os("SystemRoot")
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "C:\\Windows".into());
    Path::new(&root).join("System32").join(name)
}

/// The current user's SID, looked up once per process.
#[cfg(windows)]
fn current_user_sid() -> Result<String, String> {
    use std::{process::Command, sync::OnceLock};

    static SID: OnceLock<String> = OnceLock::new();
    if let Some(sid) = SID.get() {
        return Ok(sid.clone());
    }
    let output = Command::new(system32_tool("whoami.exe"))
        .args(["/user", "/fo", "csv", "/nh"])
        .output()
        .map_err(|error| {
            format!("Unable to determine the current user for file ACL hardening: {error}")
        })?;
    let sid = output
        .status
        .success()
        .then(|| parse_whoami_sid(&String::from_utf8_lossy(&output.stdout)))
        .flatten()
        .ok_or_else(|| "Unable to determine the current user for file ACL hardening".to_string())?;
    Ok(SID.get_or_init(|| sid).clone())
}

/// Extracts the SID from `whoami /user /fo csv /nh` output, which looks like
/// `"DOMAIN\user","S-1-5-21-1-2-3-1001"`. Anything that is not a well-formed
/// SID is rejected, because the value ends up in an `icacls` argument.
#[cfg_attr(not(windows), allow(dead_code))]
fn parse_whoami_sid(output: &str) -> Option<String> {
    let sid = output.trim().rsplit(',').next()?.trim().trim_matches('"');
    let parts: Vec<&str> = sid.split('-').collect();
    let well_formed = parts.len() >= 4
        && parts[0] == "S"
        && parts[1..]
            .iter()
            .all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()));
    well_formed.then(|| sid.to_string())
}

#[cfg(not(any(unix, windows)))]
pub fn restrict_private_permissions(_path: &Path) -> Result<(), String> {
    // Unknown platform: no OS primitive available. Fail closed so callers do
    // not silently leave secrets world-readable.
    Err("Private file permissions are not supported on this platform".into())
}

/// Paths already hardened by this process. On Windows every hardening spawns
/// `icacls`, and an account update used to spawn it about six times, so paths
/// are hardened once and later writes rely on the ACL they already have.
static HARDENED: LazyLock<Mutex<HashSet<PathBuf>>> = LazyLock::new(|| Mutex::new(HashSet::new()));

/// Runs `harden` for `path` unless this process already did so successfully.
#[cfg_attr(not(windows), allow(dead_code))]
fn harden_once(
    path: &Path,
    harden: impl FnOnce(&Path) -> Result<(), String>,
) -> Result<(), String> {
    if HARDENED.lock().contains(path) {
        return Ok(());
    }
    harden(path)?;
    HARDENED.lock().insert(path.to_path_buf());
    Ok(())
}

/// Forgets a path so it is hardened again (it was deleted and recreated).
#[cfg_attr(not(windows), allow(dead_code))]
fn forget_hardened(path: &Path) {
    HARDENED.lock().remove(path);
}

#[cfg_attr(not(windows), allow(dead_code))]
fn is_hardened(path: &Path) -> bool {
    HARDENED.lock().contains(path)
}

/// Owner-only permissions, applied once per process on Windows (where it is
/// expensive) and every time elsewhere (where it is a single `chmod`).
fn harden_cached(path: &Path) -> Result<(), String> {
    #[cfg(windows)]
    {
        harden_once(path, restrict_private_permissions)
    }
    #[cfg(not(windows))]
    {
        restrict_private_permissions(path)
    }
}

pub fn ensure_private_file(path: &Path) -> Result<(), String> {
    if path.exists() {
        harden_cached(path)?;
    }
    Ok(())
}

/// Creates `dir` (including parents) and forces owner-only permissions on it.
/// Every application directory that holds metadata or debug-fallback secrets
/// must go through this instead of a bare `create_dir_all`.
pub fn ensure_private_dir(dir: &Path) -> Result<(), String> {
    let existed = dir.is_dir();
    fs::create_dir_all(dir)
        .map_err(|error| format!("Unable to create {}: {error}", dir.display()))?;
    if !existed {
        // A directory we just (re)created is not the one we hardened earlier.
        forget_hardened(dir);
    }
    harden_cached(dir)
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
    if !path.exists() {
        forget_hardened(path);
    }

    let mut tmp = tempfile::NamedTempFile::new_in(parent)
        .map_err(|error| format!("Unable to create temp file for {}: {error}", path.display()))?;
    tmp.write_all(payload)
        .map_err(|error| format!("Unable to write {}: {error}", path.display()))?;
    tmp.as_file()
        .sync_all()
        .map_err(|error| format!("Unable to sync {}: {error}", path.display()))?;
    // Harden the temp inode before it becomes visible at the destination.
    // tempfile creates 0600 on Unix already; this also covers umask gaps and
    // applies the Windows owner-only ACL. On Windows a file created inside an
    // already-hardened directory inherits its owner-only ACL, so the extra
    // `icacls` is skipped there.
    let inherits_owner_only_acl = cfg!(windows) && is_hardened(parent);
    if !inherits_owner_only_acl {
        if let Err(error) = restrict_private_permissions(tmp.path()) {
            let _ = tmp.close();
            return Err(error);
        }
    }
    tmp.persist(path)
        .map_err(|error| format!("Unable to replace {}: {error}", path.display()))?;
    // Re-apply on the destination (first write of each path per process on
    // Windows): a replace may retain the old destination ACL, and on Unix the
    // mode comes from the temp inode.
    harden_cached(path)?;
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
    fn whoami_output_yields_only_a_well_formed_sid() {
        assert_eq!(
            parse_whoami_sid("\"desktop\\momo\",\"S-1-5-21-111-222-333-1001\"\r\n").as_deref(),
            Some("S-1-5-21-111-222-333-1001")
        );
        assert_eq!(parse_whoami_sid(""), None);
        assert_eq!(parse_whoami_sid("\"user\",\"not-a-sid\""), None);
        assert_eq!(parse_whoami_sid("\"user\",\"S-1-5-21-1;calc\""), None);
        assert_eq!(parse_whoami_sid("\"user\",\"S-1-\""), None);
    }

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

    #[test]
    fn harden_once_runs_the_hardening_only_once_per_path() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("secret.json");
        let mut runs = 0;
        harden_once(&path, |_| {
            runs += 1;
            Ok(())
        })
        .unwrap();
        harden_once(&path, |_| {
            runs += 1;
            Ok(())
        })
        .unwrap();
        assert_eq!(runs, 1);

        // Forgetting (the path was deleted and recreated) hardens it again.
        forget_hardened(&path);
        harden_once(&path, |_| {
            runs += 1;
            Ok(())
        })
        .unwrap();
        assert_eq!(runs, 2);
    }

    #[test]
    fn failed_hardening_is_not_remembered() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("secret.json");
        assert!(harden_once(&path, |_| Err("denied".into())).is_err());
        assert!(!is_hardened(&path));
        let mut runs = 0;
        harden_once(&path, |_| {
            runs += 1;
            Ok(())
        })
        .unwrap();
        assert_eq!(runs, 1);
    }

    #[test]
    fn recreated_directory_is_hardened_again() {
        let directory = tempdir().unwrap();
        let nested = directory.path().join("data");
        ensure_private_dir(&nested).unwrap();
        HARDENED.lock().insert(nested.clone());
        fs::remove_dir_all(&nested).unwrap();
        ensure_private_dir(&nested).unwrap();
        #[cfg(windows)]
        assert!(is_hardened(&nested));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&nested).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, PRIVATE_DIR_MODE);
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

use std::{fs, io::Write, path::Path};
use uuid::Uuid;

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

#[cfg(not(unix))]
pub fn restrict_private_permissions(_path: &Path) -> Result<(), String> {
    Ok(())
}

pub fn ensure_private_file(path: &Path) -> Result<(), String> {
    if path.exists() {
        restrict_private_permissions(path)?;
    }
    Ok(())
}

fn create_private_file(path: &Path) -> Result<fs::File, String> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(PRIVATE_FILE_MODE);
    }
    let file = options.open(path).map_err(|error| {
        format!("Unable to create {}: {error}", path.display())
    })?;
    // OpenOptions::mode is still masked by umask. Force owner-only bits on the
    // empty inode before any payload is written.
    if let Err(error) = restrict_private_permissions(path) {
        let _ = fs::remove_file(path);
        return Err(error);
    }
    Ok(file)
}

pub fn atomic_write_private(path: &Path, payload: &[u8]) -> Result<(), String> {
    let temporary_path = path.with_extension(format!("tmp.{}", Uuid::new_v4()));
    let write_result = (|| {
        let mut file = create_private_file(&temporary_path)?;
        file.write_all(payload).map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
        Ok(())
    })();
    if let Err(error) = write_result {
        let _ = fs::remove_file(&temporary_path);
        return Err(error);
    }
    match fs::rename(&temporary_path, path) {
        Ok(()) => Ok(()),
        Err(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::AlreadyExists | std::io::ErrorKind::PermissionDenied
            ) =>
        {
            let _ = fs::remove_file(path);
            fs::rename(&temporary_path, path).map_err(|error| error.to_string())
        }
        Err(error) => {
            let _ = fs::remove_file(&temporary_path);
            Err(error.to_string())
        }
    }
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
}

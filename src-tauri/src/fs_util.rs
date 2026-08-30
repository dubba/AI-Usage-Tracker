use std::{fs, io::Write, path::Path};
use uuid::Uuid;

#[cfg(unix)]
pub fn restrict_private_permissions(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).map_err(|error| {
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

pub fn atomic_write_private(path: &Path, payload: &[u8]) -> Result<(), String> {
    let temporary_path = path.with_extension(format!("tmp.{}", Uuid::new_v4()));
    let mut file = fs::File::create(&temporary_path).map_err(|error| error.to_string())?;
    file.write_all(payload).map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())?;
    if let Err(error) = restrict_private_permissions(&temporary_path) {
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

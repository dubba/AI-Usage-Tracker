//! What a real uninstall removes on Windows: the app's saved sign-ins in Credential Manager, its
//! two data folders, and leftover sign-in profiles in the temp folder.
//!
//! The uninstaller closes the app, then runs it with [`FLAG`] before it deletes the app's files
//! (`windows/hooks.nsh`). [`run`] is called before anything else starts, the single-instance
//! plugin included, so the flag is never handed to a copy that is already running. In-app updates
//! do not run the uninstaller this way.
//!
//! For one release the hook keeps the PowerShell script it used before (`windows/
//! remove-windows-credentials.ps1`) for when the app cannot be run; it reads the same rules from
//! `windows/uninstall-rules.json`, which a test keeps in line with the credential module.

use std::path::Path;

/// The argument the uninstaller passes.
pub const FLAG: &str = "--uninstall-cleanup";

/// The app's identifier (`tauri.conf.json`), which names its data folders.
pub(crate) const BUNDLE_ID: &str = "com.dubba.ai.usage.tracker";

/// The exit code when everything was removed.
pub const REMOVED: i32 = 0;
/// The exit code when some saved sign-ins are still in Credential Manager. Anything else (a
/// crash) makes the uninstaller run the PowerShell fallback.
pub const CREDENTIALS_LEFT: i32 = 2;

/// True when the process was started only to clean up for the uninstaller.
pub fn requested(mut args: impl Iterator<Item = std::ffi::OsString>) -> bool {
    let _program = args.next();
    matches!((args.next(), args.next()), (Some(arg), None) if arg == FLAG)
}

/// Removes everything and returns the process exit code. Nothing is logged: the log is in one of
/// the folders being removed.
#[cfg(windows)]
pub fn run() -> i32 {
    let credentials_removed = crate::store::credential_uninstall::remove_app_credentials(
        &crate::store::credential_uninstall::SERVICES,
    );
    for parent in ["APPDATA", "LOCALAPPDATA"] {
        if let Some(parent) = std::env::var_os(parent) {
            let _ = remove_data_dir(Path::new(&parent));
        }
    }
    crate::auth::login_profile::sweep_all_stale_profiles();
    if credentials_removed {
        REMOVED
    } else {
        CREDENTIALS_LEFT
    }
}

/// Removes `parent/<BUNDLE_ID>` and everything in it. A link or junction planted there is left
/// alone, so nothing is deleted through it; `remove_dir_all` does not follow links inside.
fn remove_data_dir(parent: &Path) -> std::io::Result<()> {
    let dir = parent.join(BUNDLE_ID);
    let metadata = match std::fs::symlink_metadata(&dir) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    if is_link(&metadata) || !metadata.is_dir() {
        return Ok(());
    }
    std::fs::remove_dir_all(dir)
}

fn is_link(metadata: &std::fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return true;
        }
    }
    metadata.file_type().is_symlink()
}

#[cfg(test)]
mod tests;

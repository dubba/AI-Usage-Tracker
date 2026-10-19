//! The private, throwaway browser profile each desktop sign-in window runs in (Grok, OpenCode
//! and the provider OAuth windows): created owner-only in the system temp dir, and swept at
//! startup and before each new login in case a crash left one behind.

use std::path::{Path, PathBuf};

/// A sign-in attempt id is a UUID; anything else must not be joined into a path.
const MAX_ATTEMPT_ID_LEN: usize = 64;

/// Creates `<temp dir>/<prefix><attempt_id>` readable by the current user only.
///
/// Fails closed: if the permissions cannot be restricted, the directory is removed rather than
/// left readable, since it will hold a signed-in browser session.
pub(crate) fn create_private_profile_dir(
    prefix: &str,
    attempt_id: &str,
) -> Result<PathBuf, String> {
    // Validate the attempt id so the joined path cannot escape the temp dir.
    if attempt_id.is_empty()
        || attempt_id.len() > MAX_ATTEMPT_ID_LEN
        || !attempt_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return Err("Invalid login attempt.".into());
    }
    let dir = std::env::temp_dir().join(format!("{prefix}{attempt_id}"));
    std::fs::create_dir_all(&dir)
        .map_err(|error| format!("Unable to prepare the private login profile: {error}"))?;
    if let Err(error) = crate::fs_util::restrict_private_permissions(&dir) {
        let _ = std::fs::remove_dir_all(&dir);
        return Err(error);
    }
    Ok(dir)
}

/// Best-effort removal of stale profiles: the directories in the system temp dir whose name
/// starts with `prefix`. Files and symlinks are never removed, and neither is anything whose
/// type cannot be read.
pub(crate) fn sweep_stale_profiles(prefix: &str) {
    sweep_stale_profiles_in(&std::env::temp_dir(), prefix);
}

fn sweep_stale_profiles_in(dir: &Path, prefix: &str) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        // Guard against path traversal tricks in exotic temp-dir listings.
        if !name.starts_with(prefix)
            || name.contains('/')
            || name.contains('\\')
            || name.contains("..")
        {
            continue;
        }
        if is_removable_profile(entry.file_type()) {
            let _ = std::fs::remove_dir_all(dir.join(name));
        }
    }
}

/// Only a directory (a profile), never a file or symlink. `DirEntry::file_type` does not follow
/// symlinks, and an entry whose type cannot be read is left alone.
fn is_removable_profile(file_type: std::io::Result<std::fs::FileType>) -> bool {
    file_type.is_ok_and(|kind| kind.is_dir())
}

/// Sweeps every kind of login profile. Run once at startup, before any login window opens.
pub(crate) fn sweep_all_stale_profiles() {
    sweep_stale_profiles(crate::grok_login::GROK_PROFILE_PREFIX);
    sweep_stale_profiles(crate::opencode_login::OPENCODE_PROFILE_PREFIX);
    sweep_stale_profiles(crate::oauth::PROVIDER_LOGIN_PROFILE_PREFIX);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A prefix no real profile uses, so tests never touch (or race with) real profiles.
    fn unique_prefix() -> String {
        format!("ai-usage-test-{}-", uuid::Uuid::new_v4())
    }

    #[test]
    fn create_rejects_unsafe_attempt_ids() {
        let prefix = unique_prefix();
        assert!(create_private_profile_dir(&prefix, "").is_err());
        assert!(create_private_profile_dir(&prefix, "../escape").is_err());
        assert!(create_private_profile_dir(&prefix, "a/b").is_err());
        assert!(create_private_profile_dir(&prefix, "a\\b").is_err());
        assert!(create_private_profile_dir(&prefix, &"a".repeat(MAX_ATTEMPT_ID_LEN + 1)).is_err());
        // Nothing was created for any of them.
        let leftovers = std::fs::read_dir(std::env::temp_dir())
            .unwrap()
            .flatten()
            .filter(|entry| entry.file_name().to_string_lossy().starts_with(&prefix))
            .count();
        assert_eq!(leftovers, 0);
    }

    #[test]
    fn create_makes_a_private_directory_with_the_prefix() {
        let prefix = unique_prefix();
        let dir = create_private_profile_dir(&prefix, "ok-attempt-123").unwrap();
        assert_eq!(
            dir,
            std::env::temp_dir().join(format!("{prefix}ok-attempt-123"))
        );
        assert!(dir.is_dir());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&dir).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o700);
        }
        // Creating it again for the same attempt is fine.
        assert!(create_private_profile_dir(&prefix, "ok-attempt-123").is_ok());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn create_accepts_the_longest_attempt_id() {
        let prefix = unique_prefix();
        let dir = create_private_profile_dir(&prefix, &"a".repeat(MAX_ATTEMPT_ID_LEN)).unwrap();
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn sweep_removes_only_matching_directories() {
        let root = std::env::temp_dir().join(unique_prefix());
        std::fs::create_dir_all(&root).unwrap();
        let prefix = "ai-usage-grok-";
        let stale = root.join(format!("{prefix}one"));
        std::fs::create_dir_all(stale.join("nested")).unwrap();
        std::fs::write(stale.join("nested").join("cookies"), b"x").unwrap();
        let other_prefix = root.join("ai-usage-opencode-two");
        std::fs::create_dir_all(&other_prefix).unwrap();
        let plain_file = root.join(format!("{prefix}file"));
        std::fs::write(&plain_file, b"x").unwrap();

        sweep_stale_profiles_in(&root, prefix);

        assert!(!stale.exists(), "matching profile directory is removed");
        assert!(other_prefix.is_dir(), "other prefixes are left alone");
        assert!(plain_file.is_file(), "files are never removed");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn sweep_never_follows_or_removes_symlinks() {
        let root = std::env::temp_dir().join(unique_prefix());
        let outside = root.join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("keep"), b"x").unwrap();
        let link = root.join("ai-usage-grok-link");
        std::os::unix::fs::symlink(&outside, &link).unwrap();

        sweep_stale_profiles_in(&root, "ai-usage-grok-");

        assert!(outside.join("keep").is_file());
        assert!(link.symlink_metadata().is_ok(), "the symlink itself stays");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn sweep_leaves_entries_whose_type_cannot_be_read() {
        let unreadable = Err(std::io::Error::other("no metadata"));
        assert!(!is_removable_profile(unreadable));
        let dir_type = std::fs::metadata(std::env::temp_dir()).unwrap().file_type();
        assert!(is_removable_profile(Ok(dir_type)));
    }

    #[test]
    fn sweep_of_a_missing_directory_does_nothing() {
        sweep_stale_profiles_in(&std::env::temp_dir().join(unique_prefix()), "x");
    }
}

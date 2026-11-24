//! Picks up Sync Devices transfer files as they arrive, so neither device has to open one by hand.
//! AirDrop on a Mac and Quick Share on Windows and Android save what they receive into Downloads;
//! while the receiving device shows its code, the page polls [`IncomingWatch::next_ready`]
//! through `commands::pairing`.
//!
//! Only files that appear after the watch begins count: whatever was already there (a file from
//! an earlier attempt) is noted at the start and left alone. A file is read only once its size and modified time held still
//! for one poll, so one being written is not taken half-received. Each file is offered once.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    time::SystemTime,
};

/// The transfer files' extension (`commands::pairing::TRANSFER_FILE_EXTENSION`).
const EXTENSION: &str = "aiutpair";

/// A file's size and modified time: a file whose stamp changed is a different (or growing) file.
type Stamp = (u64, Option<SystemTime>);

pub struct IncomingWatch {
    dirs: Vec<PathBuf>,
    /// Files present at the start, or already offered, with the stamp they had then.
    seen: HashMap<PathBuf, Stamp>,
    /// New files with their stamp at the last poll: offered once it is the same at the next.
    settling: HashMap<PathBuf, Stamp>,
}

impl IncomingWatch {
    /// Watches `dirs` (and the folders directly inside them, such as Android's
    /// `Download/Quick Share`), noting every transfer file already there.
    pub fn start(dirs: Vec<PathBuf>) -> Self {
        let seen = candidates(&dirs).into_iter().collect();
        Self {
            dirs,
            seen,
            settling: HashMap::new(),
        }
    }

    /// A transfer file that arrived since the start and has finished arriving, at most once each.
    pub fn next_ready(&mut self) -> Option<PathBuf> {
        let found = candidates(&self.dirs);
        let mut ready = None;
        let mut settling = HashMap::new();
        for (path, stamp) in found {
            if self.seen.get(&path) == Some(&stamp) {
                continue;
            }
            if ready.is_none() && self.settling.get(&path) == Some(&stamp) {
                ready = Some(path);
                continue;
            }
            settling.insert(path, stamp);
        }
        self.settling = settling;
        let path = ready?;
        let stamp = stamp_of(&path)?;
        self.seen.insert(path.clone(), stamp);
        Some(path)
    }
}

fn stamp_of(path: &Path) -> Option<Stamp> {
    let meta = std::fs::metadata(path).ok()?;
    meta.is_file().then(|| (meta.len(), meta.modified().ok()))
}

fn is_transfer_file(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case(EXTENSION))
}

/// The transfer files in `dirs` and the folders directly inside them, with their stamps. A folder
/// that cannot be listed (missing, or no permission) is skipped.
fn candidates(dirs: &[PathBuf]) -> Vec<(PathBuf, Stamp)> {
    let mut out = Vec::new();
    for dir in dirs {
        let Ok(entries) = std::fs::read_dir(dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_dir() {
                let Ok(inner) = std::fs::read_dir(&path) else {
                    continue;
                };
                for file in inner.flatten() {
                    push_file(&mut out, file.path());
                }
            } else {
                push_file(&mut out, path);
            }
        }
    }
    out
}

fn push_file(out: &mut Vec<(PathBuf, Stamp)>, path: PathBuf) {
    if !is_transfer_file(&path) {
        return;
    }
    if let Some(stamp) = stamp_of(&path) {
        out.push((path, stamp));
    }
}

/// The folder AirDrop or Quick Share saves into, where there is one to watch. iPhone has none:
/// AirDrop hands the file to the app itself (`platform::ios_files`). On Android it needs the
/// user's file access (`platform::android_files::downloads_access`).
pub fn watched_dirs(app: &tauri::AppHandle) -> Vec<PathBuf> {
    #[cfg(target_os = "android")]
    {
        let _ = app;
        crate::platform::android_files::downloads_dir()
            .into_iter()
            .collect()
    }
    #[cfg(target_os = "ios")]
    {
        let _ = app;
        Vec::new()
    }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        use tauri::Manager;
        app.path().download_dir().into_iter().collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "aiut-incoming-{name}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_file_already_there_at_the_start_is_never_offered() {
        let dir = temp_dir("old");
        std::fs::write(dir.join("AI Usage Tracker accounts.aiutpair"), b"old").unwrap();
        let mut watch = IncomingWatch::start(vec![dir.clone()]);
        assert_eq!(watch.next_ready(), None);
        assert_eq!(watch.next_ready(), None);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_new_file_is_offered_once_it_holds_still_and_only_once() {
        let dir = temp_dir("new");
        let mut watch = IncomingWatch::start(vec![dir.clone()]);
        let path = dir.join("AI Usage Tracker accounts (1).AIUTPAIR");
        std::fs::write(&path, b"accounts").unwrap();
        // First seen: may still be arriving.
        assert_eq!(watch.next_ready(), None);
        assert_eq!(watch.next_ready(), Some(path));
        assert_eq!(watch.next_ready(), None);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_file_still_growing_waits() {
        let dir = temp_dir("growing");
        let mut watch = IncomingWatch::start(vec![dir.clone()]);
        let path = dir.join("accounts.aiutpair");
        std::fs::write(&path, b"part").unwrap();
        assert_eq!(watch.next_ready(), None);
        std::fs::write(&path, b"part and the rest").unwrap();
        assert_eq!(watch.next_ready(), None);
        assert_eq!(watch.next_ready(), Some(path));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_file_in_a_folder_inside_is_found_and_other_files_are_not() {
        let dir = temp_dir("nested");
        let mut watch = IncomingWatch::start(vec![dir.clone()]);
        std::fs::create_dir_all(dir.join("Quick Share")).unwrap();
        let path = dir
            .join("Quick Share")
            .join("AI Usage Tracker accounts.aiutpair");
        std::fs::write(&path, b"accounts").unwrap();
        std::fs::write(dir.join("photo.jpg"), b"jpg").unwrap();
        std::fs::write(dir.join("aiutpair"), b"no extension").unwrap();
        assert_eq!(watch.next_ready(), None);
        assert_eq!(watch.next_ready(), Some(path));
        assert_eq!(watch.next_ready(), None);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn an_old_file_replaced_by_a_new_one_of_the_same_name_is_offered() {
        let dir = temp_dir("replaced");
        let path = dir.join("AI Usage Tracker accounts.aiutpair");
        std::fs::write(&path, b"old").unwrap();
        let mut watch = IncomingWatch::start(vec![dir.clone()]);
        std::fs::write(&path, b"a newer, longer file").unwrap();
        assert_eq!(watch.next_ready(), None);
        assert_eq!(watch.next_ready(), Some(path));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_missing_folder_finds_nothing() {
        let mut watch = IncomingWatch::start(vec![
            std::env::temp_dir().join("aiut-incoming-does-not-exist")
        ]);
        assert_eq!(watch.next_ready(), None);
    }
}

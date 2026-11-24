//! iPhone and iPad: a Sync Devices transfer file opened in this app from AirDrop, Files or Mail.
//! The app declares the `.aiutpair` type (`Info.ios.plist`) and does not open documents in place,
//! so iOS copies each file into the app's inbox (`tmp/<bundle id>-Inbox`; older systems use
//! `Documents/Inbox`) and, while the app runs, names it (`RunEvent::Opened`, kept by
//! [`note_opened`]). On a cold start nothing names it (tao passes on no launch URLs), so the
//! inboxes are scanned once, at the first look after launch. Only then: the open dialog's copies
//! land in the same inbox while the app runs (`commands::pairing` deletes each once read).
//!
//! A file is read once and then deleted, with every other one noted: the bytes stay in memory for
//! the sync, and a used or stale file would otherwise come back. Nothing here is secret (a request
//! holds no key; a reply opens only for its own sync). Pure Rust, so it also compiles for the
//! host's tests.
#![cfg_attr(not(target_os = "ios"), allow(dead_code))]

use std::path::{Path, PathBuf};

use parking_lot::Mutex;

/// The transfer files' extension (`commands::pairing::TRANSFER_FILE_EXTENSION`).
const EXTENSION: &str = "aiutpair";

/// The transfer files waiting to be opened, oldest first, and whether the inboxes were scanned.
struct Waiting {
    scanned: bool,
    files: Vec<PathBuf>,
}

static WAITING: Mutex<Waiting> = Mutex::new(Waiting {
    scanned: false,
    files: Vec::new(),
});

fn is_transfer_file(path: &Path) -> bool {
    path.extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case(EXTENSION))
}

/// Keeps the transfer files among `urls`, which iOS opened the app with. Returns whether there
/// was one, so the page can be told.
pub fn note_opened(urls: &[url::Url]) -> bool {
    let files: Vec<PathBuf> = urls
        .iter()
        .filter(|url| url.scheme() == "file")
        .filter_map(|url| url.to_file_path().ok())
        .filter(|path| is_transfer_file(path))
        .collect();
    let any = !files.is_empty();
    WAITING.lock().files.extend(files);
    any
}

/// The folders iOS copies opened files into: `tmp/<bundle id>-Inbox`, and `Documents/Inbox`.
fn inboxes() -> Vec<PathBuf> {
    let Some(home) = std::env::var_os("HOME").map(PathBuf::from) else {
        return Vec::new();
    };
    let mut dirs = vec![home.join("Documents").join("Inbox")];
    if let Ok(entries) = std::fs::read_dir(home.join("tmp")) {
        dirs.extend(
            entries
                .filter_map(Result::ok)
                .map(|entry| entry.path())
                .filter(|path| {
                    path.is_dir()
                        && path
                            .file_name()
                            .and_then(|name| name.to_str())
                            .is_some_and(|name| name.ends_with("-Inbox"))
                }),
        );
    }
    dirs
}

/// The transfer files in `dirs`, oldest first.
fn transfer_files_in(dirs: &[PathBuf]) -> Vec<PathBuf> {
    let mut files: Vec<(std::time::SystemTime, PathBuf)> = dirs
        .iter()
        .filter_map(|dir| std::fs::read_dir(dir).ok())
        .flatten()
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| is_transfer_file(path) && path.is_file())
        .map(|path| {
            let modified = std::fs::metadata(&path)
                .and_then(|meta| meta.modified())
                .unwrap_or(std::time::UNIX_EPOCH);
            (modified, path)
        })
        .collect();
    files.sort_by_key(|(modified, _)| *modified);
    files.into_iter().map(|(_, path)| path).collect()
}

impl Waiting {
    /// After a launch, adds what the inboxes hold, as older than anything iOS named since.
    fn scan_once(&mut self, inboxes: impl FnOnce() -> Vec<PathBuf>) {
        if self.scanned {
            return;
        }
        self.scanned = true;
        let mut found = transfer_files_in(&inboxes());
        found.append(&mut self.files);
        self.files = found;
    }

    /// The newest waiting file that is still there.
    fn newest(&self) -> Option<&PathBuf> {
        self.files.iter().rev().find(|path| path.is_file())
    }

    /// Reads the newest waiting file, at most `max_len + 1` bytes (the caller refuses a longer
    /// one), then deletes it and every other one noted. `None` when none is waiting.
    fn take(&mut self, max_len: usize) -> std::io::Result<Option<Vec<u8>>> {
        use std::io::Read;
        let Some(path) = self.newest().cloned() else {
            self.files.clear();
            return Ok(None);
        };
        let read = std::fs::File::open(&path).and_then(|file| {
            let mut bytes = Vec::new();
            file.take(max_len as u64 + 1).read_to_end(&mut bytes)?;
            Ok(bytes)
        });
        // Used up, or unreadable: either way none of them may be offered again.
        for file in self.files.drain(..) {
            let _ = std::fs::remove_file(file);
        }
        read.map(Some)
    }
}

/// Whether a transfer file is waiting to be opened.
pub fn has_tapped() -> bool {
    let mut waiting = WAITING.lock();
    waiting.scan_once(inboxes);
    waiting.newest().is_some()
}

/// Reads the waiting transfer file and deletes it (see [`Waiting::take`]).
pub fn take_tapped(max_len: usize) -> std::io::Result<Option<Vec<u8>>> {
    let mut waiting = WAITING.lock();
    waiting.scan_once(inboxes);
    waiting.take(max_len)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(dir: &Path, name: &str, bytes: &[u8]) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, bytes).unwrap();
        path
    }

    fn fresh() -> Waiting {
        Waiting {
            scanned: false,
            files: Vec::new(),
        }
    }

    #[test]
    fn only_transfer_files_count() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "photo.jpg", b"x");
        let file = write(dir.path(), "AI Usage Tracker reply.AIUTPAIR", b"x");
        let mut waiting = fresh();
        waiting.scan_once(|| vec![dir.path().to_path_buf()]);
        assert_eq!(waiting.newest(), Some(&file));
    }

    #[test]
    fn the_inboxes_are_scanned_once_after_launch() {
        let inbox = tempfile::tempdir().unwrap();
        let mut waiting = fresh();
        waiting.scan_once(|| vec![inbox.path().to_path_buf()]);
        assert_eq!(waiting.newest(), None);
        // A file the open dialog copies there later is not mistaken for one opened from AirDrop.
        write(inbox.path(), "picked.aiutpair", b"picked");
        waiting.scan_once(|| vec![inbox.path().to_path_buf()]);
        assert_eq!(waiting.newest(), None);
    }

    #[test]
    fn a_named_file_comes_before_what_the_inbox_held_and_all_are_deleted() {
        let inbox = tempfile::tempdir().unwrap();
        let elsewhere = tempfile::tempdir().unwrap();
        let old = write(inbox.path(), "old.aiutpair", b"old");
        let named = write(elsewhere.path(), "new.aiutpair", b"new");
        let mut waiting = fresh();
        waiting.files.push(named.clone());
        waiting.scan_once(|| vec![inbox.path().to_path_buf()]);
        assert_eq!(waiting.take(100).unwrap().as_deref(), Some(&b"new"[..]));
        assert!(!old.exists() && !named.exists());
        assert_eq!(waiting.take(100).unwrap(), None);
    }

    #[test]
    fn a_file_named_but_already_gone_falls_back_to_an_older_one() {
        let inbox = tempfile::tempdir().unwrap();
        write(inbox.path(), "request.aiutpair", b"request");
        let mut waiting = fresh();
        waiting.files.push(inbox.path().join("deleted.aiutpair"));
        waiting.scan_once(|| vec![inbox.path().to_path_buf()]);
        assert_eq!(waiting.take(100).unwrap().as_deref(), Some(&b"request"[..]));
    }

    #[test]
    fn reading_stops_one_byte_past_the_limit() {
        let inbox = tempfile::tempdir().unwrap();
        write(inbox.path(), "big.aiutpair", &[0; 50]);
        let mut waiting = fresh();
        waiting.scan_once(|| vec![inbox.path().to_path_buf()]);
        assert_eq!(waiting.take(10).unwrap().unwrap().len(), 11);
    }

    #[test]
    fn only_file_urls_to_transfer_files_are_kept() {
        // Built from a real path, so the file address is valid on every host that runs tests
        // (a Unix-style `file:///private/…` address is no file path on Windows).
        let dir = tempfile::tempdir().unwrap();
        let file_url = |name: &str| url::Url::from_file_path(dir.path().join(name)).unwrap();
        let urls = [
            file_url("a.aiutpair"),
            file_url("a.pdf"),
            "aiusage-signin://done".parse().unwrap(),
        ];
        let before = WAITING.lock().files.len();
        assert!(note_opened(&urls));
        assert_eq!(WAITING.lock().files.len(), before + 1);
        WAITING.lock().files.pop();
        assert!(!note_opened(&urls[1..]));
    }
}

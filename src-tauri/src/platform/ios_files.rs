//! iPhone and iPad: a Sync Devices transfer file opened in this app from AirDrop, Files or Mail.
//! The app declares the `.aiutpair` type (`Info.ios.plist`) and does not open documents in place,
//! so iOS copies each file into the app's own `Documents/Inbox` and, while the app runs, also
//! names it (`RunEvent::Opened`, kept by [`note_opened`]). On a cold start nothing names it (tao
//! passes on no launch URLs), so the inbox is the record either way.
//!
//! A file is read once and then deleted, with any older transfer file still in the inbox: the
//! bytes stay in memory for the sync, and a used or stale file would otherwise come back on every
//! start. Nothing here is secret (a request holds no key; a reply opens only for its own sync).
//! Pure Rust, so it also compiles for the host's tests.
#![cfg_attr(not(target_os = "ios"), allow(dead_code))]

use std::path::{Path, PathBuf};

use parking_lot::Mutex;

/// The transfer files' extension (`commands::pairing::TRANSFER_FILE_EXTENSION`).
const EXTENSION: &str = "aiutpair";

/// Files iOS named while the app ran, newest last.
static OPENED: Mutex<Vec<PathBuf>> = Mutex::new(Vec::new());

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
    OPENED.lock().extend(files);
    any
}

/// The app's `Documents/Inbox`, where iOS copies files opened in it.
fn inbox() -> Option<PathBuf> {
    std::env::var_os("HOME").map(|home| PathBuf::from(home).join("Documents").join("Inbox"))
}

/// The transfer files in `dir`, newest first.
fn transfer_files_in(dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut files: Vec<(std::time::SystemTime, PathBuf)> = entries
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
    files.sort_by_key(|(modified, _)| std::cmp::Reverse(*modified));
    files.into_iter().map(|(_, path)| path).collect()
}

/// The file to open next: the newest one iOS named that is still there, else the newest in the
/// inbox.
fn waiting(opened: &[PathBuf], inbox: Option<&Path>) -> Option<PathBuf> {
    opened
        .iter()
        .rev()
        .find(|path| path.is_file())
        .cloned()
        .or_else(|| inbox.and_then(|dir| transfer_files_in(dir).into_iter().next()))
}

/// Whether a transfer file is waiting to be opened.
pub fn has_tapped() -> bool {
    waiting(&OPENED.lock(), inbox().as_deref()).is_some()
}

/// Reads the waiting transfer file, at most `max_len + 1` bytes (the caller refuses a longer one),
/// then deletes it and every other transfer file iOS left. `None` when none is waiting.
pub fn take_tapped(max_len: usize) -> std::io::Result<Option<Vec<u8>>> {
    take_from(&mut OPENED.lock(), inbox().as_deref(), max_len)
}

fn take_from(
    opened: &mut Vec<PathBuf>,
    inbox: Option<&Path>,
    max_len: usize,
) -> std::io::Result<Option<Vec<u8>>> {
    use std::io::Read;
    let Some(path) = waiting(opened, inbox) else {
        return Ok(None);
    };
    let read = std::fs::File::open(&path).and_then(|file| {
        let mut bytes = Vec::new();
        file.take(max_len as u64 + 1).read_to_end(&mut bytes)?;
        Ok(bytes)
    });
    // Used up, or unreadable: either way it must not be offered again.
    let mut used: Vec<PathBuf> = std::mem::take(opened);
    used.push(path);
    if let Some(dir) = inbox {
        used.extend(transfer_files_in(dir));
    }
    for file in used {
        let _ = std::fs::remove_file(file);
    }
    read.map(Some)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(dir: &Path, name: &str, bytes: &[u8]) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, bytes).unwrap();
        path
    }

    #[test]
    fn only_transfer_files_count() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "photo.jpg", b"x");
        assert_eq!(waiting(&[], Some(dir.path())), None);
        let file = write(dir.path(), "AI Usage Tracker reply.AIUTPAIR", b"x");
        assert_eq!(waiting(&[], Some(dir.path())), Some(file));
    }

    #[test]
    fn a_named_file_comes_before_the_inbox() {
        let inbox = tempfile::tempdir().unwrap();
        let elsewhere = tempfile::tempdir().unwrap();
        write(inbox.path(), "old.aiutpair", b"old");
        let named = write(elsewhere.path(), "new.aiutpair", b"new");
        let mut opened = vec![named];
        let bytes = take_from(&mut opened, Some(inbox.path()), 100).unwrap();
        assert_eq!(bytes.as_deref(), Some(&b"new"[..]));
        // Both are gone, so neither comes back on the next start.
        assert!(opened.is_empty());
        assert_eq!(waiting(&opened, Some(inbox.path())), None);
    }

    #[test]
    fn a_file_named_but_already_gone_falls_back_to_the_inbox() {
        let inbox = tempfile::tempdir().unwrap();
        write(inbox.path(), "request.aiutpair", b"request");
        let mut opened = vec![inbox.path().join("deleted.aiutpair")];
        let bytes = take_from(&mut opened, Some(inbox.path()), 100).unwrap();
        assert_eq!(bytes.as_deref(), Some(&b"request"[..]));
        assert_eq!(
            take_from(&mut opened, Some(inbox.path()), 100).unwrap(),
            None
        );
    }

    #[test]
    fn reading_stops_one_byte_past_the_limit() {
        let inbox = tempfile::tempdir().unwrap();
        write(inbox.path(), "big.aiutpair", &[0; 50]);
        let bytes = take_from(&mut Vec::new(), Some(inbox.path()), 10)
            .unwrap()
            .unwrap();
        assert_eq!(bytes.len(), 11);
    }

    #[test]
    fn only_file_urls_to_transfer_files_are_kept() {
        let before = OPENED.lock().len();
        let urls = [
            "file:///var/mobile/Documents/Inbox/a.aiutpair"
                .parse()
                .unwrap(),
            "file:///var/mobile/Documents/Inbox/a.pdf".parse().unwrap(),
            "aiusage-signin://done".parse().unwrap(),
        ];
        assert!(note_opened(&urls));
        assert_eq!(OPENED.lock().len(), before + 1);
        OPENED.lock().pop();
        assert!(!note_opened(&urls[1..]));
    }
}

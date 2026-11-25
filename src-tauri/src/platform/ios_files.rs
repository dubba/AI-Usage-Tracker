//! iPhone, iPad, and macOS: a Sync Devices transfer file opened in this app from AirDrop, Files,
//! Finder, or Mail (`RunEvent::Opened`, kept by [`note_opened`]), plus continuous scanning of iOS's
//! app inboxes (`Documents/Inbox` and `tmp/<bundle id>-Inbox`) for cold starts or deliveries where
//! `RunEvent::Opened` did not fire.
//!
//! When `RunEvent::Opened` fires, the file is read immediately (with security-scoped resource
//! access on Apple platforms so iOS/macOS cannot revoke the grant before the page polls) and kept
//! in memory up to `MAX_FILE_LEN + 1` bytes. A file is recognized by its `.aiutpair` name (including
//! OS duplicate suffixes like `.aiutpair 2`) or its `AIUTPAIR` header magic. Pure Rust tests also
//! exercise the inbox scanning and queue logic on the host.
#![cfg_attr(not(any(target_os = "ios", target_os = "macos")), allow(dead_code))]

use std::{
    collections::BTreeMap,
    io::Read,
    path::{Path, PathBuf},
    time::SystemTime,
};

use parking_lot::Mutex;

use crate::pairing::{file_transfer::MAX_FILE_LEN, incoming_files::is_transfer_file};

/// Magic header of a Sync Devices transfer file (`pairing::file_transfer::MAGIC`).
const TRANSFER_MAGIC: &[u8; 8] = b"AIUTPAIR";

/// Owner-only file inside the app data directory holding the iOS security-scoped bookmark for the
/// user-chosen Downloads folder (so AirDrop files saved into Files → Downloads are picked up
/// automatically on future transfers without picking them by hand).
#[cfg(any(target_os = "ios", test))]
const DOWNLOADS_BOOKMARK_FILE: &str = "ios-downloads-bookmark.bin";

/// Cap on the saved iOS folder bookmark bytes so a corrupt file is ignored safely.
#[cfg(any(target_os = "ios", test))]
const MAX_BOOKMARK_LEN: usize = 64 * 1024;

#[cfg(any(target_os = "ios", test))]
fn bookmark_path(data_dir: &Path) -> PathBuf {
    data_dir.join(DOWNLOADS_BOOKMARK_FILE)
}

#[cfg(any(target_os = "ios", test))]
fn load_bookmark_bytes(data_dir: &Path) -> Option<Vec<u8>> {
    let path = bookmark_path(data_dir);
    let bytes = read_capped_bytes(&path, MAX_BOOKMARK_LEN).ok()?;
    if bytes.is_empty() || bytes.len() > MAX_BOOKMARK_LEN {
        return None;
    }
    Some(bytes)
}

#[cfg(any(target_os = "ios", test))]
fn save_bookmark_bytes(data_dir: &Path, bytes: &[u8]) -> Result<(), String> {
    if bytes.is_empty() || bytes.len() > MAX_BOOKMARK_LEN {
        return Err("Invalid Downloads folder bookmark size".into());
    }
    crate::platform::fs_util::atomic_write_private(&bookmark_path(data_dir), bytes)
}

/// Deletes any saved iOS Downloads folder bookmark (used on revocation/expiry or Delete All Local Data).
#[cfg(any(target_os = "ios", test))]
pub fn clear_downloads_bookmark(data_dir: &Path) {
    let _ = std::fs::remove_file(bookmark_path(data_dir));
}

type Stamp = (u64, Option<SystemTime>);

struct QueuedFile {
    bytes: Vec<u8>,
    /// When set and `remove_on_take` is true, deleted once taken (inbox copies).
    inbox_path: Option<PathBuf>,
}

/// The transfer files waiting to be opened (oldest first), plus inbox files already consumed so a
/// file left behind on disk is never offered twice.
struct Waiting {
    ready: Vec<QueuedFile>,
    seen_inbox: BTreeMap<PathBuf, Stamp>,
}

static WAITING: Mutex<Waiting> = Mutex::new(Waiting {
    ready: Vec::new(),
    seen_inbox: BTreeMap::new(),
});

fn stamp_of(path: &Path) -> Option<Stamp> {
    let meta = std::fs::metadata(path).ok()?;
    meta.is_file().then(|| (meta.len(), meta.modified().ok()))
}

fn read_capped_bytes(path: &Path, max_len: usize) -> std::io::Result<Vec<u8>> {
    let file = std::fs::File::open(path)?;
    let mut bytes = Vec::new();
    file.take(max_len as u64 + 1).read_to_end(&mut bytes)?;
    Ok(bytes)
}

/// Reads `path` on Apple platforms while holding security-scoped access for `url` if granted.
#[cfg(any(target_os = "ios", target_os = "macos"))]
fn read_opened_url(url: &url::Url, path: &Path, max_len: usize) -> std::io::Result<Vec<u8>> {
    use objc2_foundation::{NSString, NSURL};
    let ns_url = NSURL::URLWithString(&NSString::from_str(url.as_str()));
    let accessed = ns_url
        .as_ref()
        .is_some_and(|u| unsafe { u.startAccessingSecurityScopedResource() });
    let result = read_capped_bytes(path, max_len);
    if accessed {
        if let Some(u) = ns_url.as_ref() {
            unsafe { u.stopAccessingSecurityScopedResource() };
        }
    }
    result
}

#[cfg(not(any(target_os = "ios", target_os = "macos")))]
fn read_opened_url(_url: &url::Url, path: &Path, max_len: usize) -> std::io::Result<Vec<u8>> {
    read_capped_bytes(path, max_len)
}

fn is_in_inboxes(path: &Path, inbox_dirs: &[PathBuf]) -> bool {
    inbox_dirs.iter().any(|dir| path.starts_with(dir))
}

/// Keeps the transfer files among `urls`, which iOS or macOS opened the app with. Reads each file's
/// bytes immediately (with security-scoped access) so the OS cannot revoke access before the page
/// takes it. Returns whether at least one transfer file was queued.
pub fn note_opened(urls: &[url::Url]) -> bool {
    let inbox_dirs = inboxes();
    let mut queued = Vec::new();
    for url in urls {
        if url.scheme() != "file" {
            continue;
        }
        let Ok(path) = url.to_file_path() else {
            continue;
        };
        let name_matches = is_transfer_file(&path);
        let bytes = match read_opened_url(url, &path, MAX_FILE_LEN) {
            Ok(bytes) => bytes,
            Err(_) => {
                if name_matches {
                    crate::pairing::sync_log::note("file: could not read an opened transfer file");
                }
                continue;
            }
        };
        let magic_matches = bytes.starts_with(TRANSFER_MAGIC);
        if !name_matches && !magic_matches {
            continue;
        }
        let in_inbox = is_in_inboxes(&path, &inbox_dirs);
        if in_inbox {
            let _ = std::fs::remove_file(&path);
        }
        queued.push(QueuedFile {
            bytes,
            inbox_path: in_inbox.then_some(path),
        });
    }
    let any = !queued.is_empty();
    if any {
        let mut waiting = WAITING.lock();
        waiting.ready.extend(queued);
        crate::pairing::sync_log::note("file: received a transfer file opened in the app");
    }
    any
}

/// The folders iOS copies opened files into: `tmp/<bundle id>-Inbox`, and `Documents/Inbox`.
/// Empty on macOS (macOS watches `~/Downloads` via `incoming_files`).
fn inboxes() -> Vec<PathBuf> {
    #[cfg(not(target_os = "ios"))]
    {
        Vec::new()
    }
    #[cfg(target_os = "ios")]
    {
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
}

/// The transfer files in `dirs`, oldest first.
fn transfer_files_in(dirs: &[PathBuf]) -> Vec<(PathBuf, Stamp)> {
    let mut files: Vec<(SystemTime, PathBuf, Stamp)> = dirs
        .iter()
        .filter_map(|dir| std::fs::read_dir(dir).ok())
        .flatten()
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| is_transfer_file(path) && path.is_file())
        .filter_map(|path| {
            let stamp = stamp_of(&path)?;
            let modified = stamp.1.unwrap_or(std::time::UNIX_EPOCH);
            Some((modified, path, stamp))
        })
        .collect();
    files.sort_by_key(|(modified, _, _)| *modified);
    files
        .into_iter()
        .map(|(_, path, stamp)| (path, stamp))
        .collect()
}

impl Waiting {
    fn has_any(&self, inbox_dirs: &[PathBuf]) -> bool {
        if !self.ready.is_empty() {
            return true;
        }
        transfer_files_in(inbox_dirs)
            .into_iter()
            .any(|(path, stamp)| self.seen_inbox.get(&path) != Some(&stamp))
    }

    /// Returns the newest queued file (preferring one named by `RunEvent::Opened` over an inbox
    /// scan), capped at `max_len + 1` bytes, and clears older queued/inbox files so stale copies
    /// are not offered again.
    fn take(&mut self, max_len: usize, inbox_dirs: &[PathBuf]) -> std::io::Result<Option<Vec<u8>>> {
        if let Some(newest) = self.ready.pop() {
            self.ready.clear();
            let _ = newest.inbox_path;
            // Also clear any unseen inbox files that may duplicate the opened URL.
            for (path, stamp) in transfer_files_in(inbox_dirs) {
                self.seen_inbox.insert(path.clone(), stamp);
                let _ = std::fs::remove_file(path);
            }
            let mut bytes = newest.bytes;
            bytes.truncate(max_len + 1);
            return Ok(Some(bytes));
        }

        let unseen: Vec<(PathBuf, Stamp)> = transfer_files_in(inbox_dirs)
            .into_iter()
            .filter(|(path, stamp)| self.seen_inbox.get(path) != Some(stamp))
            .collect();
        let Some((newest_path, _)) = unseen.last().cloned() else {
            return Ok(None);
        };
        let read = read_capped_bytes(&newest_path, max_len);
        for (path, stamp) in unseen {
            self.seen_inbox.insert(path.clone(), stamp);
            let _ = std::fs::remove_file(path);
        }
        read.map(Some)
    }
}

/// Whether a transfer file is waiting to be opened.
pub fn has_tapped() -> bool {
    let waiting = WAITING.lock();
    waiting.has_any(&inboxes())
}

/// Reads the waiting transfer file and clears it (see [`Waiting::take`]).
pub fn take_tapped(max_len: usize) -> std::io::Result<Option<Vec<u8>>> {
    let mut waiting = WAITING.lock();
    waiting.take(max_len, &inboxes())
}

#[cfg(target_os = "ios")]
mod ios_downloads {
    use super::{clear_downloads_bookmark, load_bookmark_bytes, save_bookmark_bytes};
    use objc2::{
        define_class, msg_send,
        rc::{Allocated, Retained},
        runtime::{AnyClass, AnyObject, Bool, ProtocolObject},
        MainThreadMarker, MainThreadOnly,
    };
    use objc2_foundation::{
        NSArray, NSData, NSObject, NSObjectProtocol, NSString, NSURLBookmarkCreationOptions,
        NSURLBookmarkResolutionOptions, NSURL,
    };
    use objc2_ui_kit::{
        UIDocumentPickerDelegate, UIDocumentPickerViewController, UIModalPresentationStyle,
        UIViewController,
    };
    use std::{
        cell::RefCell,
        ffi::{c_char, c_int, c_void},
        path::{Path, PathBuf},
    };

    extern "C" {
        fn dlopen(path: *const c_char, mode: c_int) -> *mut c_void;
    }
    const RTLD_LAZY: c_int = 1;

    /// Active security-scoped access to the user-selected iOS Downloads folder.
    /// Calls `stopAccessingSecurityScopedResource` on drop so kernel grants never leak.
    pub struct DownloadsScope {
        url: Retained<NSURL>,
        path: PathBuf,
    }

    // SAFETY: `NSURL` is thread-safe for `stopAccessingSecurityScopedResource` and `path` is owned.
    unsafe impl Send for DownloadsScope {}

    impl DownloadsScope {
        pub fn path(&self) -> &Path {
            &self.path
        }
    }

    impl Drop for DownloadsScope {
        fn drop(&mut self) {
            unsafe {
                self.url.stopAccessingSecurityScopedResource();
            }
        }
    }

    /// Resolves the saved Downloads folder bookmark, starts security-scoped access, verifies the
    /// directory is still readable (catching post-reboot OS revocations), refreshes a stale
    /// bookmark if needed, and returns a drop-guarded scope.
    pub fn open_downloads_dir(data_dir: &Path) -> Option<DownloadsScope> {
        let bytes = load_bookmark_bytes(data_dir)?;
        let ns_data = NSData::with_bytes(&bytes);
        let mut is_stale = Bool::NO;
        let url = unsafe {
            NSURL::URLByResolvingBookmarkData_options_relativeToURL_bookmarkDataIsStale_error(
                &ns_data,
                NSURLBookmarkResolutionOptions::empty(),
                None,
                &mut is_stale,
            )
        };
        let url = match url {
            Ok(url) => url,
            Err(_) => {
                clear_downloads_bookmark(data_dir);
                crate::pairing::sync_log::note(
                    "file: saved Downloads folder access expired; will ask again",
                );
                return None;
            }
        };
        if !unsafe { url.startAccessingSecurityScopedResource() } {
            clear_downloads_bookmark(data_dir);
            crate::pairing::sync_log::note(
                "file: saved Downloads folder access was revoked; will ask again",
            );
            return None;
        }
        let Some(ns_path) = url.path() else {
            unsafe { url.stopAccessingSecurityScopedResource() };
            clear_downloads_bookmark(data_dir);
            return None;
        };
        let scope = DownloadsScope {
            url,
            path: PathBuf::from(ns_path.to_string()),
        };
        if std::fs::read_dir(&scope.path).is_err() {
            drop(scope);
            clear_downloads_bookmark(data_dir);
            crate::pairing::sync_log::note(
                "file: saved Downloads folder could not be read; will ask again",
            );
            return None;
        }
        if is_stale.as_bool() {
            if let Ok(fresh) = scope
                .url
                .bookmarkDataWithOptions_includingResourceValuesForKeys_relativeToURL_error(
                    NSURLBookmarkCreationOptions::MinimalBookmark,
                    None,
                    None,
                )
            {
                let _ = save_bookmark_bytes(data_dir, &fresh.to_vec());
            }
        }
        Some(scope)
    }

    struct ActivePicker {
        _delegate: Retained<FolderPickerDelegate>,
        data_dir: PathBuf,
    }

    thread_local! {
        /// Retains the active folder picker's weak delegate and destination data dir on the main thread.
        static ACTIVE_PICKER: RefCell<Option<ActivePicker>> = const { RefCell::new(None) };
    }

    define_class!(
        #[unsafe(super(NSObject))]
        #[thread_kind = MainThreadOnly]
        #[name = "AIUsageTrackerDownloadsPickerDelegate"]
        struct FolderPickerDelegate;

        unsafe impl NSObjectProtocol for FolderPickerDelegate {}

        unsafe impl UIDocumentPickerDelegate for FolderPickerDelegate {
            #[unsafe(method(documentPicker:didPickDocumentsAtURLs:))]
            fn did_pick_documents(
                &self,
                _controller: &UIDocumentPickerViewController,
                urls: &NSArray<NSURL>,
            ) {
                let active = ACTIVE_PICKER.with(|slot| slot.borrow_mut().take());
                let Some(active) = active else {
                    return;
                };
                let Some(url) = urls.firstObject() else {
                    return;
                };
                if !unsafe { url.startAccessingSecurityScopedResource() } {
                    crate::pairing::sync_log::note(
                        "file: could not access the selected Downloads folder",
                    );
                    return;
                }
                let Some(ns_path) = url.path() else {
                    unsafe { url.stopAccessingSecurityScopedResource() };
                    return;
                };
                let scope = DownloadsScope {
                    url,
                    path: PathBuf::from(ns_path.to_string()),
                };
                if std::fs::read_dir(&scope.path).is_err() {
                    crate::pairing::sync_log::note(
                        "file: selected Downloads folder could not be read",
                    );
                    return;
                }
                match scope
                    .url
                    .bookmarkDataWithOptions_includingResourceValuesForKeys_relativeToURL_error(
                        NSURLBookmarkCreationOptions::MinimalBookmark,
                        None,
                        None,
                    ) {
                    Ok(bookmark) => {
                        if save_bookmark_bytes(&active.data_dir, &bookmark.to_vec()).is_ok() {
                            crate::pairing::sync_log::note(
                                "file: allowed Downloads folder access for AirDrop",
                            );
                        } else {
                            crate::pairing::sync_log::note(
                                "file: could not save Downloads folder access",
                            );
                        }
                    }
                    Err(_) => {
                        crate::pairing::sync_log::note(
                            "file: could not create bookmark for Downloads folder",
                        );
                    }
                }
            }

            #[unsafe(method(documentPickerWasCancelled:))]
            fn was_cancelled(&self, _controller: &UIDocumentPickerViewController) {
                ACTIVE_PICKER.with(|slot| {
                    *slot.borrow_mut() = None;
                });
                crate::pairing::sync_log::note("file: Downloads folder picker was cancelled");
            }
        }
    );

    impl FolderPickerDelegate {
        fn new(mtm: MainThreadMarker) -> Retained<Self> {
            let this: Allocated<Self> = mtm.alloc();
            unsafe { msg_send![super(this.set_ivars(())), init] }
        }
    }

    fn folder_uttype() -> Option<Retained<AnyObject>> {
        // Ensure UniformTypeIdentifiers is loaded, then resolve `UTType.folder` (`public.folder`).
        unsafe {
            let _ = dlopen(
                c"/System/Library/Frameworks/UniformTypeIdentifiers.framework/UniformTypeIdentifiers"
                    .as_ptr(),
                RTLD_LAZY,
            );
        }
        let cls = AnyClass::get(c"UTType")?;
        let id = NSString::from_str("public.folder");
        unsafe { msg_send![cls, typeWithIdentifier: &*id] }
    }

    fn show_folder_picker(view_controller: *mut c_void, data_dir: PathBuf) -> Result<(), String> {
        let mtm = MainThreadMarker::new().ok_or("not on the main thread")?;
        let mut top: Retained<UIViewController> =
            unsafe { Retained::retain(view_controller.cast::<UIViewController>()) }
                .ok_or("the window has no view controller")?;
        while let Some(presented) = top.presentedViewController() {
            top = presented;
        }
        let folder_type =
            folder_uttype().ok_or("folder picker is unavailable on this iOS version")?;
        let types = NSArray::from_slice(&[&*folder_type]);
        // SAFETY: `initForOpeningContentTypes:` gives direct security-scoped access to the folder.
        let picker: Retained<UIDocumentPickerViewController> = unsafe {
            let alloc = UIDocumentPickerViewController::alloc(mtm);
            msg_send![alloc, initForOpeningContentTypes: &*types]
        };
        picker.setAllowsMultipleSelection(false);
        picker.setModalPresentationStyle(UIModalPresentationStyle::FormSheet);
        let delegate = FolderPickerDelegate::new(mtm);
        let proto: &ProtocolObject<dyn UIDocumentPickerDelegate> =
            ProtocolObject::from_ref(&*delegate);
        picker.setDelegate(Some(proto));
        ACTIVE_PICKER.with(|slot| {
            *slot.borrow_mut() = Some(ActivePicker {
                _delegate: delegate,
                data_dir,
            });
        });
        top.presentViewController_animated_completion(&picker, true, None);
        Ok(())
    }

    /// Presents the iOS folder picker so the user can grant one-time persistent access to their
    /// Downloads folder (whether in iCloud Drive or On My iPhone).
    pub async fn request_downloads_access(
        window: &tauri::WebviewWindow,
        data_dir: PathBuf,
    ) -> Result<(), String> {
        let (sender, receiver) = tokio::sync::oneshot::channel();
        window
            .with_webview(move |webview| {
                let _ = sender.send(show_folder_picker(webview.view_controller(), data_dir));
            })
            .map_err(|_| "Couldn't open the folder picker.".to_string())?;
        receiver
            .await
            .map_err(|_| "Couldn't open the folder picker.".to_string())?
            .map_err(|error| {
                crate::diagnostics::warn(&format!("iOS Downloads folder picker failed: {error}"));
                "Couldn't open the folder picker.".to_string()
            })
    }
}

#[cfg(target_os = "ios")]
pub use ios_downloads::{open_downloads_dir, request_downloads_access};

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
            ready: Vec::new(),
            seen_inbox: BTreeMap::new(),
        }
    }

    #[test]
    fn only_transfer_files_and_airdrop_duplicates_count() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "photo.jpg", b"x");
        let file = write(dir.path(), "AI Usage Tracker accounts.AIUTPAIR", b"x");
        let dup = write(dir.path(), "AI Usage Tracker accounts.aiutpair 2", b"y");
        let found: Vec<PathBuf> = transfer_files_in(&[dir.path().to_path_buf()])
            .into_iter()
            .map(|(p, _)| p)
            .collect();
        assert_eq!(found.len(), 2);
        assert!(found.contains(&file));
        assert!(found.contains(&dup));
    }

    #[test]
    fn inbox_is_scanned_again_when_a_new_file_arrives_later() {
        let inbox = tempfile::tempdir().unwrap();
        let dirs = vec![inbox.path().to_path_buf()];
        let mut waiting = fresh();
        assert!(!waiting.has_any(&dirs));
        // A file delivered later by AirDrop after launch must still be found.
        write(inbox.path(), "AI Usage Tracker accounts.aiutpair 2", b"new");
        assert!(waiting.has_any(&dirs));
        assert_eq!(
            waiting.take(100, &dirs).unwrap().as_deref(),
            Some(&b"new"[..])
        );
        assert!(!waiting.has_any(&dirs));
    }

    #[test]
    fn a_named_file_comes_before_what_the_inbox_held_and_all_are_deleted() {
        let inbox = tempfile::tempdir().unwrap();
        let old = write(inbox.path(), "old.aiutpair", b"old");
        let dirs = vec![inbox.path().to_path_buf()];
        let mut waiting = fresh();
        waiting.ready.push(QueuedFile {
            bytes: b"new".to_vec(),
            inbox_path: None,
        });
        assert_eq!(
            waiting.take(100, &dirs).unwrap().as_deref(),
            Some(&b"new"[..])
        );
        assert!(!old.exists());
        assert_eq!(waiting.take(100, &dirs).unwrap(), None);
    }

    #[test]
    fn reading_stops_one_byte_past_the_limit() {
        let inbox = tempfile::tempdir().unwrap();
        write(inbox.path(), "big.aiutpair", &[0; 50]);
        let dirs = vec![inbox.path().to_path_buf()];
        let mut waiting = fresh();
        assert_eq!(waiting.take(10, &dirs).unwrap().unwrap().len(), 11);
    }

    #[test]
    fn note_opened_accepts_transfer_extension_duplicate_suffix_and_magic() {
        let dir = tempfile::tempdir().unwrap();
        let a = write(dir.path(), "a.aiutpair", b"AIUTPAIRpayload");
        let dup = write(dir.path(), "a.aiutpair 2", b"AIUTPAIRpayload2");
        let no_ext = write(dir.path(), "transfer-no-ext", b"AIUTPAIRmagic");
        let pdf = write(dir.path(), "a.pdf", b"%PDF-1.7");
        let file_url = |p: &Path| url::Url::from_file_path(p).unwrap();

        let _ = WAITING.lock().ready.drain(..);
        assert!(note_opened(&[file_url(&a), file_url(&pdf)]));
        assert_eq!(WAITING.lock().ready.len(), 1);
        let _ = WAITING.lock().ready.drain(..);

        assert!(note_opened(&[file_url(&dup)]));
        assert_eq!(WAITING.lock().ready.len(), 1);
        let _ = WAITING.lock().ready.drain(..);

        assert!(note_opened(&[file_url(&no_ext)]));
        assert_eq!(WAITING.lock().ready.len(), 1);
        let _ = WAITING.lock().ready.drain(..);

        assert!(!note_opened(&[
            file_url(&pdf),
            "aiusage-signin://done".parse().unwrap(),
        ]));
    }

    #[test]
    fn downloads_bookmark_round_trips_caps_size_and_clears() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(load_bookmark_bytes(dir.path()), None);
        assert!(save_bookmark_bytes(dir.path(), &[]).is_err());
        assert!(save_bookmark_bytes(dir.path(), &vec![0u8; MAX_BOOKMARK_LEN + 1]).is_err());

        save_bookmark_bytes(dir.path(), b"bookmark-bytes").unwrap();
        assert_eq!(
            load_bookmark_bytes(dir.path()).as_deref(),
            Some(&b"bookmark-bytes"[..])
        );

        clear_downloads_bookmark(dir.path());
        assert_eq!(load_bookmark_bytes(dir.path()), None);

        // Oversized corrupt file on disk is ignored cleanly.
        std::fs::write(bookmark_path(dir.path()), vec![1u8; MAX_BOOKMARK_LEN + 5]).unwrap();
        assert_eq!(load_bookmark_bytes(dir.path()), None);
    }
}

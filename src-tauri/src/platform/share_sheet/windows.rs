//! Windows' share panel (`DataTransferManager`) for one file, over the app's window. It lists
//! Nearby Sharing, Quick Share (when installed), Mail and other apps that take files.
//!
//! Kept free of Tauri types so it can be type-checked for Windows on its own.

use std::cell::RefCell;
use windows::{
    core::{factory, AgileReference, Interface, Ref, Result, HSTRING},
    ApplicationModel::DataTransfer::{DataRequestedEventArgs, DataTransferManager},
    Foundation::TypedEventHandler,
    Storage::{IStorageItem, StorageFile},
    Win32::{Foundation::HWND, UI::Shell::IDataTransferManagerInterop},
};
use windows_collections::IIterable;

/// The title the panel shows above the apps.
const TITLE: &str = "AI Usage Tracker transfer";

/// Opens the file at `path` for sharing. Waits for Windows, so call it off the window's thread.
/// The agile reference carries the file to the window's thread.
pub fn open_file(path: &str) -> Result<AgileReference<StorageFile>> {
    AgileReference::new(&StorageFile::GetFileFromPathAsync(&HSTRING::from(path))?.join()?)
}

thread_local! {
    /// The window's data-request handler, removed before the next share adds its own (window
    /// thread only).
    static HANDLER: RefCell<Option<(DataTransferManager, i64)>> = const { RefCell::new(None) };
}

/// On the window's thread: shows the share panel for `file` over the window `hwnd`.
pub fn show(hwnd: HWND, file: &AgileReference<StorageFile>) -> Result<()> {
    let interop = factory::<DataTransferManager, IDataTransferManagerInterop>()?;
    // SAFETY: `hwnd` is the app's top-level window, alive while this runs on its thread.
    let manager: DataTransferManager = unsafe { interop.GetForWindow(hwnd)? };
    // The handler must be thread-safe, which the agile reference is.
    let file = file.clone();
    let handler = TypedEventHandler::new(
        move |_: Ref<DataTransferManager>, args: Ref<DataRequestedEventArgs>| {
            if let Some(args) = args.as_ref() {
                let data = args.Request()?.Data()?;
                data.Properties()?.SetTitle(&HSTRING::from(TITLE))?;
                let item: IStorageItem = file.resolve()?.cast()?;
                let items: IIterable<IStorageItem> = vec![Some(item)].into();
                data.SetStorageItemsReadOnly(&items)?;
            }
            Ok(())
        },
    );
    HANDLER.with(|slot| -> Result<()> {
        if let Some((previous, token)) = slot.borrow_mut().take() {
            let _ = previous.RemoveDataRequested(token);
        }
        let token = manager.DataRequested(&handler)?;
        *slot.borrow_mut() = Some((manager.clone(), token));
        Ok(())
    })?;
    // SAFETY: as above; the handler that fills the panel is registered for this window.
    unsafe { interop.ShowShareUIForWindow(hwnd) }
}

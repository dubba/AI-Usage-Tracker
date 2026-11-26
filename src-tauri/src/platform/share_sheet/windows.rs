//! Windows' share panel (`DataTransferManager`) for one file, over the app's window. It lists
//! Nearby Sharing, Quick Share (when installed), Mail and other apps that take files.
//!
//! Kept free of Tauri types so it can be type-checked for Windows on its own.

use std::cell::RefCell;
use windows::{
    core::{factory, AgileReference, Interface, Ref, Result, HSTRING},
    ApplicationModel::DataTransfer::{
        DataRequestedEventArgs, DataTransferManager, TargetApplicationChosenEventArgs,
    },
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
    /// The window's data-request and app-chosen handlers' tokens, removed before the next share
    /// adds its own (window thread only).
    static HANDLER: RefCell<Option<(DataTransferManager, i64, i64)>> = const { RefCell::new(None) };
}

/// On the window's thread: shows the share panel for `file` over the window `hwnd`. `on_chosen`
/// runs when an app is chosen in it (Nearby Sharing, Quick Share…); Windows reports nothing after.
pub fn show(
    hwnd: HWND,
    file: &AgileReference<StorageFile>,
    on_chosen: impl Fn() + Send + 'static,
) -> Result<()> {
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
    let chosen = TypedEventHandler::new(
        move |_: Ref<DataTransferManager>, _: Ref<TargetApplicationChosenEventArgs>| {
            on_chosen();
            Ok(())
        },
    );
    HANDLER.with(|slot| -> Result<()> {
        if let Some((previous, requested, chose)) = slot.borrow_mut().take() {
            let _ = previous.RemoveDataRequested(requested);
            let _ = previous.RemoveTargetApplicationChosen(chose);
        }
        let requested = manager.DataRequested(&handler)?;
        let chose = manager.TargetApplicationChosen(&chosen)?;
        *slot.borrow_mut() = Some((manager.clone(), requested, chose));
        Ok(())
    })?;
    // SAFETY: as above; the handler that fills the panel is registered for this window.
    unsafe { interop.ShowShareUIForWindow(hwnd) }
}

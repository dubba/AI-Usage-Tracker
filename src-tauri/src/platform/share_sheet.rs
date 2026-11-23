//! The system share menu for a transfer file (`commands::pairing`): on macOS, AppKit's
//! `NSSharingServicePicker` (AirDrop, Messages, Mail, …) over the middle of the window. Other
//! platforms save the file instead, until they get their own menu.

/// Whether this platform has a share menu for files.
pub const AVAILABLE: bool = cfg!(target_os = "macos");

/// Shows the share menu for the file at `path`. Returns once the menu is open; what the user
/// picks, or whether they dismiss it, is not reported.
#[cfg(target_os = "macos")]
pub async fn share_file(
    window: &tauri::WebviewWindow,
    path: &std::path::Path,
) -> Result<(), String> {
    const FAILED: &str = "Couldn't open the share menu. Save the file instead.";
    let path = path.to_string_lossy().into_owned();
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let target = window.clone();
    window
        .run_on_main_thread(move || {
            let _ = sender.send(macos::show_picker(&target, &path));
        })
        .map_err(|_| FAILED.to_string())?;
    receiver
        .await
        .map_err(|_| FAILED.to_string())?
        .map_err(|error| {
            crate::diagnostics::warn(&format!("Share menu failed: {error}"));
            FAILED.to_string()
        })
}

#[cfg(not(target_os = "macos"))]
pub async fn share_file(
    _window: &tauri::WebviewWindow,
    _path: &std::path::Path,
) -> Result<(), String> {
    Err("Sharing isn't available on this device. Save the file instead.".into())
}

#[cfg(target_os = "macos")]
mod macos {
    use objc2::{rc::Retained, runtime::AnyObject, AnyThread, MainThreadMarker};
    use objc2_app_kit::{NSSharingServicePicker, NSView};
    use objc2_foundation::{NSArray, NSPoint, NSRect, NSRectEdge, NSSize, NSString, NSURL};
    use std::cell::RefCell;

    thread_local! {
        /// The open picker. AppKit does not promise to keep it alive while it is shown, so it is
        /// held here until the next one replaces it (main thread only).
        static PICKER: RefCell<Option<Retained<NSSharingServicePicker>>> = const { RefCell::new(None) };
    }

    /// Runs on the main thread: the picker for `path`, anchored to the middle of the window.
    pub(super) fn show_picker(window: &tauri::WebviewWindow, path: &str) -> Result<(), String> {
        // AppKit views and menus are only touched on the main thread.
        MainThreadMarker::new().ok_or("not on the main thread")?;
        let view = window.ns_view().map_err(|error| error.to_string())? as *mut NSView;
        // SAFETY: Tauri returns the window's content view, alive while the window is; it is only
        // used here, on the main thread, before this function returns.
        let view: &NSView = unsafe { view.as_ref() }.ok_or("the window has no view")?;

        let url = NSURL::fileURLWithPath(&NSString::from_str(path));
        let item: &AnyObject = &url;
        let items = NSArray::from_slice(&[item]);
        // SAFETY: `items` holds one file URL, the kind of item the picker shares.
        let picker = unsafe {
            NSSharingServicePicker::initWithItems(NSSharingServicePicker::alloc(), &items)
        };

        let bounds = view.bounds();
        let anchor = NSRect::new(
            NSPoint::new(bounds.size.width / 2.0, bounds.size.height / 2.0),
            NSSize::new(1.0, 1.0),
        );
        picker.showRelativeToRect_ofView_preferredEdge(anchor, view, NSRectEdge::MinY);
        PICKER.with(|slot| *slot.borrow_mut() = Some(picker));
        Ok(())
    }
}

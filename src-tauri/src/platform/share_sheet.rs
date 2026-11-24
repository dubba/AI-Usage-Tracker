//! The system share menu for a transfer file (`commands::pairing`): on macOS, AppKit's
//! `NSSharingServicePicker` (AirDrop, Messages, Mail, …) over the middle of the window; on
//! Windows, the share panel (`share_sheet/windows.rs`: Nearby Sharing, Quick Share when installed,
//! Mail); on Android, the share sheet (`android_files.rs`: Quick Share, Messages, Drive); on
//! iPhone and iPad, UIKit's share sheet (AirDrop, Messages, Mail, Save to Files). Other platforms
//! save the file instead, until they get their own menu.

/// Whether this platform has a share menu for files.
pub const AVAILABLE: bool = cfg!(any(
    target_os = "macos",
    windows,
    target_os = "android",
    target_os = "ios"
));

/// Opens Android's share sheet for the file at `path`. Returns once it is asked to open.
#[cfg(target_os = "android")]
pub async fn share_file(
    _window: &tauri::WebviewWindow,
    path: &std::path::Path,
) -> Result<(), String> {
    let path = path.to_string_lossy().into_owned();
    tauri::async_runtime::spawn_blocking(move || crate::platform::android_files::share(&path))
        .await
        .map_err(|_| "Couldn't open the share sheet. Save the file instead.".to_string())?
}

#[cfg(any(target_os = "macos", windows, target_os = "ios"))]
const FAILED: &str = "Couldn't open the share menu. Save the file instead.";

#[cfg(windows)]
#[path = "share_sheet/windows.rs"]
mod windows_share;

/// Shows the share panel for the file at `path`. Returns once the panel is open; what the user
/// picks, or whether they dismiss it, is not reported.
#[cfg(windows)]
pub async fn share_file(
    window: &tauri::WebviewWindow,
    path: &std::path::Path,
) -> Result<(), String> {
    let failed = |error: String| {
        crate::diagnostics::warn(&format!("Share panel failed: {error}"));
        FAILED.to_string()
    };
    let path = path.to_string_lossy().into_owned();
    let file = tauri::async_runtime::spawn_blocking(move || windows_share::open_file(&path))
        .await
        .map_err(|error| failed(error.to_string()))?
        .map_err(|error| failed(error.to_string()))?;
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let target = window.clone();
    window
        .run_on_main_thread(move || {
            let shown = target
                .hwnd()
                .map_err(|error| error.to_string())
                .and_then(|hwnd| {
                    windows_share::show(hwnd, &file).map_err(|error| error.to_string())
                });
            let _ = sender.send(shown);
        })
        .map_err(|error| failed(error.to_string()))?;
    receiver
        .await
        .map_err(|error| failed(error.to_string()))?
        .map_err(failed)
}

/// Shows the share menu for the file at `path`. Returns once the menu is open; what the user
/// picks, or whether they dismiss it, is not reported.
#[cfg(target_os = "macos")]
pub async fn share_file(
    window: &tauri::WebviewWindow,
    path: &std::path::Path,
) -> Result<(), String> {
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

/// Shows the share sheet for the file at `path` over the app. Returns once it is asked to open;
/// what the user picks, or whether they dismiss it, is not reported.
#[cfg(target_os = "ios")]
pub async fn share_file(
    window: &tauri::WebviewWindow,
    path: &std::path::Path,
) -> Result<(), String> {
    let path = path.to_string_lossy().into_owned();
    let (sender, receiver) = tokio::sync::oneshot::channel();
    // `with_webview` runs on the main thread, where UIKit is used.
    window
        .with_webview(move |webview| {
            let _ = sender.send(ios::show_sheet(webview.view_controller(), &path));
        })
        .map_err(|_| FAILED.to_string())?;
    receiver
        .await
        .map_err(|_| FAILED.to_string())?
        .map_err(|error| {
            crate::diagnostics::warn(&format!("Share sheet failed: {error}"));
            FAILED.to_string()
        })
}

#[cfg(not(any(target_os = "macos", windows, target_os = "android", target_os = "ios")))]
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

#[cfg(target_os = "ios")]
mod ios {
    use objc2::{rc::Retained, runtime::AnyObject, MainThreadMarker, MainThreadOnly};
    use objc2_core_foundation::{CGPoint, CGRect, CGSize};
    use objc2_foundation::{NSArray, NSString, NSURL};
    use objc2_ui_kit::{UIActivityViewController, UIViewController};

    /// Runs on the main thread: the share sheet for `path`, presented over whatever the app shows
    /// on top. On an iPad it is a popover from the middle of the screen.
    pub(super) fn show_sheet(
        view_controller: *mut std::ffi::c_void,
        path: &str,
    ) -> Result<(), String> {
        let mtm = MainThreadMarker::new().ok_or("not on the main thread")?;
        // SAFETY: Tauri returns the webview's view controller, alive while the window is; it is
        // retained here and only used on the main thread.
        let mut top: Retained<UIViewController> =
            unsafe { Retained::retain(view_controller.cast::<UIViewController>()) }
                .ok_or("the window has no view controller")?;
        // A controller that already presents one (an open sheet) cannot present another.
        while let Some(presented) = top.presentedViewController() {
            top = presented;
        }

        let url = NSURL::fileURLWithPath(&NSString::from_str(path));
        let item: &AnyObject = &url;
        let items = NSArray::from_slice(&[item]);
        // SAFETY: `items` holds one file URL, an item the share sheet shares as that file.
        let sheet = unsafe {
            UIActivityViewController::initWithActivityItems_applicationActivities(
                UIActivityViewController::alloc(mtm),
                &items,
                None,
            )
        };
        if let (Some(popover), Some(view)) = (sheet.popoverPresentationController(), top.view()) {
            let bounds = view.bounds();
            popover.setSourceView(Some(&view));
            popover.setSourceRect(CGRect::new(
                CGPoint::new(bounds.size.width / 2.0, bounds.size.height / 2.0),
                CGSize::new(1.0, 1.0),
            ));
        }
        top.presentViewController_animated_completion(&sheet, true, None);
        Ok(())
    }
}

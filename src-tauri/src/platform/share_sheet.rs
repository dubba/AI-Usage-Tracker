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

/// The window event that tells the sending screen what became of the share menu (the page's
/// `useFileTransfer` listens; Android's `TransferFiles` sends it as well).
pub const SHARE_OUTCOME_EVENT: &str = "aiut-file-share-outcome";

/// What became of a share menu, as far as the system says. No system says which device was
/// picked, and none reports that the other device opened the file.
#[cfg(any(target_os = "macos", windows, target_os = "ios"))]
#[derive(Clone, Copy, Debug)]
pub(crate) enum ShareOutcome {
    /// An app or service was chosen (Windows: Nearby Sharing, Quick Share…); whether it went
    /// through is not reported.
    #[cfg_attr(not(windows), allow(dead_code))]
    Chosen,
    /// The file went out (AirDrop on a Mac or iPhone: the other device accepted it).
    Sent,
    /// Sending did not finish (the other device declined, or the AirDrop window was closed).
    Failed,
    /// The menu was closed without choosing anything.
    Cancelled,
}

#[cfg(any(target_os = "macos", windows, target_os = "ios"))]
impl ShareOutcome {
    fn name(self) -> &'static str {
        match self {
            Self::Chosen => "chosen",
            Self::Sent => "sent",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }
}

/// Tells the page in `window` what became of the share menu ([`SHARE_OUTCOME_EVENT`]).
#[cfg(any(target_os = "macos", windows, target_os = "ios"))]
fn report_outcome(window: &tauri::WebviewWindow, outcome: ShareOutcome) {
    let name = outcome.name();
    crate::pairing::sync_log::note(&format!("file: share menu {name}"));
    let _ = window.eval(format!(
        "window.dispatchEvent(new CustomEvent('{SHARE_OUTCOME_EVENT}', {{ detail: '{name}' }}))"
    ));
}

#[cfg(windows)]
#[path = "share_sheet/windows.rs"]
mod windows_share;

/// Shows the share panel for the file at `path`. Returns once the panel is open; the app chosen
/// in it is reported to the page ([`ShareOutcome::Chosen`]), whether the file went is not.
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
    let reporter = window.clone();
    window
        .run_on_main_thread(move || {
            let on_chosen = move || report_outcome(&reporter, ShareOutcome::Chosen);
            let shown = target
                .hwnd()
                .map_err(|error| error.to_string())
                .and_then(|hwnd| {
                    windows_share::show(hwnd, &file, on_chosen).map_err(|error| error.to_string())
                });
            let _ = sender.send(shown);
        })
        .map_err(|error| failed(error.to_string()))?;
    receiver
        .await
        .map_err(|error| failed(error.to_string()))?
        .map_err(failed)
}

/// Shows the share menu for the file at `path`. Returns once the menu is open; what became of it
/// (AirDrop sent, failed, or the menu closed) is reported to the page ([`ShareOutcome`]).
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
/// what became of it (sent, failed, or closed) is reported to the page ([`ShareOutcome`]).
#[cfg(target_os = "ios")]
pub async fn share_file(
    window: &tauri::WebviewWindow,
    path: &std::path::Path,
) -> Result<(), String> {
    let path = path.to_string_lossy().into_owned();
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let reporter = window.clone();
    // `with_webview` runs on the main thread, where UIKit is used.
    window
        .with_webview(move |webview| {
            let report = move |outcome| report_outcome(&reporter, outcome);
            let _ = sender.send(ios::show_sheet(webview.view_controller(), &path, report));
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
    use super::ShareOutcome;
    use objc2::{
        define_class, msg_send,
        rc::{Allocated, Retained},
        runtime::{AnyObject, ProtocolObject},
        AnyThread, MainThreadMarker, MainThreadOnly, Message,
    };
    use objc2_app_kit::{
        NSSharingService, NSSharingServiceDelegate, NSSharingServicePicker,
        NSSharingServicePickerDelegate, NSView,
    };
    use objc2_foundation::{
        NSArray, NSError, NSObject, NSObjectProtocol, NSPoint, NSRect, NSRectEdge, NSSize,
        NSString, NSURL,
    };
    use std::cell::RefCell;

    thread_local! {
        /// The open picker and its delegate. AppKit does not promise to keep either alive while
        /// the menu (and AirDrop's window after it) is shown, so they are held here until the
        /// next share replaces them (main thread only).
        static PICKER: RefCell<Option<(Retained<NSSharingServicePicker>, Retained<ShareDelegate>)>> =
            const { RefCell::new(None) };
        /// The window whose page hears what became of the share.
        static WINDOW: RefCell<Option<tauri::WebviewWindow>> = const { RefCell::new(None) };
    }

    fn report(outcome: ShareOutcome) {
        WINDOW.with(|slot| {
            if let Some(window) = slot.borrow().as_ref() {
                super::report_outcome(window, outcome);
            }
        });
    }

    define_class!(
        /// Hears the picker's choice, then the chosen service's result: AirDrop calls
        /// `didShareItems` once the other device accepted and the file arrived.
        #[unsafe(super(NSObject))]
        #[thread_kind = MainThreadOnly]
        #[name = "AIUsageTrackerShareDelegate"]
        struct ShareDelegate;

        unsafe impl NSObjectProtocol for ShareDelegate {}

        unsafe impl NSSharingServicePickerDelegate for ShareDelegate {
            #[unsafe(method_id(sharingServicePicker:delegateForSharingService:))]
            fn delegate_for_service(
                &self,
                _picker: &NSSharingServicePicker,
                _service: &NSSharingService,
            ) -> Option<Retained<ProtocolObject<dyn NSSharingServiceDelegate>>> {
                Some(ProtocolObject::from_retained(self.retain()))
            }

            #[unsafe(method(sharingServicePicker:didChooseSharingService:))]
            fn did_choose_service(
                &self,
                _picker: &NSSharingServicePicker,
                service: Option<&NSSharingService>,
            ) {
                if service.is_none() {
                    report(ShareOutcome::Cancelled);
                }
            }
        }

        unsafe impl NSSharingServiceDelegate for ShareDelegate {
            #[unsafe(method(sharingService:didShareItems:))]
            fn did_share(&self, _service: &NSSharingService, _items: &NSArray) {
                report(ShareOutcome::Sent);
            }

            #[unsafe(method(sharingService:didFailToShareItems:error:))]
            fn did_fail(&self, _service: &NSSharingService, _items: &NSArray, _error: &NSError) {
                report(ShareOutcome::Failed);
            }
        }
    );

    impl ShareDelegate {
        fn new(mtm: MainThreadMarker) -> Retained<Self> {
            let this: Allocated<Self> = mtm.alloc();
            // SAFETY: NSObject's `init` on a freshly allocated instance with no ivars.
            unsafe { msg_send![super(this.set_ivars(())), init] }
        }
    }

    /// Runs on the main thread: the picker for `path`, anchored to the middle of the window.
    pub(super) fn show_picker(window: &tauri::WebviewWindow, path: &str) -> Result<(), String> {
        // AppKit views and menus are only touched on the main thread.
        let mtm = MainThreadMarker::new().ok_or("not on the main thread")?;
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
        let delegate = ShareDelegate::new(mtm);
        picker.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
        WINDOW.with(|slot| *slot.borrow_mut() = Some(window.clone()));

        let bounds = view.bounds();
        let anchor = NSRect::new(
            NSPoint::new(bounds.size.width / 2.0, bounds.size.height / 2.0),
            NSSize::new(1.0, 1.0),
        );
        picker.showRelativeToRect_ofView_preferredEdge(anchor, view, NSRectEdge::MinY);
        PICKER.with(|slot| *slot.borrow_mut() = Some((picker, delegate)));
        Ok(())
    }
}

#[cfg(target_os = "ios")]
mod ios {
    use super::ShareOutcome;
    use block2::RcBlock;
    use objc2::{
        rc::Retained,
        runtime::{AnyObject, Bool},
        MainThreadMarker, MainThreadOnly,
    };
    use objc2_core_foundation::{CGPoint, CGRect, CGSize};
    use objc2_foundation::{NSArray, NSError, NSString, NSURL};
    use objc2_ui_kit::{UIActivityType, UIActivityViewController, UIViewController};

    /// Runs on the main thread: the share sheet for `path`, presented over whatever the app shows
    /// on top. On an iPad it is a popover from the middle of the screen. `report` hears what
    /// became of it: AirDrop completes once the other device accepted and the file arrived.
    pub(super) fn show_sheet(
        view_controller: *mut std::ffi::c_void,
        path: &str,
        report: impl Fn(ShareOutcome) + 'static,
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
        let completion = RcBlock::new(
            move |_activity: *mut UIActivityType,
                  completed: Bool,
                  _returned: *mut NSArray,
                  error: *mut NSError| {
                report(if completed.as_bool() {
                    ShareOutcome::Sent
                } else if error.is_null() {
                    ShareOutcome::Cancelled
                } else {
                    ShareOutcome::Failed
                });
            },
        );
        // SAFETY: the block matches the handler's signature; UIKit copies it when set, so it
        // outlives this function.
        unsafe { sheet.setCompletionWithItemsHandler(RcBlock::as_ptr(&completion)) };
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

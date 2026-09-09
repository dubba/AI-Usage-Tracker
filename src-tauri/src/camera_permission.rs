//! OS-level camera permission for QR scanning.
//!
//! WKWebView `getUserMedia` is granted at the WebKit layer, but macOS TCC still
//! auto-denies capture unless the host app has requested camera access with
//! `NSCameraUsageDescription`. Requesting via AVFoundation surfaces the system
//! prompt and records the decision for this app.
//!
//! Failures here are not fatal: the frontend still tries `getUserMedia`, which
//! is what actually opens USB webcams in `tauri dev`. This path exists only to
//! show the system prompt when status is not yet determined.

#[cfg(target_os = "macos")]
mod macos {
    use std::sync::mpsc;
    use std::time::Duration;

    use block2::RcBlock;
    use objc2::runtime::{AnyClass, AnyObject, Bool};
    use objc2::msg_send;

    #[link(name = "AVFoundation", kind = "framework")]
    extern "C" {
        static AVMediaTypeVideo: *const AnyObject;
    }

    const NOT_DETERMINED: i64 = 0;
    const RESTRICTED: i64 = 1;
    const DENIED: i64 = 2;
    const AUTHORIZED: i64 = 3;

    fn denied_message() -> String {
        "Camera permission was denied. Please allow camera access in System Settings > Privacy & Security > Camera.".into()
    }

    fn video_media_type() -> *const AnyObject {
        unsafe {
            // Touching the class loads AVFoundation so the exported constant is valid.
            let _ = AnyClass::get(c"AVCaptureDevice");
            if !AVMediaTypeVideo.is_null() {
                return AVMediaTypeVideo;
            }
            // AVMediaTypeVideo is the four-char code "vide".
            let Some(ns) = AnyClass::get(c"NSString") else {
                return std::ptr::null();
            };
            let media: *const AnyObject = msg_send![ns, stringWithUTF8String: c"vide".as_ptr()];
            if !media.is_null() {
                let _: *const AnyObject = msg_send![media, retain];
            }
            media
        }
    }

    pub fn ensure() -> Result<(), String> {
        unsafe {
            let Some(cls) = AnyClass::get(c"AVCaptureDevice") else {
                // Let WKWebView getUserMedia try; USB cameras still work that way in dev.
                return Ok(());
            };
            let media = video_media_type();
            if media.is_null() {
                return Ok(());
            }

            let status: i64 = msg_send![cls, authorizationStatusForMediaType: media];
            match status {
                AUTHORIZED => Ok(()),
                RESTRICTED => Err(
                    "Camera access is restricted on this Mac (parental controls or device management)."
                        .into(),
                ),
                DENIED => Err(denied_message()),
                NOT_DETERMINED => request_access(cls, media),
                _ => request_access(cls, media),
            }
        }
    }

    fn request_access(cls: &AnyClass, media: *const AnyObject) -> Result<(), String> {
        let (tx, rx) = mpsc::channel();
        let block = RcBlock::new(move |granted: Bool| {
            let _ = tx.send(bool::from(granted));
        });
        unsafe {
            let _: () = msg_send![
                cls,
                requestAccessForMediaType: media,
                completionHandler: &*block
            ];
        }
        match rx.recv_timeout(Duration::from_secs(120)) {
            Ok(true) => Ok(()),
            Ok(false) => Err(denied_message()),
            Err(_) => Err("Camera permission request timed out.".into()),
        }
    }
}

pub fn ensure() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        macos::ensure()
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(())
    }
}

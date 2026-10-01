#[cfg(target_os = "macos")]
pub(crate) fn setup_macos_notification_delegate() {
    use block2::Block;
    use objc2::runtime::{AnyClass, AnyObject};
    use objc2::{define_class, msg_send, sel, ClassType};
    use std::sync::Once;

    static INIT: Once = Once::new();
    INIT.call_once(|| {
        // Legacy NSUserNotificationCenter delegate. Declared with
        // `define_class!` so the runtime verifies the method encoding;
        // messaging goes through the typed `msg_send!` macro instead of a
        // transmuted `objc_msgSend` function pointer.
        define_class!(
            #[unsafe(super(objc2::runtime::NSObject))]
            struct AiUsageNotificationCenterDelegate;

            impl AiUsageNotificationCenterDelegate {
                #[unsafe(method(userNotificationCenter:shouldPresentNotification:))]
                unsafe fn should_present(
                    &self,
                    _center: *mut AnyObject,
                    _notification: *mut AnyObject,
                ) -> bool {
                    true
                }
            }
        );

        // Modern UNUserNotificationCenter delegate. The completion handler is
        // typed as a real block and invoked via `block2::Block::call`
        // instead of calling a raw function pointer from a C struct.
        define_class!(
            #[unsafe(super(objc2::runtime::NSObject))]
            struct AiUsageModernNotificationCenterDelegate;

            impl AiUsageModernNotificationCenterDelegate {
                #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
                unsafe fn will_present(
                    &self,
                    _center: *mut AnyObject,
                    _notification: *mut AnyObject,
                    completion_handler: *mut Block<dyn Fn(u64)>,
                ) {
                    if completion_handler.is_null() {
                        return;
                    }
                    // Banner, List, Alert, Sound, Badge.
                    let options: u64 = (1 << 4) | (1 << 3) | (1 << 2) | (1 << 1) | (1 << 0);
                    (*completion_handler).call((options,));
                }
            }
        );

        // NSUserNotificationCenter.defaultUserNotificationCenter
        let Some(center_class) = AnyClass::get(c"NSUserNotificationCenter") else {
            return;
        };
        let center: *mut AnyObject = unsafe { msg_send![center_class, defaultUserNotificationCenter] };
        if center.is_null() {
            return;
        }

        let delegate_class = AiUsageNotificationCenterDelegate::class();
        let delegate: *mut AnyObject = unsafe { msg_send![delegate_class, new] };
        if !delegate.is_null() {
            unsafe {
                let _: () = msg_send![center, setDelegate: delegate];
            }
        }

        // UNUserNotificationCenter.currentNotificationCenter
        let Some(un_center_class) = AnyClass::get(c"UNUserNotificationCenter") else {
            return;
        };
        let un_center: *mut AnyObject =
            unsafe { msg_send![un_center_class, currentNotificationCenter] };
        if un_center.is_null() {
            return;
        }
        let modern_class = AiUsageModernNotificationCenterDelegate::class();
        let modern_delegate: *mut AnyObject = unsafe { msg_send![modern_class, new] };
        if !modern_delegate.is_null() {
            unsafe {
                let _: () = msg_send![un_center, setDelegate: modern_delegate];
            }
            // Keep the selector referenced so the intent is explicit even
            // though `define_class!` registers the method encoding.
            let _ = sel!(userNotificationCenter:willPresentNotification:withCompletionHandler:);
        }
    });
}

//! The Java VM and current `MainActivity` for the Rust-to-Kotlin JNI helpers
//! (APK install, notifications, Keystore, LAN binding).
//!
//! Neither Tauri, tao nor wry initialize `ndk_context`, so reading it panics.
//! Inside an async command that panic drops the invoke without a reply, which
//! left the Update button stuck on "Downloading…". `MainActivity.onCreate`
//! registers itself here instead, and every lookup returns an error rather
//! than panicking.

use std::sync::OnceLock;
use std::time::Duration;

use jni::objects::{GlobalRef, JClass, JObject};
use jni::{JNIEnv, JavaVM};
use parking_lot::{Condvar, Mutex};

static VM: OnceLock<JavaVM> = OnceLock::new();
static ACTIVITY: Mutex<Option<GlobalRef>> = Mutex::new(None);
static REGISTERED: Condvar = Condvar::new();

/// The Rust runtime can start before the first activity is created, so a
/// lookup made during startup waits briefly for the registration.
const REGISTRATION_WAIT: Duration = Duration::from_secs(10);

#[no_mangle]
pub extern "C" fn Java_com_yajinni_paseousagebridge_MainActivity_registerActivity(
    env: JNIEnv,
    _class: JClass,
    activity: JObject,
) {
    let Ok(activity) = env.new_global_ref(activity) else {
        return;
    };
    if VM.get().is_none() {
        let Ok(vm) = env.get_java_vm() else {
            return;
        };
        let _ = VM.set(vm);
    }
    // A recreated activity replaces the old one; clones held by in-flight
    // calls keep the previous reference alive until they finish.
    *ACTIVITY.lock() = Some(activity);
    REGISTERED.notify_all();
}

/// Runs `f` with a JNI environment attached to the current thread and the
/// current activity. `unavailable` is the error returned when the activity
/// has not registered or the thread cannot attach.
pub fn with_activity<T>(
    unavailable: &str,
    f: impl FnOnce(&mut JNIEnv, &JObject) -> Result<T, String>,
) -> Result<T, String> {
    let activity = {
        let mut guard = ACTIVITY.lock();
        if guard.is_none() {
            let _ = REGISTERED.wait_while_for(&mut guard, |slot| slot.is_none(), REGISTRATION_WAIT);
        }
        guard.clone()
    };
    let (Some(vm), Some(activity)) = (VM.get(), activity) else {
        crate::diagnostics::warn("Android activity is not available for a native call.");
        return Err(unavailable.to_string());
    };
    let mut env = vm
        .attach_current_thread()
        .map_err(|_| unavailable.to_string())?;
    f(&mut env, activity.as_obj())
}

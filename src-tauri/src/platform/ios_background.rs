//! iOS refresh while the app is closed, through `BGAppRefreshTask`.
//!
//! iOS decides when to run it, from how often the app is opened, the battery and
//! the network. Expect a few runs a day at best, never an exact interval, and
//! none at all when Low Power Mode is on or Background App Refresh is off for
//! the app. A run gets about 30 seconds.
//!
//! The Tauri project under `gen/apple` is generated, so nothing here lives in
//! Swift or Objective-C: the registration and the requests go through the
//! Objective-C runtime from Rust. `BackgroundTasks` is loaded with `dlopen`
//! because the generated Xcode project does not link it. The task identifier
//! must also be listed under `BGTaskSchedulerPermittedIdentifiers`, and
//! `UIBackgroundModes` must include `fetch`, both in `Info.ios.plist`.

use crate::{background_refresh, diagnostics};
use block2::RcBlock;
use objc2::{
    class, msg_send,
    rc::{Allocated, Retained},
    runtime::{AnyClass, AnyObject},
};
use objc2_foundation::NSString;
use std::{
    ffi::{c_char, c_int, c_void},
    panic::catch_unwind,
    path::PathBuf,
    ptr,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};

/// Must match `BGTaskSchedulerPermittedIdentifiers` in `Info.ios.plist`.
pub(crate) const TASK_IDENTIFIER: &str = "com.dubba.ai.usage.tracker.refresh";

/// The bundle identifier in `tauri.conf.json`, which names the data folder.
/// `frontend_contract.rs` keeps the two in step.
const BUNDLE_IDENTIFIER: &str = "com.dubba.ai.usage.tracker";

/// iOS ends a refresh task after about 30 seconds; stop a little before that so
/// the run finishes cleanly instead of being cut off.
const RUN_TIMEOUT: Duration = Duration::from_secs(25);

/// iOS ignores a request that asks to start sooner than this, and refreshes at most
/// as often as it likes; asking for less than the Settings interval would only waste a run.
const MIN_DELAY_MINUTES: u64 = 15;

extern "C" {
    fn dlopen(path: *const c_char, mode: c_int) -> *mut c_void;
}
const RTLD_LAZY: c_int = 1;

/// A `BGTask`, handed between threads. Apple documents `setTaskCompletedWithSuccess:`
/// and the expiration handler as callable from any thread.
#[derive(Clone)]
struct TaskHandle(Retained<AnyObject>);

// SAFETY: see above; the object is only used for those two calls.
unsafe impl Send for TaskHandle {}
unsafe impl Sync for TaskHandle {}

/// Loads `BackgroundTasks` and returns the shared scheduler, or `None` when the
/// framework is missing (an iOS version without it).
fn scheduler() -> Option<Retained<AnyObject>> {
    // SAFETY: a plain `dlopen` of a system framework by its path.
    let loaded = unsafe {
        dlopen(
            c"/System/Library/Frameworks/BackgroundTasks.framework/BackgroundTasks".as_ptr(),
            RTLD_LAZY,
        )
    };
    if loaded.is_null() {
        return None;
    }
    let class = AnyClass::get(c"BGTaskScheduler")?;
    // SAFETY: `sharedScheduler` is a class property that returns the singleton.
    unsafe { msg_send![class, sharedScheduler] }
}

/// Registers the launch handler. Call it before the event loop starts: iOS requires
/// every handler to be registered before the app finishes launching.
pub(crate) fn register() {
    let Some(scheduler) = scheduler() else {
        diagnostics::warn("Background refresh is unavailable: BackgroundTasks did not load.");
        return;
    };
    let identifier = NSString::from_str(TASK_IDENTIFIER);
    let handler = RcBlock::new(|task: *mut AnyObject| {
        // SAFETY: the system passes the `BGAppRefreshTask` it is launching.
        if let Some(task) = unsafe { Retained::retain(task) } {
            handle(TaskHandle(task));
        }
    });
    let queue: *const AnyObject = ptr::null();
    // SAFETY: the selector and argument types are those of
    // `registerForTaskWithIdentifier:usingQueue:launchHandler:`; the system copies the block.
    let registered: bool = unsafe {
        msg_send![
            &*scheduler,
            registerForTaskWithIdentifier: &*identifier,
            usingQueue: queue,
            launchHandler: &*handler
        ]
    };
    if !registered {
        diagnostics::warn("Background refresh could not be registered.");
    }
}

/// Asks iOS for a refresh no sooner than `minutes` from now (but at least 15). A new
/// request replaces the one still pending, so calling this on every launch and return
/// to the foreground is fine.
pub(crate) fn schedule_next(minutes: u64) {
    let Some(scheduler) = scheduler() else {
        return;
    };
    let Some(request_class) = AnyClass::get(c"BGAppRefreshTaskRequest") else {
        return;
    };
    let identifier = NSString::from_str(TASK_IDENTIFIER);
    let seconds = (minutes.max(MIN_DELAY_MINUTES) * 60) as f64;
    // SAFETY: the selectors and argument types are those of `BGAppRefreshTaskRequest`
    // and `BGTaskScheduler`; the request is released when `request` goes out of scope.
    let submitted = unsafe {
        let allocated: Allocated<AnyObject> = msg_send![request_class, alloc];
        let request: Retained<AnyObject> = msg_send![allocated, initWithIdentifier: &*identifier];
        let date: Retained<AnyObject> =
            msg_send![class!(NSDate), dateWithTimeIntervalSinceNow: seconds];
        let _: () = msg_send![&*request, setEarliestBeginDate: &*date];
        let error: *mut *mut AnyObject = ptr::null_mut();
        let ok: bool = msg_send![&*scheduler, submitTaskRequest: &*request, error: error];
        ok
    };
    if !submitted {
        // Normal in the Simulator and when Background App Refresh is off.
        diagnostics::info("Background refresh could not be scheduled.");
    }
}

/// Runs when iOS launches the app for a refresh.
fn handle(task: TaskHandle) {
    // Ask for the next run first, so the chain goes on even if this one is cut off.
    schedule_next(MIN_DELAY_MINUTES);

    let finished = Arc::new(AtomicBool::new(false));
    let expiring = task.clone();
    let expiring_finished = finished.clone();
    let on_expiration = RcBlock::new(move || {
        complete(&expiring, &expiring_finished, false);
    });
    // SAFETY: `setExpirationHandler:` takes a `void (^)(void)` block, which it copies.
    unsafe {
        let _: () = msg_send![&*task.0, setExpirationHandler: &*on_expiration];
    }

    std::thread::spawn(move || {
        let succeeded = catch_unwind(run_refresh).unwrap_or_else(|_| {
            diagnostics::warn("Background refresh stopped unexpectedly.");
            false
        });
        complete(&task, &finished, succeeded);
    });
}

/// Tells iOS the task is over, once: either the run ended or the time ran out.
fn complete(task: &TaskHandle, finished: &AtomicBool, success: bool) {
    if finished.swap(true, Ordering::SeqCst) {
        return;
    }
    // SAFETY: `setTaskCompletedWithSuccess:` takes a BOOL.
    unsafe {
        let _: () = msg_send![&*task.0, setTaskCompletedWithSuccess: success];
    }
}

fn run_refresh() -> bool {
    let Some(data_dir) = data_dir() else {
        diagnostics::warn("Background refresh could not find the app data folder.");
        return false;
    };
    background_refresh::refresh_in_background(&data_dir, RUN_TIMEOUT)
}

/// Where Tauri keeps the app data on iOS (`dirs::data_dir()` joined with the bundle
/// identifier), found without a Tauri handle because a run may start before the
/// window exists.
fn data_dir() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;
    Some(
        PathBuf::from(home)
            .join("Library/Application Support")
            .join(BUNDLE_IDENTIFIER),
    )
}

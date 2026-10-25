//! Refreshing accounts while the app is closed (Android and iOS).
//!
//! The operating system starts the app's process on its own schedule: on Android
//! WorkManager runs `BackgroundRefreshWorker.kt` about every 15 minutes, on iOS
//! `platform/ios_background.rs` handles a `BGAppRefreshTask`. Either way the run
//! uses the same `AppState` as the UI (see `backend::background_state`), so
//! tokens are refreshed, usage is normalized and history readings are written by
//! the same Rust code, and the page never sees more than it does today.

use crate::{backend, diagnostics, refresh_loop, state::AppState, usage};
use std::{
    path::Path,
    sync::Arc,
    time::{Duration, SystemTime},
};

/// Refreshes the accounts when a refresh interval has passed since the last one.
/// Returns false only when the run could not start (the saved data would not
/// load); a run that had nothing to do, or ran out of time, still counts as done.
/// `timeout` bounds the whole run, however many accounts there are.
pub(crate) fn refresh_in_background(data_dir: &Path, timeout: Duration) -> bool {
    // `run()` installs this for the UI process; a run that starts without it would
    // panic the first time a provider client is built.
    let _ = rustls::crypto::ring::default_provider().install_default();
    let state = match backend::background_state(data_dir) {
        Ok(state) => state,
        Err(issue) => {
            diagnostics::warn(&format!(
                "Background refresh could not load saved data: {}",
                issue.message
            ));
            return false;
        }
    };
    refresh_state(state, timeout);
    true
}

fn refresh_state(state: Arc<AppState>, timeout: Duration) {
    let interval = Duration::from_secs(state.settings.account_refresh_minutes() * 60);
    let accounts = state.store.list();
    if !refresh_loop::background_refresh_is_due(&accounts, SystemTime::now(), interval) {
        return;
    }
    let ids: Vec<String> = accounts.into_iter().map(|account| account.id).collect();
    if !refresh_loop::credentials_look_readable(&ids, |id| {
        crate::store::load_provider_secret(id).is_ok()
    }) {
        diagnostics::warn("Background refresh skipped: saved sign-ins could not be read.");
        return;
    }
    let refresh = usage::refresh_all_auto(state);
    if !refresh_loop::block_on_with_timeout(timeout, refresh) {
        diagnostics::warn("Background refresh stopped after its time limit.");
    }
}

#[cfg(target_os = "android")]
pub(crate) use android::queue_alert;

/// The Android entry point, called by `BackgroundRefreshWorker.kt` over JNI.
///
/// With no window there is no app handle, so alerts that fire during the run are
/// queued here and returned to the worker, which posts the notifications.
#[cfg(target_os = "android")]
mod android {
    use super::refresh_in_background;
    use crate::diagnostics;
    use jni::{
        objects::{JClass, JObject, JObjectArray, JString},
        JNIEnv,
    };
    use parking_lot::Mutex;
    use std::{
        panic::{catch_unwind, AssertUnwindSafe},
        path::PathBuf,
        time::Duration,
    };

    /// One run never works longer than this, however many accounts there are. The
    /// per-account timeouts normally end it much sooner.
    const RUN_TIMEOUT: Duration = Duration::from_secs(3 * 60);

    /// More alerts than this in one run means something is wrong; the rest are dropped.
    const MAX_QUEUED_ALERTS: usize = 32;

    static QUEUED_ALERTS: Mutex<Vec<(String, String)>> = Mutex::new(Vec::new());

    /// Called from `usage::emit_alerts_for_account` when no window can show the alert.
    pub(crate) fn queue_alert(title: String, body: String) {
        let mut queue = QUEUED_ALERTS.lock();
        if queue.len() < MAX_QUEUED_ALERTS {
            queue.push((title, body));
        }
    }

    fn take_alerts() -> Vec<(String, String)> {
        std::mem::take(&mut *QUEUED_ALERTS.lock())
    }

    fn refresh_once(vault: &JObject, env: &JNIEnv, data_dir: PathBuf) -> Vec<(String, String)> {
        if let Err(error) = crate::platform::android_context::register_vault(env, vault) {
            diagnostics::warn(&format!("Background refresh could not start: {error}"));
            return Vec::new();
        }
        refresh_in_background(&data_dir, RUN_TIMEOUT);
        take_alerts()
    }

    /// `BackgroundRefreshWorker.nativeRefresh(vault, dataDir)`: returns the alerts
    /// as a flat `[title, body, title, body, ...]` array. A run that cannot start
    /// returns an empty array and logs why; the next scheduled run tries again.
    #[no_mangle]
    pub extern "C" fn Java_com_dubba_ai_usage_tracker_BackgroundRefreshWorker_nativeRefresh<
        'local,
    >(
        mut env: JNIEnv<'local>,
        _class: JClass<'local>,
        vault: JObject<'local>,
        data_dir: JString<'local>,
    ) -> JObjectArray<'local> {
        let data_dir = env
            .get_string(&data_dir)
            .map(|path| PathBuf::from(String::from(path)))
            .ok()
            .filter(|path| path.is_absolute());
        let alerts = match data_dir {
            Some(data_dir) => {
                catch_unwind(AssertUnwindSafe(|| refresh_once(&vault, &env, data_dir)))
                    .unwrap_or_else(|_| {
                        diagnostics::warn("Background refresh stopped unexpectedly.");
                        Vec::new()
                    })
            }
            None => Vec::new(),
        };
        to_java_array(&mut env, &alerts)
    }

    fn to_java_array<'local>(
        env: &mut JNIEnv<'local>,
        alerts: &[(String, String)],
    ) -> JObjectArray<'local> {
        let strings: Vec<&str> = alerts
            .iter()
            .flat_map(|(title, body)| [title.as_str(), body.as_str()])
            .collect();
        let array = env
            .find_class("java/lang/String")
            .and_then(|class| env.new_object_array(strings.len() as i32, class, JObject::null()));
        let Ok(array) = array else {
            return JObjectArray::from(JObject::null());
        };
        for (index, text) in strings.into_iter().enumerate() {
            let Ok(text) = env.new_string(text) else {
                break;
            };
            if env
                .set_object_array_element(&array, index as i32, text)
                .is_err()
            {
                break;
            }
        }
        array
    }
}

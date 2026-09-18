use std::path::Path;

use jni::objects::{JObject, JValue};
use jni::JNIEnv;

pub fn ensure_can_install() -> Result<(), String> {
    let result = call("ensureCanInstallUpdates", "()Ljava/lang/String;", &[], true)?;
    if result == "ok" {
        Ok(())
    } else {
        Err(result)
    }
}

pub fn prompt_apk_install(path: &Path) -> Result<(), String> {
    call_path(path, "installDownloadedApk", "(Ljava/lang/String;)V", false).map(|_| ())
}

pub fn verify_apk_signature(path: &Path) -> Result<(), String> {
    let result = call_path(
        path,
        "verifyDownloadedApk",
        "(Ljava/lang/String;)Ljava/lang/String;",
        true,
    )?;
    if result == "ok" {
        Ok(())
    } else {
        Err(result)
    }
}

pub fn show_download_progress(percent: i32, indeterminate: bool) {
    let args = [
        JValue::Int(percent),
        JValue::Bool(u8::from(indeterminate)),
    ];
    let _ = call("showUpdateDownloadProgress", "(IZ)V", &args, false);
}

pub fn show_installing() {
    let _ = call("showUpdateInstalling", "()V", &[], false);
}

pub fn clear_update_notification() {
    let _ = call("clearUpdateNotification", "()V", &[], false);
}

fn call_path(
    path: &Path,
    name: &str,
    sig: &str,
    expect_string: bool,
) -> Result<String, String> {
    let ctx = ndk_context::android_context();
    let vm = unsafe { jni::JavaVM::from_raw(ctx.vm().cast()) }
        .map_err(|error| format!("Unable to start the Android installer: {error}"))?;
    let mut env = vm
        .attach_current_thread()
        .map_err(|error| format!("Unable to start the Android installer: {error}"))?;
    let activity = unsafe { JObject::from_raw(ctx.context() as jni::sys::jobject) };
    let path = env
        .new_string(path.to_string_lossy().as_ref())
        .map_err(|error| format!("Unable to start the Android installer: {error}"))?;
    let path_obj = JObject::from(path);
    finish(
        &mut env,
        env.call_method(&activity, name, sig, &[JValue::Object(&path_obj)]),
        expect_string,
    )
}

fn call(name: &str, sig: &str, args: &[JValue], expect_string: bool) -> Result<String, String> {
    let ctx = ndk_context::android_context();
    let vm = unsafe { jni::JavaVM::from_raw(ctx.vm().cast()) }
        .map_err(|error| format!("Unable to start the Android installer: {error}"))?;
    let mut env = vm
        .attach_current_thread()
        .map_err(|error| format!("Unable to start the Android installer: {error}"))?;
    let activity = unsafe { JObject::from_raw(ctx.context() as jni::sys::jobject) };
    finish(&mut env, env.call_method(&activity, name, sig, args), expect_string)
}

fn finish(
    env: &mut JNIEnv,
    result: jni::errors::Result<jni::objects::JValueOwned<'_>>,
    expect_string: bool,
) -> Result<String, String> {
    match result {
        Ok(value) => {
            if env.exception_check().unwrap_or(false) {
                Err(jni_exception_message(env))
            } else if expect_string {
                let obj = value
                    .l()
                    .map_err(|error| format!("Unable to start the Android installer: {error}"))?;
                env.get_string((&obj).into())
                    .map(|s| s.to_string_lossy().into_owned())
                    .map_err(|error| format!("Unable to start the Android installer: {error}"))
            } else {
                Ok(String::new())
            }
        }
        Err(_) => Err(jni_exception_message(env)),
    }
}

fn jni_exception_message(env: &mut JNIEnv) -> String {
    let fallback = "Unable to start the Android installer.".to_string();
    let Ok(true) = env.exception_check() else {
        return fallback;
    };
    let Ok(throwable) = env.exception_occurred() else {
        let _ = env.exception_clear();
        return fallback;
    };
    let _ = env.exception_clear();
    env.call_method(&throwable, "getMessage", "()Ljava/lang/String;", &[])
        .ok()
        .and_then(|value| value.l().ok())
        .and_then(|message| {
            env.get_string((&message).into())
                .ok()
                .map(|value| value.to_string_lossy().into_owned())
        })
        .filter(|message| !message.is_empty())
        .unwrap_or(fallback)
}

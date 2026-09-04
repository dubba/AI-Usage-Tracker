use std::path::Path;

use jni::objects::{JObject, JValue};
use jni::JNIEnv;

pub fn prompt_apk_install(path: &Path) -> Result<(), String> {
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

    match env.call_method(
        &activity,
        "installDownloadedApk",
        "(Ljava/lang/String;)V",
        &[JValue::Object(&path_obj)],
    ) {
        Ok(_) => {
            if env.exception_check().unwrap_or(false) {
                Err(jni_exception_message(&mut env))
            } else {
                Ok(())
            }
        }
        Err(_) => Err(jni_exception_message(&mut env)),
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

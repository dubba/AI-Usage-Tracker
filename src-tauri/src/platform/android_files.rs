//! Android's side of the Sync Devices transfer files (`commands::pairing`), in `TransferFiles.kt`:
//! the share sheet for the file the app made, reading or writing the `content://` files the
//! system open and save dialogs return, and the file tapped in another app (Quick Share). Failures come back as one fixed sentence each; the Kotlin
//! exception is cleared so the thread stays usable.

use jni::{
    objects::{JByteArray, JObject, JValue},
    JNIEnv,
};

const SHARE_FAILED: &str = "Couldn't open the share sheet. Save the file instead.";
const READ_FAILED: &str = "Couldn't read that file. Choose it again.";
const WRITE_FAILED: &str = "Couldn't save the file. Choose another place and try again.";

/// Clears a pending Java exception; true when there was one.
fn threw(env: &mut JNIEnv) -> bool {
    if env.exception_check().unwrap_or(false) {
        let _ = env.exception_clear();
        return true;
    }
    false
}

/// Opens Android's share sheet for the file at `path` (in the cache folder's `transfer-files/`).
pub fn share(path: &str) -> Result<(), String> {
    crate::platform::android_context::with_activity(SHARE_FAILED, |env, activity| {
        let path = env.new_string(path).map_err(|_| SHARE_FAILED.to_string())?;
        let result = env.call_method(
            activity,
            "shareTransferFile",
            "(Ljava/lang/String;)V",
            &[JValue::Object(&path.into())],
        );
        if threw(env) || result.is_err() {
            return Err(SHARE_FAILED.into());
        }
        Ok(())
    })
}

/// Reads the `content://` file at `uri`: at most `max_len + 1` bytes, so the caller can refuse a
/// larger file without it being read whole.
pub fn read(uri: &str, max_len: usize) -> Result<Vec<u8>, String> {
    let max = i32::try_from(max_len).map_err(|_| READ_FAILED.to_string())?;
    crate::platform::android_context::with_activity(READ_FAILED, |env, activity| {
        let uri = env.new_string(uri).map_err(|_| READ_FAILED.to_string())?;
        let result = env.call_method(
            activity,
            "readTransferFile",
            "(Ljava/lang/String;I)[B",
            &[JValue::Object(&uri.into()), JValue::Int(max)],
        );
        if threw(env) {
            return Err(READ_FAILED.into());
        }
        let object = result
            .and_then(|value| value.l())
            .map_err(|_| READ_FAILED.to_string())?;
        env.convert_byte_array(JByteArray::from(object))
            .map_err(|_| READ_FAILED.to_string())
    })
}

/// Writes `bytes` to the `content://` file at `uri`, which the save dialog created.
pub fn write(uri: &str, bytes: &[u8]) -> Result<(), String> {
    crate::platform::android_context::with_activity(WRITE_FAILED, |env, activity| {
        let uri = env.new_string(uri).map_err(|_| WRITE_FAILED.to_string())?;
        let data = env
            .byte_array_from_slice(bytes)
            .map_err(|_| WRITE_FAILED.to_string())?;
        let result = env.call_method(
            activity,
            "writeTransferFile",
            "(Ljava/lang/String;[B)V",
            &[
                JValue::Object(&uri.into()),
                JValue::Object(&JObject::from(data)),
            ],
        );
        if threw(env) || result.is_err() {
            return Err(WRITE_FAILED.into());
        }
        Ok(())
    })
}

/// Whether a transfer file was tapped in another app and not taken yet. False if the check fails.
pub fn has_tapped() -> bool {
    crate::platform::android_context::with_activity("", |env, activity| {
        let result = env.call_method(activity, "hasTappedTransferFile", "()Z", &[]);
        if threw(env) {
            return Ok(false);
        }
        Ok(result.and_then(|value| value.z()).unwrap_or(false))
    })
    .unwrap_or(false)
}

/// Takes the address of the file tapped in another app, once; `None` when there is none.
pub fn take_tapped() -> Result<Option<String>, String> {
    crate::platform::android_context::with_activity(READ_FAILED, |env, activity| {
        let result = env.call_method(
            activity,
            "takeTappedTransferFile",
            "()Ljava/lang/String;",
            &[],
        );
        if threw(env) {
            return Err(READ_FAILED.into());
        }
        let object = result
            .and_then(|value| value.l())
            .map_err(|_| READ_FAILED.to_string())?;
        let text: String = env
            .get_string(&jni::objects::JString::from(object))
            .map_err(|_| READ_FAILED.to_string())?
            .into();
        // Kotlin returns "" when no file is waiting.
        Ok(Some(text).filter(|uri| !uri.is_empty()))
    })
}

/// A tapped reply that opened, deleted once it is imported.
static OPENED_REPLY: parking_lot::Mutex<Option<String>> = parking_lot::Mutex::new(None);

/// Remembers the tapped reply at `uri` that opened, for [`delete_imported_reply`].
pub fn remember_opened_reply(uri: String) {
    *OPENED_REPLY.lock() = Some(uri);
}

/// Deletes the tapped reply that opened last, now that it is imported. Does nothing when the
/// reply came from the open dialog instead.
pub fn delete_imported_reply() {
    if let Some(uri) = OPENED_REPLY.lock().take() {
        delete(&uri);
    }
}

/// Deletes the used-up tapped file at `uri`. Best effort: the app that saved it usually refuses,
/// and a used file is harmless.
pub fn delete(uri: &str) {
    let _ = crate::platform::android_context::with_activity("", |env, activity| {
        let Ok(uri) = env.new_string(uri) else {
            return Ok(());
        };
        let _ = env.call_method(
            activity,
            "deleteTransferFile",
            "(Ljava/lang/String;)V",
            &[JValue::Object(&uri.into())],
        );
        threw(env);
        Ok(())
    });
}

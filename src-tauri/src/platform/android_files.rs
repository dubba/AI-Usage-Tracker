//! Android's side of the Sync Devices transfer files (`commands::pairing`), in `TransferFiles.kt`:
//! the share sheet for the file the app made, and reading or writing the `content://` files the
//! system open and save dialogs return. Failures come back as one fixed sentence each; the Kotlin
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

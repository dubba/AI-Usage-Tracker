//! Bridge to `CredentialVault.kt`: AES-256-GCM sealing with a non-exportable
//! Android Keystore key. The key never leaves the Keystore, so the sealed
//! files are useless without this app on this device.

use crate::{apk_install::jni_exception_message, credential_file::SecretCipher};
use jni::{
    objects::{JByteArray, JObject, JValue},
    JNIEnv,
};

pub struct AndroidKeystore;

impl SecretCipher for AndroidKeystore {
    fn seal(&self, plaintext: &[u8], context: &[u8]) -> Result<Vec<u8>, String> {
        call("encryptCredential", plaintext, context)
    }

    fn open(&self, sealed: &[u8], context: &[u8]) -> Result<Vec<u8>, String> {
        call("decryptCredential", sealed, context)
    }
}

const FAILURE: &str = "Secure storage is unavailable.";

fn call(method: &str, data: &[u8], context: &[u8]) -> Result<Vec<u8>, String> {
    let ctx = ndk_context::android_context();
    let vm = unsafe { jni::JavaVM::from_raw(ctx.vm().cast()) }.map_err(|_| FAILURE.to_string())?;
    let mut env = vm
        .attach_current_thread()
        .map_err(|_| FAILURE.to_string())?;
    let activity = unsafe { JObject::from_raw(ctx.context() as jni::sys::jobject) };
    invoke(&mut env, &activity, method, data, context)
}

fn invoke(
    env: &mut JNIEnv,
    activity: &JObject,
    method: &str,
    data: &[u8],
    context: &[u8],
) -> Result<Vec<u8>, String> {
    let data = env
        .byte_array_from_slice(data)
        .map_err(|_| FAILURE.to_string())?;
    let context = env
        .byte_array_from_slice(context)
        .map_err(|_| FAILURE.to_string())?;
    let result = env.call_method(
        activity,
        method,
        "([B[B)[B",
        &[
            JValue::Object(&JObject::from(data)),
            JValue::Object(&JObject::from(context)),
        ],
    );
    if env.exception_check().unwrap_or(false) {
        // The Kotlin side throws on any failure; only the message is used, and
        // it never contains credential data.
        return Err(jni_exception_message(env));
    }
    let value = result.map_err(|_| FAILURE.to_string())?;
    let object = value.l().map_err(|_| FAILURE.to_string())?;
    let bytes = JByteArray::from(object);
    env.convert_byte_array(&bytes)
        .map_err(|_| FAILURE.to_string())
}

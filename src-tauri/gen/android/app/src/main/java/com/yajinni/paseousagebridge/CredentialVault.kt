package com.yajinni.paseousagebridge

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Seals credential bytes with an AES-256-GCM key that lives in the Android
 * Keystore and cannot be exported. The Rust backend stores the result on disk,
 * so the app's private folder alone does not reveal any token.
 *
 * The key needs no user authentication: accounts refresh in the background
 * while the phone is locked. A sealed blob is `iv (12 bytes) || ciphertext+tag`.
 * `context` (the credential file name) is authenticated with it, so a sealed
 * file copied over another account's file fails to open.
 *
 * Every failure throws. The Rust caller treats that as "credential unavailable"
 * and never falls back to plaintext.
 */
object CredentialVault {
  private const val KEYSTORE = "AndroidKeyStore"
  private const val KEY_ALIAS = "ai-usage-tracker-credentials-v1"
  private const val TRANSFORMATION = "AES/GCM/NoPadding"
  private const val IV_BYTES = 12
  private const val TAG_BITS = 128

  private val keyLock = Any()

  fun seal(plaintext: ByteArray, context: ByteArray): ByteArray {
    val cipher = Cipher.getInstance(TRANSFORMATION)
    cipher.init(Cipher.ENCRYPT_MODE, key())
    cipher.updateAAD(context)
    val iv = cipher.iv
    check(iv.size == IV_BYTES) { "Unexpected IV length" }
    return iv + cipher.doFinal(plaintext)
  }

  fun open(sealed: ByteArray, context: ByteArray): ByteArray {
    require(sealed.size > IV_BYTES + TAG_BITS / 8) { "Sealed credential is too short" }
    val cipher = Cipher.getInstance(TRANSFORMATION)
    cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(TAG_BITS, sealed, 0, IV_BYTES))
    cipher.updateAAD(context)
    return cipher.doFinal(sealed, IV_BYTES, sealed.size - IV_BYTES)
  }

  private fun key(): SecretKey = synchronized(keyLock) {
    val store = KeyStore.getInstance(KEYSTORE).apply { load(null) }
    (store.getKey(KEY_ALIAS, null) as? SecretKey) ?: createKey()
  }

  private fun createKey(): SecretKey {
    val spec = KeyGenParameterSpec.Builder(
      KEY_ALIAS,
      KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
    )
      .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
      .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
      .setKeySize(256)
      .build()
    return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
      .apply { init(spec) }
      .generateKey()
  }
}

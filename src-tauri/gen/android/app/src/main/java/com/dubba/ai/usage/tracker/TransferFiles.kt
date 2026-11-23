package com.dubba.ai.usage.tracker

import android.app.Activity
import android.content.Intent
import android.net.Uri
import androidx.core.content.FileProvider
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException

/**
 * The Sync Devices transfer files (commands/pairing.rs, platform/android_files.rs): sharing the
 * one the app made through Android's share sheet (Quick Share, Messages, Drive, …), and reading
 * or writing the `content://` files the system open and save dialogs hand back. The files are a
 * request (no key) or an encrypted reply, so nothing here is secret.
 */
internal class TransferFiles(private val activity: Activity) {
  /**
   * Opens the share sheet for the file at `path`, which must be in the cache folder's
   * `transfer-files/` (the only transfer path `res/xml/file_paths.xml` lets the FileProvider serve).
   */
  fun share(path: String) {
    val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.fileprovider", File(path))
    val send = Intent(Intent.ACTION_SEND).apply {
      type = MIME_TYPE
      putExtra(Intent.EXTRA_STREAM, uri)
      addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    }
    activity.runOnUiThread {
      activity.startActivity(Intent.createChooser(send, "Send the transfer file"))
    }
  }

  /**
   * Reads a file the open dialog picked: at most `maxBytes + 1` bytes, so a larger file is
   * recognised (and refused by Rust) without reading all of it. Throws when it cannot be read.
   */
  fun read(uri: String, maxBytes: Int): ByteArray {
    val input = activity.contentResolver.openInputStream(Uri.parse(uri))
      ?: throw IOException("The file could not be opened")
    input.use { stream ->
      val out = ByteArrayOutputStream()
      val buffer = ByteArray(BUFFER_BYTES)
      var total = 0
      while (total <= maxBytes) {
        val read = stream.read(buffer, 0, minOf(buffer.size, maxBytes + 1 - total))
        if (read <= 0) break
        out.write(buffer, 0, read)
        total += read
      }
      return out.toByteArray()
    }
  }

  /** Writes `data` to a file the save dialog created, replacing what it held. Throws on failure. */
  fun write(uri: String, data: ByteArray) {
    val output = activity.contentResolver.openOutputStream(Uri.parse(uri), "wt")
      ?: throw IOException("The file could not be written")
    output.use { it.write(data) }
  }

  companion object {
    /**
     * The files' own type (the same in `AndroidManifest.xml`'s VIEW filter). Quick Share sends it
     * with the file; if the receiving phone keeps it, tapping the file opens this app and no
     * other. Android has no extension registry, so `.aiutpair` alone gives it no type there.
     */
    const val MIME_TYPE = "application/vnd.aiut.pair"
    private const val BUFFER_BYTES = 64 * 1024
  }
}

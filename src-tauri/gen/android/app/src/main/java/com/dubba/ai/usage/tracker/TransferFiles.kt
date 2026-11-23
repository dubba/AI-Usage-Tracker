package com.dubba.ai.usage.tracker

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.provider.DocumentsContract
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
  /** A file tapped in another app (Quick Share's notification) that the app has not opened yet. */
  @Volatile private var tapped: Uri? = null

  /**
   * Keeps the file a VIEW intent points at (`AndroidManifest.xml`'s transfer file filters), for
   * Rust to take with [takeTapped] when Sync Devices is ready for it. Only `content://` and
   * `file://` addresses count: the sign-in link uses its own scheme. Rust checks the file's
   * header, so a generic binary file that isn't a transfer file gets an error, not an import.
   */
  fun keepTapped(intent: Intent?) {
    if (intent?.action != Intent.ACTION_VIEW) return
    val uri = intent.data ?: return
    if (uri.scheme != "content" && uri.scheme != "file") return
    tapped = uri
    // Handled: a later onNewIntent or recreation must not offer the same file again.
    intent.data = null
  }

  fun hasTapped(): Boolean = tapped != null

  /** The tapped file's address, once: a second call returns null until another file is tapped. */
  fun takeTapped(): String? {
    val uri = tapped ?: return null
    tapped = null
    return uri.toString()
  }

  /**
   * Deletes a tapped file that is used up (Rust passes back the address [takeTapped] gave). Best
   * effort: Quick Share saves into Downloads as itself, so most phones refuse an app that only got
   * read access, and the file stays (a request holds no key, and a used reply cannot be opened
   * again).
   */
  fun delete(address: String) {
    val uri = Uri.parse(address)
    try {
      val resolver = activity.contentResolver
      val deleted = when {
        uri.scheme == "file" -> uri.path?.let { File(it).delete() } ?: false
        DocumentsContract.isDocumentUri(activity, uri) -> DocumentsContract.deleteDocument(resolver, uri)
        else -> resolver.delete(uri, null, null) > 0
      }
      if (!deleted) android.util.Log.i(LOG_TAG, "The opened transfer file was not deleted")
    } catch (e: Throwable) {
      android.util.Log.i(LOG_TAG, "Deleting the opened transfer file failed: ${e.javaClass.simpleName}")
    }
  }

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
     * with the file; if the receiving phone keeps it (Samsung), tapping the file opens this app
     * and no other. Android has no extension registry, so `.aiutpair` alone gives it no type
     * there: a Pixel saves it as a generic binary file, which the manifest also offers to open.
     */
    const val MIME_TYPE = "application/vnd.aiut.pair"
    private const val BUFFER_BYTES = 64 * 1024
  }
}

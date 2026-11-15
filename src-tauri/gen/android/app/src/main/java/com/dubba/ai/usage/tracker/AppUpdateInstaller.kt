package com.dubba.ai.usage.tracker

import android.app.Activity
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Looper
import android.provider.Settings
import androidx.core.content.FileProvider
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

/**
 * Checks a downloaded update APK and hands it to Android's installer, including the wait for
 * the "install unknown apps" permission. `MainActivity` forwards Rust's JNI calls
 * (apk_install.rs) here; failures with nobody waiting are shown through [notifications].
 */
internal class AppUpdateInstaller(
  private val activity: Activity,
  private val notifications: UpdateNotifications
) {
  companion object {
    private val installLock = Any()
    @Volatile
    private var installCallback: ((Int, String?) -> Unit)? = null
    private const val UPDATE_PREFS = "app_update"
    private const val PENDING_APK_KEY = "pending_apk"

    /** Called from [ApkInstallReceiver] on the main thread with the session result. */
    fun onInstallSessionStatus(context: Context, status: Int, confirm: Intent?, message: String?) {
      var effectiveStatus = status
      var effectiveMessage = message
      if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
        try {
          if (confirm == null) {
            throw IllegalStateException("Android did not provide an install prompt.")
          }
          confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
          context.startActivity(confirm)
        } catch (error: Exception) {
          android.util.Log.e(LOG_TAG, "Installer prompt failed: ${error.message}")
          effectiveStatus = PackageInstaller.STATUS_FAILURE
          effectiveMessage = error.message
        }
      }
      val callback = synchronized(installLock) {
        installCallback.also { installCallback = null }
      }
      if (callback != null) {
        callback(effectiveStatus, effectiveMessage)
      } else if (
        effectiveStatus != PackageInstaller.STATUS_SUCCESS &&
        effectiveStatus != PackageInstaller.STATUS_PENDING_USER_ACTION &&
        effectiveStatus != PackageInstaller.STATUS_FAILURE_ABORTED
      ) {
        android.util.Log.e(LOG_TAG, "Install failed with no waiter: $effectiveStatus $effectiveMessage")
        notifyInstallFailure?.invoke(installFailureText(effectiveMessage))
      }
    }

    @Volatile
    private var notifyInstallFailure: ((String) -> Unit)? = null

    private fun installFailureText(message: String?): String =
      message?.takeIf { it.isNotBlank() } ?: "Android could not install the update."
  }

  /** Failure reported by Android for an install session (as opposed to a session setup error). */
  private class InstallStatusException(message: String) : IllegalStateException(message)

  /** Called from the activity's onResume. */
  fun activityResumed() {
    notifyInstallFailure = { text -> notifications.showFailure(text) }
    resumePendingInstall()
  }

  /** Called from the activity's onDestroy. */
  fun activityDestroyed() {
    notifyInstallFailure = null
  }

  fun downloadPath(): String {
    val dir = File(activity.cacheDir, "updates")
    if (!dir.exists() && !dir.mkdirs() && !dir.isDirectory) {
      throw IllegalStateException("Unable to save the update.")
    }
    return File(dir, "ai-usage-tracker-update.apk").absolutePath
  }

  fun verifyDownloadedApk(path: String): String {
    val packageManager = activity.packageManager
    val packageName = activity.packageName
    val file = File(path)
    if (!file.exists() || file.length() < 1024L) {
      return "The downloaded update is missing or incomplete."
    }
    val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      PackageManager.GET_SIGNING_CERTIFICATES
    } else {
      @Suppress("DEPRECATION")
      PackageManager.GET_SIGNATURES
    }
    val archive = packageManager.getPackageArchiveInfo(path, flags)
      ?: return "The update package could not be read."
    archive.applicationInfo?.apply {
      sourceDir = path
      publicSourceDir = path
    }
    if (archive.packageName != packageName) {
      return "This update isn't compatible with your app. Download and manually install the latest version:\n\nhttps://github.com/dubba/AI-Usage-Tracker/releases"
    }
    val current = try {
      packageManager.getPackageInfo(packageName, flags)
    } catch (_: PackageManager.NameNotFoundException) {
      return "Unable to verify this app's signing certificate."
    }
    if (!UpdateSigners.match(currentSignerDigests(current), currentSignerDigests(archive))) {
      return "The update is not signed with this app's certificate."
    }
    return "ok"
  }

  // SHA-256 of the certificates that sign this package now. Deliberately not
  // signingCertificateHistory, which also lists certificates rotated away from.
  private fun currentSignerDigests(info: android.content.pm.PackageInfo): Set<String> {
    val digest = java.security.MessageDigest.getInstance("SHA-256")
    val signatures: Array<android.content.pm.Signature> = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      val signingInfo = info.signingInfo ?: return emptySet()
      signingInfo.apkContentsSigners
    } else {
      @Suppress("DEPRECATION")
      info.signatures ?: return emptySet()
    }
    return signatures.map { signature ->
      digest.reset()
      digest.digest(signature.toByteArray()).joinToString("") { byte ->
        "%02x".format(byte)
      }
    }.toSet()
  }

  fun installDownloadedApk(path: String) {
    val file = File(path)
    if (!file.exists() || file.length() < 1024L) {
      throw IllegalArgumentException("The downloaded update is missing or incomplete.")
    }
    val shareable = fileForInstaller(file)
    if (!canInstallPackages()) {
      setPendingInstall(shareable)
      if (!openInstallPermissionSettings()) {
        throw IllegalStateException("Allow AI Usage Tracker to install unknown apps in Android settings, then tap Update again.")
      }
      throw IllegalStateException("Allow AI Usage Tracker to install updates. The installer opens when you come back.")
    }
    setPendingInstall(null)
    openApkInstaller(shareable, waitForPrompt = true)
  }

  private fun canInstallPackages(): Boolean {
    return Build.VERSION.SDK_INT < Build.VERSION_CODES.O || activity.packageManager.canRequestPackageInstalls()
  }

  private fun openInstallPermissionSettings(): Boolean {
    val intent = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES).apply {
      data = Uri.parse("package:${activity.packageName}")
    }
    val ok = AtomicBoolean(false)
    val launch = {
      activity.startActivity(intent)
      ok.set(true)
    }
    if (Looper.myLooper() == Looper.getMainLooper()) {
      return try {
        launch()
        true
      } catch (error: Exception) {
        android.util.Log.e(LOG_TAG, "Unknown-app install settings failed: ${error.message}")
        false
      }
    }
    val latch = CountDownLatch(1)
    activity.runOnUiThread {
      try {
        launch()
      } catch (error: Exception) {
        android.util.Log.e(LOG_TAG, "Unknown-app install settings failed: ${error.message}")
      } finally {
        latch.countDown()
      }
    }
    return latch.await(5, TimeUnit.SECONDS) && ok.get()
  }

  private fun setPendingInstall(file: File?) {
    activity.getSharedPreferences(UPDATE_PREFS, Context.MODE_PRIVATE).edit().apply {
      if (file == null) remove(PENDING_APK_KEY) else putString(PENDING_APK_KEY, file.absolutePath)
    }.apply()
  }

  /**
   * After the user grants "install unknown apps" in system settings, continue the install
   * that was waiting on it. The path is persisted so a process restart does not lose it.
   */
  private fun resumePendingInstall() {
    val prefs = activity.getSharedPreferences(UPDATE_PREFS, Context.MODE_PRIVATE)
    val path = prefs.getString(PENDING_APK_KEY, null) ?: return
    val file = File(path)
    if (!file.exists()) {
      setPendingInstall(null)
      return
    }
    if (!canInstallPackages()) {
      return
    }
    setPendingInstall(null)
    // The session result arrives on the main thread, so wait for it off the main thread.
    Thread {
      try {
        openApkInstaller(file, waitForPrompt = true)
      } catch (error: Exception) {
        android.util.Log.e(LOG_TAG, "Could not open the installer: ${error.message}")
        notifications.showFailure(installFailureText(error.message))
      }
    }.start()
  }

  private fun openApkInstaller(file: File, waitForPrompt: Boolean) {
    // The system installer's own flow shows "Update this app?" and, once the update finishes,
    // "App updated" with Done/Open. That second screen matters here: Android kills this app when
    // its package is replaced and never restarts it, so Open is the user's way back in. A
    // PackageInstaller session only reports the result to the (now dead) app and shows no such screen.
    try {
      openApkViewer(file)
      return
    } catch (error: Exception) {
      android.util.Log.w(LOG_TAG, "System installer could not be opened, using a session: ${error.message}")
    }
    commitApkSession(file, waitForPrompt)
  }

  private fun commitApkSession(file: File, waitForPrompt: Boolean) {
    val installer = activity.packageManager.packageInstaller
    val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
      setSize(file.length())
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_REQUIRED)
      }
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        setAppPackageName(activity.packageName)
      }
    }
    val sessionId = installer.createSession(params)
    val session = installer.openSession(sessionId)
    val latch = CountDownLatch(1)
    val failure = AtomicReference<String?>(null)
    try {
      file.inputStream().use { input ->
        session.openWrite("base.apk", 0, file.length()).use { output ->
          input.copyTo(output)
          session.fsync(output)
        }
      }
      if (waitForPrompt) {
        synchronized(installLock) {
          installCallback = { status, message ->
            if (
              status != PackageInstaller.STATUS_PENDING_USER_ACTION &&
              status != PackageInstaller.STATUS_SUCCESS
            ) {
              failure.set(installFailureText(message))
            }
            latch.countDown()
          }
        }
      }
      val callbackIntent = Intent(activity, ApkInstallReceiver::class.java).apply {
        action = ApkInstallReceiver.ACTION
      }
      val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE
      } else {
        PendingIntent.FLAG_UPDATE_CURRENT
      }
      val pending = PendingIntent.getBroadcast(activity, sessionId, callbackIntent, flags)
      session.commit(pending.intentSender)
    } catch (error: Exception) {
      try {
        session.abandon()
      } catch (_: Exception) {
      }
      throw error
    } finally {
      try {
        session.close()
      } catch (_: Exception) {
      }
    }
    if (!waitForPrompt) {
      return
    }
    if (!latch.await(20, TimeUnit.SECONDS)) {
      synchronized(installLock) {
        installCallback = null
      }
      throw InstallStatusException("Timed out waiting for the Android installer to open.")
    }
    failure.get()?.let { throw InstallStatusException(it) }
  }

  private fun openApkViewer(file: File) {
    val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.fileprovider", file)
    val intent = Intent(Intent.ACTION_VIEW).apply {
      setDataAndType(uri, "application/vnd.android.package-archive")
      addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }
    // FLAG_GRANT_READ_URI_PERMISSION above grants read access to the installer the
    // user actually opens. Granting it to every app that handles APKs would let any
    // of them read the update without being chosen.
    val launch = { activity.startActivity(intent) }
    if (Looper.myLooper() == Looper.getMainLooper()) {
      launch()
      return
    }
    val latch = CountDownLatch(1)
    var launchError: Exception? = null
    activity.runOnUiThread {
      try {
        launch()
      } catch (error: Exception) {
        launchError = error
      } finally {
        latch.countDown()
      }
    }
    if (!latch.await(8, TimeUnit.SECONDS)) {
      throw IllegalStateException("Timed out waiting for the Android installer to open.")
    }
    launchError?.let { throw it }
  }

  /**
   * FileProvider only shares the `updates/` folders under cacheDir and filesDir
   * (see file_paths.xml). Tauri's app_data_dir is Context.dataDir, so copy
   * there into cache/updates when needed.
   */
  private fun fileForInstaller(file: File): File {
    val cacheUpdates = File(activity.cacheDir, "updates")
    val shareableRoots = listOf(cacheUpdates.canonicalFile, File(activity.filesDir, "updates").canonicalFile)
    val alreadyShareable = generateSequence(file.canonicalFile.parentFile) { it.parentFile }
      .any { parent -> parent in shareableRoots }
    if (alreadyShareable) {
      return file
    }
    if (!cacheUpdates.exists() && !cacheUpdates.mkdirs() && !cacheUpdates.isDirectory) {
      throw IllegalStateException("Unable to prepare the update for install.")
    }
    val dest = File(cacheUpdates, file.name)
    if (file.canonicalPath != dest.canonicalPath) {
      file.copyTo(dest, overwrite = true)
    }
    return dest
  }
}

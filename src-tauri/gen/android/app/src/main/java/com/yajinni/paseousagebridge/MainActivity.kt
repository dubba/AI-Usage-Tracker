package com.yajinni.paseousagebridge

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Looper
import android.provider.Settings
import android.os.SystemClock
import android.webkit.CookieManager
import android.webkit.WebView
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.core.app.NotificationCompat
import androidx.core.content.FileProvider
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

class MainActivity : TauriActivity() {
  companion object {
    private const val TAG = "AIUsagePairing"

    init {
      try {
        System.loadLibrary("ai_usage_tracker_lib")
      } catch (e: Throwable) {
        android.util.Log.w(TAG, "Early loadLibrary info: ${e.message}")
      }
    }

    @Volatile
    private var pendingUriMemory: String? = null

    @Volatile
    private var pendingUpdateNoticeMemory: String? = null

    @JvmStatic
    external fun setPendingPairingUri(uri: String)

    @JvmStatic
    external fun setPendingUpdateNotice(version: String)

    /** Hands this activity to Rust for its JNI calls (see android_context.rs). */
    @JvmStatic
    private external fun registerActivity(activity: MainActivity)

    private const val UPDATE_CHANNEL = "updates"
    private const val UPDATE_AVAILABLE_CHANNEL = "update-available"
    private const val UPDATE_NOTIFICATION_ID = 47001
    private const val UPDATE_AVAILABLE_NOTIFICATION_ID = 47002
    private const val NOTIFICATION_PERMISSION_REQUEST = 1002

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
          android.util.Log.e(TAG, "Installer prompt failed: ${error.message}")
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
        android.util.Log.e(TAG, "Install failed with no waiter: $effectiveStatus $effectiveMessage")
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

  private var activeWebView: WebView? = null
  @Volatile private var lastUpdateNotifyAt: Long = 0L
  @Volatile private var pendingUpdateNotice: String? = null
  private var notificationPromptedFor: String? = null
  private var safeTopDp: Int = 0
  private var safeBottomDp: Int = 0
  private var safeImeDp: Int = 0
  private var multicastLock: android.net.wifi.WifiManager.MulticastLock? = null
  private var boundLanNetwork: Boolean = false

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    activeWebView = webView
    webView.settings.javaScriptCanOpenWindowsAutomatically = true
    webView.settings.setSupportMultipleWindows(true)
    CookieManager.getInstance().setAcceptCookie(true)
    CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true)
    val ua = webView.settings.userAgentString.orEmpty()
    if (ua.contains("; wv")) {
      webView.settings.userAgentString = ua.replace("; wv", "")
    }
    applyInsetsToWebView()
  }

  private fun applyInsetsToWebView() {
    val wv = activeWebView ?: return
    wv.post {
      val js = """
        (function() {
          var root = document.documentElement;
          if (root) {
            root.style.setProperty('--android-safe-top', '${safeTopDp}px');
            root.style.setProperty('--android-safe-bottom', '${safeBottomDp}px');
            root.style.setProperty('--android-keyboard-height', '${safeImeDp}px');
            if (${safeImeDp} > 0) {
              root.classList.add('keyboard-active');
            } else {
              root.classList.remove('keyboard-active');
            }
          }
        })();
      """.trimIndent()
      wv.evaluateJavascript(js, null)
    }
  }

  private fun isPairingUri(uri: String): Boolean {
    // Length-bounded allowlist check shared by intake and forwarding. Pairing
    // URIs carry an ephemeral public key, session id and nonce: validate the
    // value before storing or forwarding it, and never log its contents
    // (logcat is readable by other apps on some devices).
    if (uri.length > 2048) return false
    return uri.startsWith("aiusage-pair:") || uri.startsWith("aiusage:")
  }

  private fun handlePairingIntent(intent: Intent?) {
    val uri = intent?.dataString ?: return
    if (!isPairingUri(uri)) return
    android.util.Log.i(TAG, "Received pairing intent (len=${uri.length})")
    pendingUriMemory = uri
    try {
      setPendingPairingUri(uri)
      android.util.Log.i(TAG, "Forwarded pairing URI to Rust")
    } catch (e: Throwable) {
      android.util.Log.w(TAG, "setPendingPairingUri deferred until runtime init: ${e.message}")
    }
  }

  private fun handleUpdateIntent(intent: Intent?) {
    val version = intent?.getStringExtra("open_update_notes") ?: return
    intent.removeExtra("open_update_notes")
    android.util.Log.i(TAG, "Received update notice intent (version=$version)")
    pendingUpdateNoticeMemory = version
    try {
      setPendingUpdateNotice(version)
      android.util.Log.i(TAG, "Forwarded update notice to Rust")
    } catch (e: Throwable) {
      android.util.Log.w(TAG, "setPendingUpdateNotice deferred until runtime init: ${e.message}")
    }
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    handlePairingIntent(intent)
    handleUpdateIntent(intent)
  }

  override fun onResume() {
    super.onResume()
    notifyInstallFailure = { text -> showUpdateFailure(text) }
    resumePendingInstall()
  }

  override fun onDestroy() {
    notifyInstallFailure = null
    super.onDestroy()
  }

  override fun onRequestPermissionsResult(
    requestCode: Int,
    permissions: Array<out String>,
    grantResults: IntArray
  ) {
    super.onRequestPermissionsResult(requestCode, permissions, grantResults)
    if (requestCode == NOTIFICATION_PERMISSION_REQUEST && notificationsAllowed()) {
      pendingUpdateNotice?.let { postUpdateAvailableNotification(it) }
    }
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    try {
      registerActivity(this)
    } catch (e: Throwable) {
      android.util.Log.e(TAG, "registerActivity failed: ${e.message}")
    }
    window.decorView.setBackgroundColor(Color.BLACK)
    window.setBackgroundDrawableResource(android.R.color.black)
    super.onCreate(savedInstanceState)
    window.decorView.setBackgroundColor(Color.BLACK)
    window.setBackgroundDrawableResource(android.R.color.black)
    WindowCompat.getInsetsController(window, window.decorView).apply {
      isAppearanceLightStatusBars = false
      isAppearanceLightNavigationBars = false
    }

    enableEdgeToEdge(
      statusBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
      navigationBarStyle = SystemBarStyle.dark(Color.TRANSPARENT)
    )

    ViewCompat.setOnApplyWindowInsetsListener(window.decorView) { _, windowInsets ->
      val statusInsets = windowInsets.getInsets(
        WindowInsetsCompat.Type.statusBars() or WindowInsetsCompat.Type.displayCutout()
      )
      val navInsets = windowInsets.getInsets(
        WindowInsetsCompat.Type.navigationBars()
      )
      val imeInsets = windowInsets.getInsets(
        WindowInsetsCompat.Type.ime()
      )
      val density = resources.displayMetrics.density
      if (density > 0f) {
        val top = (statusInsets.top / density).toInt()
        val bottom = (navInsets.bottom / density).toInt()
        val ime = (imeInsets.bottom / density).toInt()
        if (top > 0) {
          safeTopDp = top
        }
        safeBottomDp = bottom
        safeImeDp = ime
        applyInsetsToWebView()
      }
      windowInsets
    }

    handlePairingIntent(intent)
    handleUpdateIntent(intent)
    pendingUriMemory?.let { uri ->
      try {
        setPendingPairingUri(uri)
      } catch (e: Throwable) {
        android.util.Log.e(TAG, "Retry setPendingPairingUri failed: ${e.message}")
      }
    }
    pendingUpdateNoticeMemory?.let { ver ->
      try {
        setPendingUpdateNotice(ver)
      } catch (e: Throwable) {
        android.util.Log.e(TAG, "Retry setPendingUpdateNotice failed: ${e.message}")
      }
    }

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val notificationManager = getSystemService(android.app.NotificationManager::class.java)
      val defaultChannel = android.app.NotificationChannel(
        "default",
        "AI Usage Alerts",
        android.app.NotificationManager.IMPORTANCE_HIGH
      ).apply {
        description = "Notifications for quota limits and alerts"
        enableVibration(true)
        setShowBadge(true)
        lockscreenVisibility = android.app.Notification.VISIBILITY_PUBLIC
      }
      notificationManager?.createNotificationChannel(defaultChannel)
      val updateChannel = NotificationChannel(
        UPDATE_CHANNEL,
        "App updates",
        NotificationManager.IMPORTANCE_LOW
      ).apply {
        description = "Download and install progress for app updates"
        enableVibration(false)
        setShowBadge(false)
      }
      notificationManager?.createNotificationChannel(updateChannel)
      val availableChannel = NotificationChannel(
        UPDATE_AVAILABLE_CHANNEL,
        "Update available",
        NotificationManager.IMPORTANCE_HIGH
      ).apply {
        description = "Alerts when a new version is ready to download"
        enableVibration(true)
        setShowBadge(true)
        lockscreenVisibility = Notification.VISIBILITY_PUBLIC
      }
      notificationManager?.createNotificationChannel(availableChannel)
    }

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
        requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), NOTIFICATION_PERMISSION_REQUEST)
      }
    }

    // Pairing (Link Devices) uses mDNS over multicast. On Android, inbound
    // multicast packets are filtered unless the app holds a MulticastLock —
    // without this, code joins time out on the phone.
    try {
      val wifiManager = applicationContext.getSystemService(Context.WIFI_SERVICE)
        as android.net.wifi.WifiManager
      multicastLock = wifiManager.createMulticastLock("aiut-pairing").apply {
        setReferenceCounted(false)
        acquire()
      }
    } catch (e: Throwable) {
      android.util.Log.w(TAG, "Failed to acquire multicast lock: ${e.message}")
    }

    // Invalidate stale WebView cache when APK is updated to a new version
    val prefs = getSharedPreferences("app_version_prefs", Context.MODE_PRIVATE)
    val lastVersionCode = prefs.getLong("last_version_code", -1L)
    val currentVersionCode = try {
      val pInfo = packageManager.getPackageInfo(packageName, 0)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
        pInfo.longVersionCode
      } else {
        @Suppress("DEPRECATION")
        pInfo.versionCode.toLong()
      }
    } catch (_: Exception) {
      -1L
    }

    if (currentVersionCode != lastVersionCode) {
      try {
        WebView(this).clearCache(true)
      } catch (_: Exception) {}
      prefs.edit().putLong("last_version_code", currentVersionCode).apply()
    }
  }

  /**
   * Called from Rust when a Link Devices session starts/stops. While a VPN or
   * DNS-based ad blocker is running, Android routes ALL app traffic through the
   * VPN tunnel — including LAN packets — which silently breaks pairing. Binding
   * the process to the Wi-Fi network for the duration of the pairing session
   * keeps the LAN connection working.
   */
  fun setPairingLanBinding(enabled: Boolean) {
    runOnUiThread {
      try {
        val cm = applicationContext.getSystemService(Context.CONNECTIVITY_SERVICE)
          as android.net.ConnectivityManager
        if (enabled) {
          if (boundLanNetwork) return@runOnUiThread
          val wifi = cm.allNetworks.firstOrNull { network ->
            cm.getNetworkCapabilities(network)
              ?.hasTransport(android.net.NetworkCapabilities.TRANSPORT_WIFI) == true
          }
          boundLanNetwork = if (wifi != null) {
            cm.bindProcessToNetwork(wifi)
          } else {
            false
          }
        } else {
          if (boundLanNetwork) {
            cm.bindProcessToNetwork(null)
            boundLanNetwork = false
          }
        }
      } catch (e: Throwable) {
        android.util.Log.w(TAG, "setPairingLanBinding failed: ${e.message}")
      }
    }
  }

  /** Posts an alert notification whose body stays fully readable when expanded. */
  fun postExpandableNotification(title: String, body: String) {
    try {
      val notification = androidx.core.app.NotificationCompat.Builder(this, "default")
        .setSmallIcon(applicationInfo.icon)
        .setContentTitle(title)
        .setContentText(body)
        .setStyle(androidx.core.app.NotificationCompat.BigTextStyle().bigText(body))
        .setPriority(androidx.core.app.NotificationCompat.PRIORITY_HIGH)
        .setAutoCancel(true)
        .setContentIntent(appLaunchPendingIntent())
        .build()
      val manager = getSystemService(Context.NOTIFICATION_SERVICE)
        as android.app.NotificationManager
      manager.notify((System.currentTimeMillis() % Int.MAX_VALUE).toInt(), notification)
    } catch (e: Throwable) {
      android.util.Log.w(TAG, "postExpandableNotification failed: ${e.message}")
    }
  }

  fun showUpdateAvailable(version: String): String {
    pendingUpdateNotice = version
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
      checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
    ) {
      if (notificationPromptedFor != version) {
        notificationPromptedFor = version
        runOnUiThread {
          requestPermissions(
            arrayOf(Manifest.permission.POST_NOTIFICATIONS),
            NOTIFICATION_PERMISSION_REQUEST
          )
        }
      }
      return "permission"
    }
    if (!notificationsAllowed()) {
      return "disabled"
    }
    return try {
      postUpdateAvailableNotification(version)
      "shown"
    } catch (e: Throwable) {
      android.util.Log.w(TAG, "showUpdateAvailable failed: ${e.message}")
      "failed"
    }
  }

  private fun notificationsAllowed(): Boolean {
    val manager = getSystemService(NotificationManager::class.java) ?: return false
    if (!manager.areNotificationsEnabled()) {
      return false
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      return checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
    }
    return true
  }

  private fun postUpdateAvailableNotification(version: String) {
    ensureUpdateChannels()
    val text = "Version $version is ready to download."
    val notification = NotificationCompat.Builder(this, UPDATE_AVAILABLE_CHANNEL)
      .setSmallIcon(R.drawable.ic_stat_notify)
      .setContentTitle("AI Usage Tracker update available")
      .setContentText(text)
      .setStyle(NotificationCompat.BigTextStyle().bigText(text))
      .setPriority(NotificationCompat.PRIORITY_HIGH)
      .setCategory(NotificationCompat.CATEGORY_STATUS)
      .setOnlyAlertOnce(true)
      .setAutoCancel(true)
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
      .setContentIntent(updateNotificationPendingIntent(version))
      .build()
    val manager = getSystemService(NotificationManager::class.java)
    manager.notify(UPDATE_AVAILABLE_NOTIFICATION_ID, notification)
  }

  private fun ensureUpdateChannels() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
      return
    }
    val manager = getSystemService(NotificationManager::class.java) ?: return
    if (manager.getNotificationChannel(UPDATE_AVAILABLE_CHANNEL) == null) {
      manager.createNotificationChannel(
        NotificationChannel(
          UPDATE_AVAILABLE_CHANNEL,
          "Update available",
          NotificationManager.IMPORTANCE_HIGH
        ).apply {
          description = "Alerts when a new version is ready to download"
          enableVibration(true)
          setShowBadge(true)
          lockscreenVisibility = Notification.VISIBILITY_PUBLIC
        }
      )
    }
    if (manager.getNotificationChannel(UPDATE_CHANNEL) == null) {
      manager.createNotificationChannel(
        NotificationChannel(
          UPDATE_CHANNEL,
          "App updates",
          NotificationManager.IMPORTANCE_LOW
        ).apply {
          description = "Download and install progress for app updates"
          enableVibration(false)
          setShowBadge(false)
        }
      )
    }
  }

  private fun updateNotificationPendingIntent(version: String): PendingIntent {
    val launch = packageManager.getLaunchIntentForPackage(packageName)
      ?: Intent(this, MainActivity::class.java).apply {
        action = Intent.ACTION_MAIN
        addCategory(Intent.CATEGORY_LAUNCHER)
      }
    launch.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
    launch.putExtra("open_update_notes", version)
    return PendingIntent.getActivity(
      this,
      UPDATE_AVAILABLE_NOTIFICATION_ID,
      launch,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )
  }

  private fun appLaunchPendingIntent(): PendingIntent {
    val launch = packageManager.getLaunchIntentForPackage(packageName)
      ?: Intent(this, MainActivity::class.java).apply {
        action = Intent.ACTION_MAIN
        addCategory(Intent.CATEGORY_LAUNCHER)
      }
    launch.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
    return PendingIntent.getActivity(
      this,
      UPDATE_NOTIFICATION_ID,
      launch,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )
  }

  fun updateDownloadPath(): String {
    val dir = File(cacheDir, "updates")
    if (!dir.exists() && !dir.mkdirs() && !dir.isDirectory) {
      throw IllegalStateException("Unable to save the update.")
    }
    return File(dir, "ai-usage-tracker-update.apk").absolutePath
  }

  fun showUpdateDownloadProgress(percent: Int, indeterminate: Boolean) {
    val now = SystemClock.elapsedRealtime()
    if (!indeterminate && percent < 100 && now - lastUpdateNotifyAt < 250L) {
      return
    }
    lastUpdateNotifyAt = now
    val text = if (indeterminate) "Downloading update…" else "Downloading update… $percent%"
    notifyUpdate(
      title = "Downloading update",
      text = text,
      ongoing = true,
      progressMax = 100,
      progress = percent.coerceIn(0, 100),
      indeterminate = indeterminate,
      autoCancel = false
    )
  }

  fun showUpdateInstalling() {
    notifyUpdate(
      title = "Installing update",
      text = "Opening the Android installer…",
      ongoing = true,
      progressMax = 0,
      progress = 0,
      indeterminate = true,
      autoCancel = false
    )
  }

  fun clearUpdateNotification() {
    try {
      val manager = getSystemService(Context.NOTIFICATION_SERVICE) as android.app.NotificationManager
      manager.cancel(UPDATE_NOTIFICATION_ID)
    } catch (e: Throwable) {
      android.util.Log.w(TAG, "clearUpdateNotification failed: ${e.message}")
    }
  }

  private fun notifyUpdate(
    title: String,
    text: String,
    ongoing: Boolean,
    progressMax: Int,
    progress: Int,
    indeterminate: Boolean,
    autoCancel: Boolean
  ) {
    try {
      ensureUpdateChannels()
      val builder = NotificationCompat.Builder(this, UPDATE_CHANNEL)
        .setSmallIcon(R.drawable.ic_stat_notify)
        .setContentTitle(title)
        .setContentText(text)
        .setOnlyAlertOnce(true)
        .setOngoing(ongoing)
        .setAutoCancel(autoCancel)
        .setPriority(NotificationCompat.PRIORITY_LOW)
        .setSilent(true)
      if (progressMax > 0) {
        builder.setProgress(progressMax, progress, indeterminate)
      } else if (indeterminate) {
        builder.setProgress(100, 0, true)
      }
      val manager = getSystemService(Context.NOTIFICATION_SERVICE) as android.app.NotificationManager
      manager.notify(UPDATE_NOTIFICATION_ID, builder.build())
    } catch (e: Throwable) {
      android.util.Log.w(TAG, "notifyUpdate failed: ${e.message}")
    }
  }

  // Called from Rust over JNI (see android_keystore.rs). They throw on failure.
  fun encryptCredential(data: ByteArray, context: ByteArray): ByteArray =
    CredentialVault.seal(data, context)

  fun decryptCredential(data: ByteArray, context: ByteArray): ByteArray =
    CredentialVault.open(data, context)

  fun verifyDownloadedApk(path: String): String {
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
    val currentDigests = signingCertDigests(current)
    val apkDigests = signingCertDigests(archive)
    if (currentDigests.isEmpty() || apkDigests.intersect(currentDigests).isEmpty()) {
      return "The update is not signed with this app's certificate."
    }
    return "ok"
  }

  private fun signingCertDigests(info: android.content.pm.PackageInfo): Set<String> {
    val digest = java.security.MessageDigest.getInstance("SHA-256")
    val signatures: Array<android.content.pm.Signature> = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      val signingInfo = info.signingInfo ?: return emptySet()
      if (signingInfo.hasMultipleSigners()) {
        signingInfo.apkContentsSigners
      } else {
        signingInfo.signingCertificateHistory
      }
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
    return Build.VERSION.SDK_INT < Build.VERSION_CODES.O || packageManager.canRequestPackageInstalls()
  }

  private fun openInstallPermissionSettings(): Boolean {
    val intent = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES).apply {
      data = Uri.parse("package:$packageName")
    }
    val ok = AtomicBoolean(false)
    val launch = {
      startActivity(intent)
      ok.set(true)
    }
    if (Looper.myLooper() == Looper.getMainLooper()) {
      return try {
        launch()
        true
      } catch (error: Exception) {
        android.util.Log.e(TAG, "Unknown-app install settings failed: ${error.message}")
        false
      }
    }
    val latch = CountDownLatch(1)
    runOnUiThread {
      try {
        launch()
      } catch (error: Exception) {
        android.util.Log.e(TAG, "Unknown-app install settings failed: ${error.message}")
      } finally {
        latch.countDown()
      }
    }
    return latch.await(5, TimeUnit.SECONDS) && ok.get()
  }

  private fun setPendingInstall(file: File?) {
    getSharedPreferences(UPDATE_PREFS, Context.MODE_PRIVATE).edit().apply {
      if (file == null) remove(PENDING_APK_KEY) else putString(PENDING_APK_KEY, file.absolutePath)
    }.apply()
  }

  /**
   * After the user grants "install unknown apps" in system settings, continue the install
   * that was waiting on it. The path is persisted so a process restart does not lose it.
   */
  private fun resumePendingInstall() {
    val prefs = getSharedPreferences(UPDATE_PREFS, Context.MODE_PRIVATE)
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
        android.util.Log.e(TAG, "Could not open the installer: ${error.message}")
        showUpdateFailure(installFailureText(error.message))
      }
    }.start()
  }

  private fun showUpdateFailure(text: String) {
    notifyUpdate(
      title = "Update failed",
      text = text,
      ongoing = false,
      progressMax = 0,
      progress = 0,
      indeterminate = false,
      autoCancel = true
    )
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
      android.util.Log.w(TAG, "System installer could not be opened, using a session: ${error.message}")
    }
    commitApkSession(file, waitForPrompt)
  }

  private fun commitApkSession(file: File, waitForPrompt: Boolean) {
    val installer = packageManager.packageInstaller
    val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
      setSize(file.length())
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_REQUIRED)
      }
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        setAppPackageName(packageName)
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
      val callbackIntent = Intent(this, ApkInstallReceiver::class.java).apply {
        action = ApkInstallReceiver.ACTION
      }
      val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE
      } else {
        PendingIntent.FLAG_UPDATE_CURRENT
      }
      val pending = PendingIntent.getBroadcast(this, sessionId, callbackIntent, flags)
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
    val uri = FileProvider.getUriForFile(this, "$packageName.fileprovider", file)
    val intent = Intent(Intent.ACTION_VIEW).apply {
      setDataAndType(uri, "application/vnd.android.package-archive")
      addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }
    val resolvers = packageManager.queryIntentActivities(intent, PackageManager.MATCH_DEFAULT_ONLY)
    for (resolve in resolvers) {
      grantUriPermission(
        resolve.activityInfo.packageName,
        uri,
        Intent.FLAG_GRANT_READ_URI_PERMISSION
      )
    }
    val launch = { startActivity(intent) }
    if (Looper.myLooper() == Looper.getMainLooper()) {
      launch()
      return
    }
    val latch = CountDownLatch(1)
    var launchError: Exception? = null
    runOnUiThread {
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
    val cacheUpdates = File(cacheDir, "updates")
    val shareableRoots = listOf(cacheUpdates.canonicalFile, File(filesDir, "updates").canonicalFile)
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


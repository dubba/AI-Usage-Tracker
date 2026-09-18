package com.yajinni.paseousagebridge

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.os.SystemClock
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

    @JvmStatic
    external fun setPendingPairingUri(uri: String)

    private const val UPDATE_CHANNEL = "updates"
    private const val UPDATE_NOTIFICATION_ID = 47001
  }

  private var activeWebView: WebView? = null
  @Volatile private var lastUpdateNotifyAt: Long = 0L
  private var safeTopDp: Int = 48
  private var safeBottomDp: Int = 0
  private var safeImeDp: Int = 0
  private var multicastLock: android.net.wifi.WifiManager.MulticastLock? = null
  private var boundLanNetwork: Boolean = false

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    activeWebView = webView
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

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    handlePairingIntent(intent)
  }

  override fun onCreate(savedInstanceState: Bundle?) {
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
    pendingUriMemory?.let { uri ->
      try {
        setPendingPairingUri(uri)
      } catch (e: Throwable) {
        android.util.Log.e(TAG, "Retry setPendingPairingUri failed: ${e.message}")
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
      val updateChannel = android.app.NotificationChannel(
        UPDATE_CHANNEL,
        "App updates",
        android.app.NotificationManager.IMPORTANCE_LOW
      ).apply {
        description = "Download and install progress for app updates"
        enableVibration(false)
        setShowBadge(false)
      }
      notificationManager?.createNotificationChannel(updateChannel)
    }

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
        requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1002)
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
        .build()
      val manager = getSystemService(Context.NOTIFICATION_SERVICE)
        as android.app.NotificationManager
      manager.notify((System.currentTimeMillis() % Int.MAX_VALUE).toInt(), notification)
    } catch (e: Throwable) {
      android.util.Log.w(TAG, "postExpandableNotification failed: ${e.message}")
    }
  }

  fun ensureCanInstallUpdates(): String {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !packageManager.canRequestPackageInstalls()) {
      runOnUiThread {
        startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES).apply {
          data = Uri.parse("package:$packageName")
          addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        })
      }
      return "Allow AI Usage Tracker to install updates, then tap Update again."
    }
    return "ok"
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
      val builder = NotificationCompat.Builder(this, UPDATE_CHANNEL)
        .setSmallIcon(applicationInfo.icon)
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
      return "The update is for a different app."
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
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !packageManager.canRequestPackageInstalls()) {
      runOnUiThread {
        startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES).apply {
          data = Uri.parse("package:$packageName")
          addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        })
      }
      throw IllegalStateException("Allow AI Usage Tracker to install updates, then tap Update again.")
    }
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
    val latch = CountDownLatch(1)
    var launchError: Exception? = null
    runOnUiThread {
      try {
        startActivity(intent)
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
}


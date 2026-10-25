package com.dubba.ai.usage.tracker

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.ComponentName
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
import androidx.activity.OnBackPressedCallback
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.browser.customtabs.CustomTabColorSchemeParams
import androidx.browser.customtabs.CustomTabsCallback
import androidx.browser.customtabs.CustomTabsClient
import androidx.browser.customtabs.CustomTabsIntent
import androidx.browser.customtabs.CustomTabsServiceConnection
import androidx.browser.customtabs.CustomTabsSession
import androidx.core.app.NotificationCompat
import androidx.core.content.FileProvider
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

/** onPageFinished runs on the WebView client. The view's context may be the activity or a wrapper around it. */
fun reapplyWindowInsetsFrom(view: WebView) {
  var ctx = view.context
  while (ctx is android.content.ContextWrapper && ctx !is MainActivity) {
    val next = ctx.baseContext ?: break
    if (next === ctx) break
    ctx = next
  }
  if (ctx is MainActivity) ctx.reapplyWindowInsets()
}

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

    /** The Custom Tabs keep-alive extra (androidx.browser has no builder method for it). */
    private const val KEEP_ALIVE_EXTRA = "android.support.customtabs.extra.KEEP_ALIVE"

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
  private val signInTab = SignInTab()
  // Bound from the JNI thread, unbound on the UI thread.
  @Volatile private var signInTabConnection: CustomTabsServiceConnection? = null
  @Volatile private var signInResultShowing: Boolean = false
  private var appShellUrl: String = "http://tauri.localhost/"
  @Volatile private var lastUpdateNotifyAt: Long = 0L
  @Volatile private var pendingUpdateNotice: String? = null
  private var notificationPromptedFor: String? = null
  private var safeTopDp: Int = 0
  private var safeBottomDp: Int = 0
  private var safeImeDp: Int = 0
  private var multicastLock: android.net.wifi.WifiManager.MulticastLock? = null
  private var boundLanNetwork: Boolean = false

  private fun isAppShellUrl(url: String?): Boolean {
    if (url.isNullOrBlank() || url == "about:blank") return false
    val uri = try {
      Uri.parse(url)
    } catch (_: Exception) {
      return false
    }
    val host = uri.host?.lowercase().orEmpty()
    val scheme = uri.scheme?.lowercase().orEmpty()
    val isApp = (host == "tauri.localhost") ||
      (scheme == "tauri" && host == "localhost") ||
      (uri.port == 1420 && (host == "localhost" || host == "127.0.0.1" || host.startsWith("192.168.") || host.startsWith("10.")))
    if (isApp) {
      appShellUrl = url
    }
    return isApp
  }

  /**
   * Clears the back-forward navigation history so that back gestures in the
   * app shell do not navigate back into stale OAuth or "Account connected" pages.
   */
  fun clearWebViewHistory() {
    runOnUiThread {
      signInResultShowing = false
      activeWebView?.clearHistory()
    }
  }

  /**
   * Rust reports when the sign-in's "Account connected" page is up (and that it is gone). Back on
   * that page must return to the dashboard whatever URL the WebView reports for it, because the
   * page differs per provider (the app's own `data:` page, a loopback redirect) and a URL
   * test alone missed some of them. Rust reports it again once the page has loaded, which is when
   * the history can be cleared for good.
   */
  fun setSignInResultShowing(showing: Boolean) {
    signInResultShowing = showing
    if (showing) {
      // A WebView that can go back takes the back gesture itself, before the callback below runs
      // (it stepped back through the login pages). With no history left, back reaches the callback.
      runOnUiThread { activeWebView?.clearHistory() }
    }
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    activeWebView = webView
    val current = webView.url
    if (!current.isNullOrBlank() && isAppShellUrl(current)) {
      appShellUrl = current
    }
    webView.settings.javaScriptCanOpenWindowsAutomatically = true
    webView.settings.setSupportMultipleWindows(true)
    CookieManager.getInstance().setAcceptCookie(true)
    CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true)
    val ua = webView.settings.userAgentString.orEmpty()
    if (ua.contains("; wv")) {
      webView.settings.userAgentString = ua.replace("; wv", "")
    }
    applyInsetsToWebView()
    // The view may not be in the hierarchy yet. Ask again once it is attached,
    // so the listener below runs with the real status and navigation insets.
    webView.post { ViewCompat.requestApplyInsets(window.decorView) }
  }

  /**
   * Writes the latest system insets onto the app page. The decor view listener can
   * run before that document exists, and a load replaces the document, so the
   * WebView client calls this again from onPageFinished.
   */
  fun reapplyWindowInsets() {
    applyInsetsToWebView()
  }

  private fun applyInsetsToWebView() {
    val wv = activeWebView ?: return
    // Provider sign-in pages do not use these variables. Skip them so this script
    // is not injected into accounts.google.com and the other login hosts.
    if (!isAppShellUrl(wv.url)) return
    wv.post {
      if (!isAppShellUrl(wv.url)) return@post
      val js = """
        (function() {
          function apply() {
            var root = document.documentElement;
            if (!root) return;
            root.style.setProperty('--android-safe-top', '${safeTopDp}px');
            root.style.setProperty('--android-safe-bottom', '${safeBottomDp}px');
            root.style.setProperty('--android-keyboard-height', '${safeImeDp}px');
            if (${safeImeDp} > 0) {
              root.classList.add('keyboard-active');
            } else {
              root.classList.remove('keyboard-active');
            }
          }
          apply();
          document.addEventListener('DOMContentLoaded', apply, { once: true });
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
    signInTab.activityResumed()
    notifyInstallFailure = { text -> showUpdateFailure(text) }
    resumePendingInstall()
  }

  override fun onDestroy() {
    disconnectSignInTabSession()
    notifyInstallFailure = null
    activeWebView = null
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

    onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        val wv = activeWebView
        if (wv != null) {
          val url = wv.url.orEmpty()
          android.util.Log.i(
            TAG,
            "Back: scheme=${url.substringBefore(':', "")} resultShowing=$signInResultShowing canGoBack=${wv.canGoBack()}"
          )
          if (signInResultShowing || SignInPages.isResultPage(url)) {
            signInResultShowing = false
            // If the user presses back while viewing the 5-second "Account connected" page,
            // dismiss it immediately and restore the app shell rather than going back to OAuth.
            wv.clearHistory()
            wv.loadUrl(appShellUrl)
            return
          }
          if (isAppShellUrl(url)) {
            // Once returned to the app shell, the user must never be navigated back
            // into completed OAuth or "Account connected" pages.
            wv.clearHistory()
            wv.evaluateJavascript(
              "(function(){ var ev = new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true }); return (document.activeElement || document).dispatchEvent(ev); })()"
            ) { result ->
              if (result == "false") {
                return@evaluateJavascript
              }
              runOnUiThread {
                if (!moveTaskToBack(true)) {
                  finish()
                }
              }
            }
            return
          }
          if (wv.canGoBack()) {
            wv.goBack()
            return
          }
        }
        if (!moveTaskToBack(true)) {
          finish()
        }
      }
    })

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
    // enableEdgeToEdge can dispatch insets before this listener exists. Ask again
    // after the decor view is laid out, or the page keeps a 0px status-bar inset.
    window.decorView.post { ViewCompat.requestApplyInsets(window.decorView) }

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
   * Pairing (Link Devices) finds peers with mDNS over multicast, and Android filters
   * inbound multicast unless the app holds a MulticastLock; without it, code joins
   * time out on the phone. The lock keeps the Wi-Fi radio processing multicast, which
   * costs battery, so it is held only while a pairing session runs.
   */
  private fun setPairingMulticastLock(enabled: Boolean) {
    try {
      if (enabled) {
        if (multicastLock?.isHeld == true) return
        val wifiManager = applicationContext.getSystemService(Context.WIFI_SERVICE)
          as android.net.wifi.WifiManager
        multicastLock = wifiManager.createMulticastLock("aiut-pairing").apply {
          setReferenceCounted(false)
          acquire()
        }
      } else {
        multicastLock?.takeIf { it.isHeld }?.release()
        multicastLock = null
      }
    } catch (e: Throwable) {
      android.util.Log.w(TAG, "Updating the pairing multicast lock failed: ${e.message}")
    }
  }

  /**
   * Whether the Wi-Fi radio is on. Link-code pairing asks this first so the
   * app can send the user to the system Wi-Fi panel. Fail-open (true) if the
   * check itself throws, so a broken probe cannot block pairing.
   */
  @Suppress("DEPRECATION")
  fun isWifiEnabled(): Boolean {
    return try {
      val wifiManager = applicationContext.getSystemService(Context.WIFI_SERVICE)
        as android.net.wifi.WifiManager
      wifiManager.isWifiEnabled
    } catch (e: Throwable) {
      android.util.Log.w(TAG, "isWifiEnabled failed: ${e.message}")
      true
    }
  }

  fun openWifiSettings() {
    runOnUiThread {
      try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
          try {
            startActivity(Intent(Settings.Panel.ACTION_WIFI))
            return@runOnUiThread
          } catch (_: Exception) {
          }
        }
        startActivity(Intent(Settings.ACTION_WIFI_SETTINGS))
      } catch (e: Throwable) {
        android.util.Log.w(TAG, "openWifiSettings failed: ${e.message}")
      }
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
      setPairingMulticastLock(enabled)
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

  /**
   * Removes every cookie in this app's WebView before another provider sign-in.
   * The system browser is left alone, and the app's own storage is not a cookie
   * jar. CookieManager.removeAllCookies with a callback requires a Looper, so
   * non-UI threads dispatch to the main thread via runOnUiThread and await
   * completion with a CountDownLatch. A caller already on the UI thread starts
   * the clear without blocking to avoid deadlock.
   */
  fun clearWebViewCookies(): Boolean {
    val manager = CookieManager.getInstance()
    if (Looper.myLooper() == Looper.getMainLooper()) {
      manager.removeSessionCookies(null)
      manager.removeAllCookies(null)
      manager.flush()
      return true
    }
    val latch = CountDownLatch(1)
    val success = AtomicBoolean(false)
    runOnUiThread {
      try {
        manager.removeSessionCookies(null)
        manager.removeAllCookies {
          success.set(true)
          manager.flush()
          latch.countDown()
        }
      } catch (e: Throwable) {
        android.util.Log.w(TAG, "clearWebViewCookies failed: ${e.message}")
        latch.countDown()
      }
    }
    val finished = try {
      latch.await(5, TimeUnit.SECONDS)
    } catch (_: InterruptedException) {
      false
    }
    return finished && success.get()
  }

  /**
   * Opens a provider's sign-in page in a Custom Tab (see [SignInTab]), in the default browser
   * when it supports them, else in another browser that does. Returns the tab's number, or 0 when
   * no installed browser supports Custom Tabs or the tab did not open; Rust then uses the in-app
   * page. With [freshSession] the tab starts with no sign-ins of the browser's, where the
   * browser supports it. Called from Rust over JNI (sign_in_tab.rs), never on the UI thread.
   */
  fun openSignInTab(url: String, freshSession: Boolean): Int {
    if (!SignInTab.isAllowedUrl(url)) return 0
    val browser = try {
      CustomTabsClient.getPackageName(this, null)
    } catch (e: Exception) {
      null
    }
    if (browser == null) {
      android.util.Log.i(TAG, "No browser supports Custom Tabs; signing in in the app")
      return 0
    }
    val session = connectSignInTabSession(browser)
    val opened = AtomicInteger(0)
    val latch = CountDownLatch(1)
    runOnUiThread {
      try {
        val black = CustomTabColorSchemeParams.Builder()
          .setToolbarColor(Color.BLACK)
          .setNavigationBarColor(Color.BLACK)
          .build()
        val builder = if (session != null) CustomTabsIntent.Builder(session) else CustomTabsIntent.Builder()
        // A fresh session sees none of the browser's sign-ins, so "Continue with Google" on
        // Claude's or ChatGPT's page asks which account instead of reusing the browser's. A
        // browser without that mode keeps the shared session.
        val fresh = freshSession && ephemeralSupported(browser)
        if (fresh) builder.setEphemeralBrowsingEnabled(true)
        android.util.Log.i(TAG, "Sign-in tab: fresh session requested=$freshSession used=$fresh")
        val tab = builder
          .setColorScheme(CustomTabsIntent.COLOR_SCHEME_DARK)
          .setDefaultColorSchemeParams(black)
          .setShowTitle(true)
          // The address bar stays, so the user can see which site asks for the password.
          .setUrlBarHidingEnabled(false)
          .setShareState(CustomTabsIntent.SHARE_STATE_OFF)
          .setBookmarksButtonEnabled(false)
          .setDownloadButtonEnabled(false)
          .build()
        tab.intent.setPackage(browser)
        // The browser binds this while the tab is shown, which keeps the app from being frozen
        // behind the tab before the provider redirects to the loopback callback.
        tab.intent.putExtra(
          KEEP_ALIVE_EXTRA,
          Intent().setClassName(packageName, SignInTabKeepAliveService::class.java.name)
        )
        tab.launchUrl(this, Uri.parse(url))
        // Still on the UI thread, so onResume cannot run before the tab counts as open.
        opened.set(signInTab.opened())
      } catch (e: Exception) {
        android.util.Log.w(TAG, "The sign-in tab did not open: ${e.javaClass.simpleName}")
      } finally {
        latch.countDown()
      }
    }
    val finished = try {
      latch.await(5, TimeUnit.SECONDS)
    } catch (_: InterruptedException) {
      false
    }
    val tab = if (finished) opened.get() else 0
    if (tab == 0) disconnectSignInTabSession()
    return tab
  }

  private fun ephemeralSupported(browser: String): Boolean = try {
    CustomTabsClient.isEphemeralBrowsingSupported(this, browser)
  } catch (e: Throwable) {
    false
  }

  /**
   * Binds to [browser]'s Custom Tabs service for a session, whose callback reports when the user
   * minimizes the tab. Without one (the browser has no such service, or it did not answer in
   * time), a minimized tab looks closed and cancels the sign-in.
   */
  private fun connectSignInTabSession(browser: String): CustomTabsSession? {
    disconnectSignInTabSession()
    val session = AtomicReference<CustomTabsSession?>(null)
    val ready = CountDownLatch(1)
    val connection = object : CustomTabsServiceConnection() {
      override fun onCustomTabsServiceConnected(name: ComponentName, client: CustomTabsClient) {
        session.set(client.newSession(signInTabCallback))
        ready.countDown()
      }

      override fun onServiceDisconnected(name: ComponentName) {}
    }
    val bound = try {
      CustomTabsClient.bindCustomTabsService(this, browser, connection)
    } catch (e: Exception) {
      false
    }
    if (!bound) return null
    synchronized(this) { signInTabConnection = connection }
    val connected = try {
      ready.await(2, TimeUnit.SECONDS)
    } catch (_: InterruptedException) {
      false
    }
    return if (connected) session.get() else null
  }

  private fun disconnectSignInTabSession() {
    val connection = synchronized(this) {
      signInTabConnection.also { signInTabConnection = null }
    } ?: return
    try {
      unbindService(connection)
    } catch (_: Exception) {
    }
  }

  private val signInTabCallback = object : CustomTabsCallback() {
    override fun onNavigationEvent(navigationEvent: Int, extras: Bundle?) {
      when (navigationEvent) {
        TAB_HIDDEN -> signInTab.hidden()
        TAB_SHOWN -> signInTab.shown()
      }
    }

    override fun onMinimized(extras: Bundle) {
      android.util.Log.i(TAG, "The sign-in tab was minimized")
      signInTab.minimized()
    }

    override fun onUnminimized(extras: Bundle) {
      android.util.Log.i(TAG, "The sign-in tab was restored")
      signInTab.unminimized()
    }
  }

  /** Whether the user closed sign-in tab [tab] before the app returned over it. Reported once. */
  fun takeSignInTabClosed(tab: Int): Boolean {
    val closed = signInTab.takeClosedByUser(tab)
    if (closed) runOnUiThread { disconnectSignInTabSession() }
    return closed
  }

  /**
   * Brings this activity back over sign-in tab [tab] once its sign-in has ended. The tab is in
   * this task, above the activity, so restarting the activity (singleTask) finishes the tab.
   */
  fun closeSignInTab(tab: Int) {
    runOnUiThread {
      if (!signInTab.returning(tab)) return@runOnUiThread
      disconnectSignInTabSession()
      try {
        startActivity(
          Intent(this, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        )
      } catch (e: Exception) {
        android.util.Log.w(TAG, "Returning over the sign-in tab failed: ${e.javaClass.simpleName}")
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
    // FLAG_GRANT_READ_URI_PERMISSION above grants read access to the installer the
    // user actually opens. Granting it to every app that handles APKs would let any
    // of them read the update without being chosen.
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


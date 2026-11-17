package com.dubba.ai.usage.tracker

import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Looper
import android.view.WindowManager
import android.webkit.CookieManager
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.core.view.WindowCompat
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/** The logcat tag of every class in this package that logs. */
internal const val LOG_TAG = "AIUsagePairing"

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

/**
 * The app's one activity. It owns the WebView (history, cookies, the back gesture), takes in
 * update-notice intents, and is the object Rust calls over JNI by method name.
 * Each of those calls is forwarded to the class that does the work: [PairingNetwork],
 * [SignInTabLauncher], [UpdateNotifications], [AppUpdateInstaller] and [WebViewInsets].
 * A method Rust calls must keep its name and signature here.
 */
class MainActivity : TauriActivity() {
  companion object {
    private const val TAG = LOG_TAG

    init {
      try {
        System.loadLibrary("ai_usage_tracker_lib")
      } catch (e: Throwable) {
        android.util.Log.w(TAG, "Early loadLibrary info: ${e.message}")
      }
    }

    @Volatile
    private var pendingUpdateNoticeMemory: String? = null

    @JvmStatic
    external fun setPendingUpdateNotice(version: String)

    /** Hands this activity to Rust for its JNI calls (see android_context.rs). */
    @JvmStatic
    private external fun registerActivity(activity: MainActivity)
  }

  private var activeWebView: WebView? = null
  @Volatile private var signInResultShowing: Boolean = false
  private var appShellUrl: String = "http://tauri.localhost/"

  private val pairingNetwork = PairingNetwork(this)
  private val signInTabs = SignInTabLauncher(this)
  private val updateNotifications = UpdateNotifications(this)
  private val updateInstaller = AppUpdateInstaller(this, updateNotifications)
  private val insets = WebViewInsets(this, { activeWebView }, ::isAppShellUrl)

  // The WebView: which page is the app's own, history, cookies, and the back gesture.

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
    insets.apply()
    // The view may not be in the hierarchy yet. Ask again once it is attached,
    // so the insets listener runs with the real status and navigation insets.
    webView.post { insets.requestInsets() }
  }

  /**
   * Writes the latest system insets onto the app page. The decor view listener can
   * run before that document exists, and a load replaces the document, so the
   * WebView client calls this again from onPageFinished.
   */
  fun reapplyWindowInsets() {
    insets.apply()
  }

  /**
   * Back on the "Account connected" page returns to the dashboard; back on the app's own page
   * sends Escape to the page and, if nothing there took it, puts the app in the background;
   * back on any other page (a provider's sign-in) goes back one page.
   */
  private fun handleBack() {
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

  /** Invalidates a stale WebView cache when the APK is updated to a new version. */
  private fun clearWebViewCacheAfterAppUpdate() {
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

  // Intents: the update notification's tap. Links from other apps are not acted on: the only
  // other filter (aiusage-signin) just brings the app forward.

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

  // Lifecycle.

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    handleUpdateIntent(intent)
  }

  override fun onResume() {
    super.onResume()
    signInTabs.activityResumed()
    updateInstaller.activityResumed()
  }

  override fun onDestroy() {
    signInTabs.disconnectSession()
    updateInstaller.activityDestroyed()
    activeWebView = null
    super.onDestroy()
  }

  override fun onRequestPermissionsResult(
    requestCode: Int,
    permissions: Array<out String>,
    grantResults: IntArray
  ) {
    super.onRequestPermissionsResult(requestCode, permissions, grantResults)
    updateNotifications.onRequestPermissionsResult(requestCode)
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    try {
      registerActivity(this)
    } catch (e: Throwable) {
      android.util.Log.e(TAG, "registerActivity failed: ${e.message}")
    }
    BackgroundRefreshWorker.schedule(this)
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
      override fun handleOnBackPressed() = handleBack()
    })

    enableEdgeToEdge(
      statusBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
      navigationBarStyle = SystemBarStyle.dark(Color.TRANSPARENT)
    )
    insets.install()

    handleUpdateIntent(intent)
    pendingUpdateNoticeMemory?.let { ver ->
      try {
        setPendingUpdateNotice(ver)
      } catch (e: Throwable) {
        android.util.Log.e(TAG, "Retry setPendingUpdateNotice failed: ${e.message}")
      }
    }

    updateNotifications.createChannels()
    updateNotifications.requestPermissionAtLaunch()
    clearWebViewCacheAfterAppUpdate()
  }

  // Called from Rust over JNI by name. Each forwards to the class that does the work.

  // Pairing network (wifi.rs, lan_binding.rs).
  fun isWifiEnabled(): Boolean = pairingNetwork.isWifiEnabled()

  fun openWifiSettings() = pairingNetwork.openWifiSettings()

  fun setPairingLanBinding(enabled: Boolean) = pairingNetwork.setLanBinding(enabled)

  /**
   * Keeps this window out of screenshots, screen recordings and the recent-apps preview while
   * the air-gap transfer codes are showing (capture_protection.rs).
   */
  fun setScreenCaptureBlocked(blocked: Boolean) {
    runOnUiThread {
      if (blocked) {
        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
      } else {
        window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
      }
    }
  }

  // Sign-in Custom Tab (sign_in_tab.rs). openSignInTab is never called on the UI thread.
  fun openSignInTab(url: String, freshSession: Boolean): Int = signInTabs.open(url, freshSession)

  fun takeSignInTabClosed(tab: Int): Boolean = signInTabs.takeClosed(tab)

  fun closeSignInTab(tab: Int) = signInTabs.close(tab)

  /** Posts an alert notification whose body stays fully readable when expanded. */
  fun postExpandableNotification(title: String, body: String) {
    AlertNotifications.post(this, title, body)
  }

  // App updates (updater/android.rs, apk_install.rs).
  fun showUpdateAvailable(version: String): String = updateNotifications.showUpdateAvailable(version)

  fun updateDownloadPath(): String = updateInstaller.downloadPath()

  fun showUpdateDownloadProgress(percent: Int, indeterminate: Boolean) =
    updateNotifications.showDownloadProgress(percent, indeterminate)

  fun showUpdateInstalling() = updateNotifications.showInstalling()

  fun clearUpdateNotification() = updateNotifications.clear()

  fun verifyDownloadedApk(path: String): String = updateInstaller.verifyDownloadedApk(path)

  fun installDownloadedApk(path: String) = updateInstaller.installDownloadedApk(path)

  // Credentials (android_keystore.rs). They throw on failure.
  fun encryptCredential(data: ByteArray, context: ByteArray): ByteArray =
    CredentialVault.seal(data, context)

  fun decryptCredential(data: ByteArray, context: ByteArray): ByteArray =
    CredentialVault.open(data, context)
}

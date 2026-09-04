package com.yajinni.paseousagebridge

import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.webkit.WebView
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.core.content.FileProvider
import androidx.core.view.WindowCompat
import java.io.File

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
  }

  private fun handlePairingIntent(intent: Intent?) {
    val uri = intent?.dataString ?: return
    android.util.Log.i(TAG, "Received pairing intent data: $uri")
    if (uri.startsWith("aiusage-pair:") || uri.startsWith("aiusage:")) {
      pendingUriMemory = uri
      try {
        setPendingPairingUri(uri)
        android.util.Log.i(TAG, "Successfully forwarded pairing URI to Rust: $uri")
      } catch (e: Throwable) {
        android.util.Log.w(TAG, "setPendingPairingUri deferred until runtime init: ${e.message}")
      }
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

    handlePairingIntent(intent)
    pendingUriMemory?.let { uri ->
      try {
        setPendingPairingUri(uri)
      } catch (e: Throwable) {
        android.util.Log.e(TAG, "Retry setPendingPairingUri failed: ${e.message}")
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

  fun installDownloadedApk(path: String) {
    val file = File(path)
    if (!file.exists() || file.length() < 1024L) {
      throw IllegalArgumentException("The downloaded update is missing or incomplete.")
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !packageManager.canRequestPackageInstalls()) {
      startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES).apply {
        data = Uri.parse("package:$packageName")
      })
      throw IllegalStateException("Allow AI Usage Tracker to install updates, then tap Update again.")
    }
    runOnUiThread {
      val uri = FileProvider.getUriForFile(this, "$packageName.fileprovider", file)
      startActivity(Intent(Intent.ACTION_VIEW).apply {
        setDataAndType(uri, "application/vnd.android.package-archive")
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      })
    }
  }
}


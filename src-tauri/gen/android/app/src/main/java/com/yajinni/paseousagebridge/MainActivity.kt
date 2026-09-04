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
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge(
      statusBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
      navigationBarStyle = SystemBarStyle.dark(Color.TRANSPARENT)
    )

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

    super.onCreate(savedInstanceState)
    WindowCompat.getInsetsController(window, window.decorView).apply {
      isAppearanceLightStatusBars = false
      isAppearanceLightNavigationBars = false
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


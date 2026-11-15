package com.dubba.ai.usage.tracker

import android.Manifest
import android.app.Activity
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.SystemClock
import androidx.core.app.NotificationCompat

/**
 * The app's notification channels, the notification permission prompt, and the notifications
 * about app updates (one is available, download progress, installing, failed). `MainActivity`
 * forwards Rust's JNI calls here.
 */
internal class UpdateNotifications(private val activity: Activity) {
  private companion object {
    const val UPDATE_CHANNEL = "updates"
    const val UPDATE_AVAILABLE_CHANNEL = "update-available"
    const val UPDATE_NOTIFICATION_ID = 47001
    const val UPDATE_AVAILABLE_NOTIFICATION_ID = 47002
    const val NOTIFICATION_PERMISSION_REQUEST = 1002
  }

  @Volatile private var lastUpdateNotifyAt: Long = 0L
  @Volatile private var pendingUpdateNotice: String? = null
  private var notificationPromptedFor: String? = null

  /** Creates the alert channel and both update channels. Called from onCreate. */
  fun createChannels() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val notificationManager = activity.getSystemService(android.app.NotificationManager::class.java)
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
  }

  /** Asks for the notification permission at launch if the user has not granted it. */
  fun requestPermissionAtLaunch() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      if (activity.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
        activity.requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), NOTIFICATION_PERMISSION_REQUEST)
      }
    }
  }

  /** Posts the update notice that was waiting on the permission, once the user has answered. */
  fun onRequestPermissionsResult(requestCode: Int) {
    if (requestCode == NOTIFICATION_PERMISSION_REQUEST && notificationsAllowed()) {
      pendingUpdateNotice?.let { postUpdateAvailableNotification(it) }
    }
  }

  fun showUpdateAvailable(version: String): String {
    pendingUpdateNotice = version
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
      activity.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
    ) {
      if (notificationPromptedFor != version) {
        notificationPromptedFor = version
        activity.runOnUiThread {
          activity.requestPermissions(
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
      android.util.Log.w(LOG_TAG, "showUpdateAvailable failed: ${e.message}")
      "failed"
    }
  }

  private fun notificationsAllowed(): Boolean {
    val manager = activity.getSystemService(NotificationManager::class.java) ?: return false
    if (!manager.areNotificationsEnabled()) {
      return false
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      return activity.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
    }
    return true
  }

  private fun postUpdateAvailableNotification(version: String) {
    ensureUpdateChannels()
    val text = "Version $version is ready to download."
    val notification = NotificationCompat.Builder(activity, UPDATE_AVAILABLE_CHANNEL)
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
    val manager = activity.getSystemService(NotificationManager::class.java)
    manager.notify(UPDATE_AVAILABLE_NOTIFICATION_ID, notification)
  }

  private fun ensureUpdateChannels() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
      return
    }
    val manager = activity.getSystemService(NotificationManager::class.java) ?: return
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
    val launch = activity.packageManager.getLaunchIntentForPackage(activity.packageName)
      ?: Intent(activity, MainActivity::class.java).apply {
        action = Intent.ACTION_MAIN
        addCategory(Intent.CATEGORY_LAUNCHER)
      }
    launch.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
    launch.putExtra("open_update_notes", version)
    return PendingIntent.getActivity(
      activity,
      UPDATE_AVAILABLE_NOTIFICATION_ID,
      launch,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )
  }

  fun showDownloadProgress(percent: Int, indeterminate: Boolean) {
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

  fun showInstalling() {
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

  fun showFailure(text: String) {
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

  fun clear() {
    try {
      val manager = activity.getSystemService(Context.NOTIFICATION_SERVICE) as android.app.NotificationManager
      manager.cancel(UPDATE_NOTIFICATION_ID)
    } catch (e: Throwable) {
      android.util.Log.w(LOG_TAG, "clearUpdateNotification failed: ${e.message}")
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
      val builder = NotificationCompat.Builder(activity, UPDATE_CHANNEL)
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
      val manager = activity.getSystemService(Context.NOTIFICATION_SERVICE) as android.app.NotificationManager
      manager.notify(UPDATE_NOTIFICATION_ID, builder.build())
    } catch (e: Throwable) {
      android.util.Log.w(LOG_TAG, "notifyUpdate failed: ${e.message}")
    }
  }
}

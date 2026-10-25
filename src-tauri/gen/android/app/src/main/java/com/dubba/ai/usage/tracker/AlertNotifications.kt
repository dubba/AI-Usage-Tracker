package com.dubba.ai.usage.tracker

import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat

/**
 * Posts a usage alert on the "default" channel that `MainActivity` creates. Used by the
 * activity (alerts raised while the app is open) and by `BackgroundRefreshWorker` (alerts
 * raised while it is closed), so both look the same.
 */
object AlertNotifications {
  private const val CHANNEL_ID = "default"

  /** The body stays fully readable when the notification is expanded. Never throws. */
  fun post(context: Context, title: String, body: String) {
    try {
      val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)
        ?: Intent(context, MainActivity::class.java).apply {
          action = Intent.ACTION_MAIN
          addCategory(Intent.CATEGORY_LAUNCHER)
        }
      launch.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
      val notificationId = (System.currentTimeMillis() % Int.MAX_VALUE).toInt()
      val notification = NotificationCompat.Builder(context, CHANNEL_ID)
        .setSmallIcon(context.applicationInfo.icon)
        .setContentTitle(title)
        .setContentText(body)
        .setStyle(NotificationCompat.BigTextStyle().bigText(body))
        .setPriority(NotificationCompat.PRIORITY_HIGH)
        .setAutoCancel(true)
        .setContentIntent(
          PendingIntent.getActivity(
            context,
            notificationId,
            launch,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
          )
        )
        .build()
      val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      manager.notify(notificationId, notification)
    } catch (e: Throwable) {
      android.util.Log.w("AIUsageAlerts", "Posting the alert failed: ${e.message}")
    }
  }
}

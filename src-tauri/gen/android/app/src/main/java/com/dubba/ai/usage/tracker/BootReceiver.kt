package com.dubba.ai.usage.tracker

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import org.json.JSONObject
import java.io.File

class BootReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    // Only BOOT_COMPLETED: the system alone may send it. Vendor "quick boot" actions
    // are not protected, so any installed app could send them to start this app.
    if (intent.action == Intent.ACTION_BOOT_COMPLETED) {
      try {
        val settingsFile = File(context.filesDir, "app-settings.json")
        if (settingsFile.exists()) {
          val json = JSONObject(settingsFile.readText())
          if (json.optBoolean("autostartEnabled", false)) {
            val launchIntent = context.packageManager.getLaunchIntentForPackage(context.packageName)?.apply {
              addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            if (launchIntent != null) {
              context.startActivity(launchIntent)
            }
          }
        }
      } catch (_: Exception) {
        // Silently ignore boot startup issues
      }
    }
  }
}

package com.yajinni.paseousagebridge

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import org.json.JSONObject
import java.io.File

class BootReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val action = intent.action
    if (action == Intent.ACTION_BOOT_COMPLETED ||
        action == "android.intent.action.QUICKBOOT_POWERON" ||
        action == "com.htc.intent.action.QUICKBOOT_POWERON") {
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

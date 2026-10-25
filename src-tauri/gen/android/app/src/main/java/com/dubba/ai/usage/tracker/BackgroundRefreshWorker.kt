package com.dubba.ai.usage.tracker

import android.content.Context
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import java.util.concurrent.TimeUnit

/**
 * Refreshes the accounts while the app is closed. WorkManager starts this about every 15
 * minutes (its minimum) when the phone has a network, and Doze may stretch that. The work
 * is done by the Rust backend (`background_refresh.rs`), so sign-in tokens, usage
 * normalization and history readings go through the same code as a refresh in the app.
 * Rust skips the run when the newest reading is younger than the refresh interval chosen
 * in Settings, and returns the alerts that fired for this class to post.
 *
 * It never reports failure: a periodic job runs again on schedule either way, and a
 * failed run only leaves the accounts as they were.
 */
class BackgroundRefreshWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
  override fun doWork(): Result {
    try {
      val alerts = nativeRefresh(CredentialVault, applicationContext.dataDir.absolutePath)
      var index = 0
      while (index + 1 < alerts.size) {
        AlertNotifications.post(applicationContext, alerts[index], alerts[index + 1])
        index += 2
      }
    } catch (e: Throwable) {
      android.util.Log.w(TAG, "Background refresh failed: ${e.message}")
    }
    return Result.success()
  }

  companion object {
    private const val TAG = "AIUsageBackground"
    private const val UNIQUE_NAME = "background-usage-refresh"
    private const val PERIOD_MINUTES = 15L
    private const val FLEX_MINUTES = 5L

    init {
      try {
        System.loadLibrary("ai_usage_tracker_lib")
      } catch (e: Throwable) {
        android.util.Log.w(TAG, "loadLibrary failed: ${e.message}")
      }
    }

    /**
     * Refreshes through the Rust backend and returns the alerts that fired as a flat
     * `[title, body, title, body, ...]` array. `vault` lets Rust reach the Keystore when
     * no activity exists; `dataDir` is the folder the app stores its data in.
     */
    @JvmStatic
    private external fun nativeRefresh(vault: CredentialVault, dataDir: String): Array<String>

    /**
     * Makes sure the periodic job exists. Keeps an existing schedule, so calling it on
     * every launch does not push the next run back.
     */
    fun schedule(context: Context) {
      try {
        val request = PeriodicWorkRequestBuilder<BackgroundRefreshWorker>(
          PERIOD_MINUTES, TimeUnit.MINUTES,
          FLEX_MINUTES, TimeUnit.MINUTES,
        )
          .setConstraints(
            Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()
          )
          .build()
        WorkManager.getInstance(context.applicationContext)
          .enqueueUniquePeriodicWork(UNIQUE_NAME, ExistingPeriodicWorkPolicy.KEEP, request)
      } catch (e: Throwable) {
        android.util.Log.w(TAG, "Scheduling the background refresh failed: ${e.message}")
      }
    }
  }
}

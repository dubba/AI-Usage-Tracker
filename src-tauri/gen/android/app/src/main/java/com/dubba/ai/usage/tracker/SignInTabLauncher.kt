package com.dubba.ai.usage.tracker

import android.app.Activity
import android.content.ComponentName
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import androidx.browser.customtabs.CustomTabColorSchemeParams
import androidx.browser.customtabs.CustomTabsCallback
import androidx.browser.customtabs.CustomTabsClient
import androidx.browser.customtabs.CustomTabsIntent
import androidx.browser.customtabs.CustomTabsServiceConnection
import androidx.browser.customtabs.CustomTabsSession
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

/**
 * Opens a provider's sign-in page in a Custom Tab over the activity and brings the activity back
 * once the sign-in has ended. [SignInTab] holds the tab's state; this class talks to the browser.
 * `MainActivity` forwards Rust's JNI calls (sign_in_tab.rs) here.
 */
internal class SignInTabLauncher(private val activity: Activity) {
  private companion object {
    /** The Custom Tabs keep-alive extra (androidx.browser has no builder method for it). */
    const val KEEP_ALIVE_EXTRA = "android.support.customtabs.extra.KEEP_ALIVE"
  }

  private val signInTab = SignInTab()
  // Bound from the JNI thread, unbound on the UI thread.
  @Volatile private var connection: CustomTabsServiceConnection? = null

  fun activityResumed() {
    signInTab.activityResumed()
  }

  /**
   * Opens a provider's sign-in page in a Custom Tab (see [SignInTab]), in the default browser
   * when it supports them, else in another browser that does. Returns the tab's number, or 0 when
   * no installed browser supports Custom Tabs or the tab did not open; Rust then uses the in-app
   * page. With [freshSession] the tab starts with no sign-ins of the browser's, where the
   * browser supports it. Called from Rust over JNI (sign_in_tab.rs), never on the UI thread.
   */
  fun open(url: String, freshSession: Boolean): Int {
    if (!SignInTab.isAllowedUrl(url)) return 0
    val browser = try {
      CustomTabsClient.getPackageName(activity, null)
    } catch (e: Exception) {
      null
    }
    if (browser == null) {
      android.util.Log.i(LOG_TAG, "No browser supports Custom Tabs; signing in in the app")
      return 0
    }
    val session = connectSession(browser)
    val opened = AtomicInteger(0)
    val latch = CountDownLatch(1)
    activity.runOnUiThread {
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
        android.util.Log.i(LOG_TAG, "Sign-in tab: fresh session requested=$freshSession used=$fresh")
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
          Intent().setClassName(activity.packageName, SignInTabKeepAliveService::class.java.name)
        )
        tab.launchUrl(activity, Uri.parse(url))
        // Still on the UI thread, so onResume cannot run before the tab counts as open.
        opened.set(signInTab.opened())
      } catch (e: Exception) {
        android.util.Log.w(LOG_TAG, "The sign-in tab did not open: ${e.javaClass.simpleName}")
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
    if (tab == 0) disconnectSession()
    return tab
  }

  private fun ephemeralSupported(browser: String): Boolean = try {
    CustomTabsClient.isEphemeralBrowsingSupported(activity, browser)
  } catch (e: Throwable) {
    false
  }

  /**
   * Binds to [browser]'s Custom Tabs service for a session, whose callback reports when the user
   * minimizes the tab. Without one (the browser has no such service, or it did not answer in
   * time), a minimized tab looks closed and cancels the sign-in.
   */
  private fun connectSession(browser: String): CustomTabsSession? {
    disconnectSession()
    val session = AtomicReference<CustomTabsSession?>(null)
    val ready = CountDownLatch(1)
    val newConnection = object : CustomTabsServiceConnection() {
      override fun onCustomTabsServiceConnected(name: ComponentName, client: CustomTabsClient) {
        session.set(client.newSession(callback))
        ready.countDown()
      }

      override fun onServiceDisconnected(name: ComponentName) {}
    }
    val bound = try {
      CustomTabsClient.bindCustomTabsService(activity, browser, newConnection)
    } catch (e: Exception) {
      false
    }
    if (!bound) return null
    synchronized(this) { connection = newConnection }
    val connected = try {
      ready.await(2, TimeUnit.SECONDS)
    } catch (_: InterruptedException) {
      false
    }
    return if (connected) session.get() else null
  }

  /** Unbinds from the browser's Custom Tabs service, if bound. */
  fun disconnectSession() {
    val bound = synchronized(this) {
      connection.also { connection = null }
    } ?: return
    try {
      activity.unbindService(bound)
    } catch (_: Exception) {
    }
  }

  private val callback = object : CustomTabsCallback() {
    override fun onNavigationEvent(navigationEvent: Int, extras: Bundle?) {
      when (navigationEvent) {
        TAB_HIDDEN -> signInTab.hidden()
        TAB_SHOWN -> signInTab.shown()
      }
    }

    override fun onMinimized(extras: Bundle) {
      android.util.Log.i(LOG_TAG, "The sign-in tab was minimized")
      signInTab.minimized()
    }

    override fun onUnminimized(extras: Bundle) {
      android.util.Log.i(LOG_TAG, "The sign-in tab was restored")
      signInTab.unminimized()
    }
  }

  /** Whether the user closed sign-in tab [tab] before the app returned over it. Reported once. */
  fun takeClosed(tab: Int): Boolean {
    val closed = signInTab.takeClosedByUser(tab)
    if (closed) activity.runOnUiThread { disconnectSession() }
    return closed
  }

  /**
   * Brings the activity back over sign-in tab [tab] once its sign-in has ended. The tab is in
   * the activity's task, above it, so restarting the activity (singleTask) finishes the tab.
   */
  fun close(tab: Int) {
    activity.runOnUiThread {
      if (!signInTab.returning(tab)) return@runOnUiThread
      disconnectSession()
      try {
        activity.startActivity(
          Intent(activity, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        )
      } catch (e: Exception) {
        android.util.Log.w(LOG_TAG, "Returning over the sign-in tab failed: ${e.javaClass.simpleName}")
      }
    }
  }
}

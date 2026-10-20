package com.dubba.ai.usage.tracker

import android.app.Service
import android.content.Intent
import android.os.Binder
import android.os.IBinder

/**
 * Bound by the browser while the sign-in Custom Tab is on screen (the Custom Tabs keep-alive
 * extra, see `openSignInTab`). Behind the tab the app is a cached process, which Android freezes
 * after about a minute, and a frozen app cannot answer the provider's redirect to its loopback
 * callback server: the tab hung on the redirect. A process whose service a visible app binds stays
 * awake. The binder does nothing; binding it only keeps the app's process running.
 */
class SignInTabKeepAliveService : Service() {
  private val binder = Binder()

  override fun onBind(intent: Intent): IBinder = binder
}

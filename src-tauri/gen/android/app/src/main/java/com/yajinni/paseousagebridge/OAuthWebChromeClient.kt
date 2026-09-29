package com.yajinni.paseousagebridge

import android.app.Dialog
import android.graphics.Color
import android.net.Uri
import android.os.Message
import android.view.KeyEvent
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient

/**
 * Google/Apple SSO for Claude (and other providers) opens a popup. On Android that
 * popup is a separate WebView, so `window.opener` is null and the provider page
 * never receives the login result — it sits on a blank/black screen.
 *
 * After Google finishes (Claude URL, about:blank, or window.close), dismiss the
 * popup and reload the host OAuth page so it can pick up the shared cookies.
 */
class OAuthWebChromeClient(activity: WryActivity) : RustWebChromeClient(activity) {
  override fun onCreateWindow(
    view: WebView,
    isDialog: Boolean,
    isUserGesture: Boolean,
    resultMsg: Message
  ): Boolean {
    val popup = WebView(view.context)
    popup.setBackgroundColor(Color.WHITE)
    popup.settings.javaScriptEnabled = true
    popup.settings.domStorageEnabled = true
    popup.settings.databaseEnabled = true
    popup.settings.javaScriptCanOpenWindowsAutomatically = true
    popup.settings.setSupportMultipleWindows(false)
    val ua = popup.settings.userAgentString.orEmpty()
    if (ua.contains("; wv")) {
      popup.settings.userAgentString = ua.replace("; wv", "")
    }
    CookieManager.getInstance().setAcceptCookie(true)
    CookieManager.getInstance().setAcceptThirdPartyCookies(popup, true)

    val dialog = Dialog(view.context, android.R.style.Theme_DeviceDefault_Light_NoActionBar)
    var sawIdentityProvider = false
    var handedBack = false

    fun hostOf(url: String): String {
      return try {
        Uri.parse(url).host.orEmpty()
      } catch (_: Exception) {
        ""
      }
    }

    fun isLoopback(url: String): Boolean {
      return url.startsWith("http://localhost") ||
        url.startsWith("http://127.0.0.1") ||
        url.startsWith("http://[::1]")
    }

    fun isIdentityProvider(url: String): Boolean {
      val host = hostOf(url)
      return host == "accounts.google.com" ||
        host.endsWith(".google.com") ||
        host == "appleid.apple.com" ||
        host.endsWith(".apple.com")
    }

    fun isProviderApp(url: String): Boolean {
      val host = hostOf(url)
      return host == "claude.ai" ||
        host.endsWith(".claude.ai") ||
        host == "anthropic.com" ||
        host.endsWith(".anthropic.com") ||
        host == "platform.claude.com" ||
        host == "auth.openai.com" ||
        host.endsWith(".openai.com")
    }

    fun handBackToHost(callbackUrl: String?) {
      if (handedBack) return
      handedBack = true
      view.post {
        if (!callbackUrl.isNullOrBlank() && isLoopback(callbackUrl)) {
          view.loadUrl(callbackUrl)
        } else {
          val hostUrl = view.url.orEmpty()
          if (hostUrl.contains("claude.ai") ||
            hostUrl.contains("anthropic.com") ||
            hostUrl.contains("openai.com")
          ) {
            view.reload()
          }
        }
        if (dialog.isShowing) {
          dialog.dismiss()
        }
      }
    }

    popup.webViewClient = object : WebViewClient() {
      override fun shouldOverrideUrlLoading(v: WebView, request: WebResourceRequest): Boolean {
        val url = request.url.toString()
        val scheme = request.url.scheme.orEmpty()
        if (scheme == "javascript" || scheme == "file" || scheme == "content") {
          return true
        }
        if (scheme == "intent" || scheme == "android-app") {
          return true
        }
        if (isIdentityProvider(url)) {
          sawIdentityProvider = true
        }
        if (isLoopback(url)) {
          handBackToHost(url)
          return true
        }
        return false
      }

      override fun onPageFinished(v: WebView, url: String) {
        if (isIdentityProvider(url)) {
          sawIdentityProvider = true
        }
        if (!sawIdentityProvider) return
        if (url == "about:blank" || url.startsWith("about:blank")) {
          handBackToHost(null)
          return
        }
        if (isProviderApp(url)) {
          handBackToHost(null)
        }
      }
    }
    popup.webChromeClient = object : WebChromeClient() {
      override fun onCloseWindow(window: WebView) {
        handBackToHost(window.url)
      }
    }

    dialog.setContentView(
      popup,
      ViewGroup.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.MATCH_PARENT
      )
    )
    dialog.setCanceledOnTouchOutside(false)
    dialog.setOnKeyListener { _, keyCode, event ->
      if (keyCode == KeyEvent.KEYCODE_BACK && event.action == KeyEvent.ACTION_UP) {
        if (popup.canGoBack()) {
          popup.goBack()
        } else {
          dialog.dismiss()
        }
        true
      } else {
        false
      }
    }
    dialog.setOnDismissListener {
      popup.destroy()
    }
    dialog.show()
    dialog.window?.setLayout(
      ViewGroup.LayoutParams.MATCH_PARENT,
      ViewGroup.LayoutParams.MATCH_PARENT
    )
    dialog.window?.decorView?.setBackgroundColor(Color.WHITE)

    val transport = resultMsg.obj as? WebView.WebViewTransport ?: return false
    transport.webView = popup
    resultMsg.sendToTarget()
    return true
  }

  override fun onCloseWindow(window: WebView) {
    // Do not destroy the main sign-in WebView.
  }
}

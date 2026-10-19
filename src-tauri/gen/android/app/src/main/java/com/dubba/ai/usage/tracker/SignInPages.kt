package com.dubba.ai.usage.tracker

import java.net.URI

/**
 * Recognizes the sign-in's "Account connected" page, so the back gesture on it returns to the
 * dashboard instead of stepping back through the login pages. Mirrors the Rust side
 * (`is_result_page` in oauth_common.rs): the `data:` page the app makes for Grok and OpenCode, or
 * the loopback redirect the OAuth callback server answers. That redirect is `/callback`,
 * `/auth/callback` or the bare origin (Google), so the path alone cannot identify it; the
 * `code` or `error` query parameter does.
 */
object SignInPages {
  private val loopbackHosts = setOf("localhost", "127.0.0.1", "::1", "[::1]")

  fun isResultPage(url: String?): Boolean {
    if (url.isNullOrBlank()) return false
    if (url.startsWith("data:text/html")) return true
    val uri = try {
      URI(url)
    } catch (_: Exception) {
      return false
    }
    if (uri.scheme?.lowercase() != "http") return false
    if (uri.host?.lowercase() !in loopbackHosts) return false
    val hasOAuthResult = uri.rawQuery.orEmpty().split('&').any {
      val key = it.substringBefore('=')
      key == "code" || key == "error"
    }
    return hasOAuthResult || uri.path.orEmpty().contains("callback")
  }
}

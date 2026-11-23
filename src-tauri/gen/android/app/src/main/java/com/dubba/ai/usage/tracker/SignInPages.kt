package com.dubba.ai.usage.tracker

import java.net.URI
import java.net.URLDecoder

/**
 * Recognizes the sign-in's "Account connected" page, so the back gesture on it returns to the
 * dashboard instead of stepping back through the login pages. The same rule as `is_result_page`
 * in src-tauri/src/auth/result_pages.rs, and both are tested against
 * src-tauri/src/auth/result_page_cases.txt: the `data:` page the app makes for Grok and OpenCode,
 * or the loopback redirect the OAuth callback server answers. That redirect is `/callback`,
 * `/auth/callback` or the bare origin (Google), so the path cannot identify it; the `code` or
 * `error` query parameter does.
 */
object SignInPages {
  fun isResultPage(url: String?): Boolean {
    if (url.isNullOrBlank()) return false
    // Rust compares this with the exact page it made; the WebView shows no other `data:` page.
    if (url.startsWith("data:text/html")) return true
    val uri = try {
      URI(url)
    } catch (_: Exception) {
      return false
    }
    if (uri.scheme?.lowercase() != "http" || uri.rawUserInfo != null) return false
    if (!isLoopbackHost(uri.host)) return false
    return uri.rawQuery.orEmpty().split('&').any {
      val key = try {
        URLDecoder.decode(it.substringBefore('='), "UTF-8")
      } catch (_: IllegalArgumentException) {
        return@any false
      }
      key == "code" || key == "error"
    }
  }

  /** `localhost`, any 127.x.x.x address, or `::1`. */
  private fun isLoopbackHost(host: String?): Boolean {
    val name = host?.lowercase()?.removePrefix("[")?.removeSuffix("]") ?: return false
    if (name == "localhost" || name == "::1" || name == "0:0:0:0:0:0:0:1") return true
    val parts = name.split('.')
    return parts.size == 4 && parts[0] == "127" &&
      parts.all { part -> part.toIntOrNull()?.let { it in 0..255 && part == it.toString() } == true }
  }
}

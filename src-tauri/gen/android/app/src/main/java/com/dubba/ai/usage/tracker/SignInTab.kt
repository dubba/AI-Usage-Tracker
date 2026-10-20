package com.dubba.ai.usage.tracker

import java.net.URI

/**
 * The sign-in Custom Tab: Claude, ChatGPT and Antigravity sign in in the browser's own tab over
 * the app, because Google refuses sign-in in embedded WebViews ("This browser or app may not be
 * secure"). The provider still redirects to the app's loopback callback server. Rust polls this
 * through MainActivity (`sign_in_tab.rs`): it brings the app back once the callback has ended the
 * sign-in, and cancels the sign-in when the user closed the tab first.
 *
 * The tab opens in the app's task, above the activity, so the activity is resumed when the tab is
 * closed, when the app returns over it, and also when the user minimizes it (Chrome's floating
 * picture-in-picture tab). The browser reports the last through the session callback, about two
 * seconds after the resume on an emulator, together with "tab hidden", which it also sends when
 * the tab closes. A resume therefore counts as a close once the tab was hidden and
 * [AFTER_HIDDEN_MS] passed without a minimize report, or, from a browser that sends neither,
 * [WITHOUT_REPORT_MS] after the resume.
 *
 * Each tab gets a number, so a sign-in that has ended can never close or cancel a newer one.
 */
class SignInTab(private val now: () -> Long = { System.nanoTime() / 1_000_000 }) {
  private var lastTab = 0
  private var tab = 0
  private var minimized = false
  private var resumedAt: Long? = null
  private var hiddenAt: Long? = null

  /** A tab was just launched. Returns its number. */
  @Synchronized
  fun opened(): Int {
    lastTab += 1
    tab = lastTab
    minimized = false
    resumedAt = null
    hiddenAt = null
    return tab
  }

  /** The browser hid the tab: closed, minimized, or left for another app. */
  @Synchronized
  fun hidden() {
    if (tab != 0) hiddenAt = now()
  }

  /** The browser showed the tab again. */
  @Synchronized
  fun shown() {
    hiddenAt = null
  }

  /** The browser minimized the tab; it is still open. */
  @Synchronized
  fun minimized() {
    if (tab == 0) return
    minimized = true
    resumedAt = null
  }

  /** The browser restored the minimized tab. */
  @Synchronized
  fun unminimized() {
    minimized = false
  }

  /** The activity is in front again. */
  @Synchronized
  fun activityResumed() {
    if (tab != 0 && !minimized) resumedAt = now()
  }

  /**
   * Whether the user closed tab [id] before the app returned over it. True once; the tab then
   * counts as gone.
   */
  @Synchronized
  fun takeClosedByUser(id: Int): Boolean {
    val resumed = resumedAt ?: return false
    if (id == 0 || id != tab || minimized) return false
    val time = now()
    val hidden = hiddenAt
    val closed = if (hidden != null) {
      time - hidden >= AFTER_HIDDEN_MS
    } else {
      time - resumed >= WITHOUT_REPORT_MS
    }
    if (!closed) return false
    tab = 0
    resumedAt = null
    hiddenAt = null
    return true
  }

  /** The app is about to bring itself back over tab [id]. False when that tab is not open. */
  @Synchronized
  fun returning(id: Int): Boolean {
    if (id == 0 || id != tab) return false
    tab = 0
    minimized = false
    resumedAt = null
    hiddenAt = null
    return true
  }

  companion object {
    /** How long after "tab hidden" a minimize report may still come. */
    const val AFTER_HIDDEN_MS = 800L

    /** How long a resume waits when the browser reports nothing about the tab. */
    const val WITHOUT_REPORT_MS = 5000L

    /**
     * Only an HTTPS page with a host and no user info opens in the tab. Rust has already checked
     * the host against the providers' sign-in hosts (`open_mobile_oauth`); this keeps any other
     * scheme (`intent:`, `javascript:`, `file:`, `content:`) out of the browser intent.
     */
    fun isAllowedUrl(url: String?): Boolean {
      if (url.isNullOrBlank() || url.length > 8192) return false
      val uri = try {
        URI(url)
      } catch (_: Exception) {
        return false
      }
      return uri.scheme == "https" && !uri.host.isNullOrEmpty() && uri.rawUserInfo == null
    }
  }
}

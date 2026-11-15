package com.dubba.ai.usage.tracker

import android.app.Activity
import android.os.Build
import android.webkit.WebView
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

/**
 * Keeps the app page's `--android-*` CSS variables equal to the system insets (status bar,
 * navigation bar, keyboard). [webView] is the current WebView, if any; [isAppShellUrl] says
 * whether a URL is the app's own page, the only page the variables are written to.
 */
internal class WebViewInsets(
  private val activity: Activity,
  private val webView: () -> WebView?,
  private val isAppShellUrl: (String?) -> Boolean
) {
  private var safeTopDp: Int = 0
  private var safeBottomDp: Int = 0
  /** The part of the bottom inset that is real buttons (back, home, recents); 0 with swipe gestures. */
  private var navButtonsDp: Int = 0
  private var safeImeDp: Int = 0

  /** Starts following the window's insets. Called once, from onCreate after enableEdgeToEdge. */
  fun install() {
    val decorView = activity.window.decorView
    ViewCompat.setOnApplyWindowInsetsListener(decorView) { _, windowInsets ->
      val statusInsets = windowInsets.getInsets(
        WindowInsetsCompat.Type.statusBars() or WindowInsetsCompat.Type.displayCutout()
      )
      val navInsets = windowInsets.getInsets(
        WindowInsetsCompat.Type.navigationBars()
      )
      val imeInsets = windowInsets.getInsets(
        WindowInsetsCompat.Type.ime()
      )
      val density = activity.resources.displayMetrics.density
      if (density > 0f) {
        val top = (statusInsets.top / density).toInt()
        val bottom = (navInsets.bottom / density).toInt()
        val ime = (imeInsets.bottom / density).toInt()
        if (top > 0) {
          safeTopDp = top
        }
        safeBottomDp = bottom
        navButtonsDp = minOf(bottom, readNavButtonsDp(windowInsets, density, bottom))
        safeImeDp = ime
        apply()
      }
      windowInsets
    }
    // enableEdgeToEdge can dispatch insets before this listener exists. Ask again
    // after the decor view is laid out, or the page keeps a 0px status-bar inset.
    decorView.post { requestInsets() }
  }

  /** Asks Android to send the insets again, which runs the listener above. */
  fun requestInsets() {
    ViewCompat.requestApplyInsets(activity.window.decorView)
  }

  /**
   * How tall the back, home and recents buttons are, in dp: 0 when the phone uses swipe gestures,
   * where the bottom inset holds only a thin handle that cannot be tapped. The page uses it to
   * keep the same gap below the labels whichever navigation the phone has. Android 11 and later
   * report it as the tappable-element inset; before that, the navigation mode setting says.
   */
  private fun readNavButtonsDp(windowInsets: WindowInsetsCompat, density: Float, navBarDp: Int): Int {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      val tappable = windowInsets.getInsets(WindowInsetsCompat.Type.tappableElement()).bottom
      return (tappable / density).toInt()
    }
    // 2 is gesture navigation; 0 (three buttons) and 1 (two buttons) have tappable buttons.
    val gestures = try {
      android.provider.Settings.Secure.getInt(activity.contentResolver, "navigation_mode", 0) == 2
    } catch (_: Exception) {
      false
    }
    return if (gestures) 0 else navBarDp
  }

  /**
   * Writes the latest insets onto the app page. The listener can run before that document
   * exists, and a load replaces the document, so this is also called once the WebView exists
   * and after a page load.
   */
  fun apply() {
    val wv = webView() ?: return
    // Provider sign-in pages do not use these variables. Skip them so this script
    // is not injected into accounts.google.com and the other login hosts.
    if (!isAppShellUrl(wv.url)) return
    wv.post {
      if (!isAppShellUrl(wv.url)) return@post
      val js = """
        (function() {
          function apply() {
            var root = document.documentElement;
            if (!root) return;
            root.style.setProperty('--android-safe-top', '${safeTopDp}px');
            root.style.setProperty('--android-safe-bottom', '${safeBottomDp}px');
            root.style.setProperty('--android-nav-buttons', '${navButtonsDp}px');
            root.style.setProperty('--android-keyboard-height', '${safeImeDp}px');
            if (${safeImeDp} > 0) {
              root.classList.add('keyboard-active');
            } else {
              root.classList.remove('keyboard-active');
            }
          }
          apply();
          document.addEventListener('DOMContentLoaded', apply, { once: true });
        })();
      """.trimIndent()
      wv.evaluateJavascript(js, null)
    }
  }
}

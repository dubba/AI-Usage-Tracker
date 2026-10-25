use super::*;

pub(super) fn patch_android_webview_templates(manifest_dir: &Path) {
    let generated =
        manifest_dir.join("gen/android/app/src/main/java/com/dubba/ai/usage/tracker/generated");
    patch_file(&generated.join("RustWebView.kt"), |content| {
        webview_ipc_patch::patch_rust_webview_ipc(&patch_rust_webview(content))
    });
    patch_file(&generated.join("Ipc.kt"), webview_ipc_patch::patch_ipc);
    patch_file(
        &generated.join("RustWebChromeClient.kt"),
        patch_chrome_client,
    );
    patch_file(
        &generated.join("RustWebViewClient.kt"),
        patch_webview_client,
    );

    // The patches above do nothing when the Tauri CLI regenerates templates in a shape they do not
    // recognize. A silent miss would ship the origin-blind IPC interface, so an Android build (the
    // one that compiles this Kotlin) stops here; other targets only warn, because their copy of the
    // generated folder may be stale or absent.
    let still_legacy = fs::read_to_string(generated.join("Ipc.kt"))
        .is_ok_and(|content| content.contains("webViewClient.currentUrl"));
    let listener_missing = fs::read_to_string(generated.join("RustWebView.kt"))
        .is_ok_and(|content| !content.contains("installIpcListener()"));
    if still_legacy || listener_missing {
        let message = "The Android IPC origin patch did not apply to the generated Kotlin; IPC \
                       would trust the last navigation URL. Update src-tauri/webview_ipc_patch.rs.";
        if env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("android") {
            panic!("{message}");
        }
        println!("cargo:warning={message}");
    }
}

pub(super) fn patch_file(path: &PathBuf, patch: impl Fn(&str) -> String) {
    let Ok(content) = fs::read_to_string(path) else {
        return;
    };
    let patched = patch(&content);
    if patched != content {
        let _ = fs::write(path, patched);
    }
}

pub(super) fn patch_rust_webview(content: &str) -> String {
    let mut patched = content.replace(
        "return cookieManager.getCookie(url)\n",
        "return cookieManager.getCookie(url) ?: \"\"\n",
    );
    if !patched.contains("setSupportMultipleWindows(true)")
        && patched.contains("settings.javaScriptCanOpenWindowsAutomatically = true")
    {
        patched = patched.replace(
            "settings.javaScriptCanOpenWindowsAutomatically = true",
            "settings.javaScriptCanOpenWindowsAutomatically = true\n        settings.setSupportMultipleWindows(true)\n        CookieManager.getInstance().setAcceptCookie(true)\n        CookieManager.getInstance().setAcceptThirdPartyCookies(this, true)",
        );
    }
    if !patched.contains("replace(\"; wv\"")
        && patched.contains("settings.javaScriptCanOpenWindowsAutomatically = true")
    {
        patched = patched.replace(
            "settings.javaScriptCanOpenWindowsAutomatically = true",
            "settings.javaScriptCanOpenWindowsAutomatically = true\n        val defaultUa = settings.userAgentString ?: \"\"\n        if (defaultUa.contains(\"; wv\")) {\n            settings.userAgentString = defaultUa.replace(\"; wv\", \"\")\n        }",
        );
    }
    patched = patched.replace(
        "WebViewCompat.addDocumentStartJavaScript(this, script, setOf(\"*\"))\n            WebViewCompat.addDocumentStartJavaScript(this, \"try{const c=navigator.credentials;if(c&&c.get){const o=c.get.bind(c);c.get=function(opts){if(opts&&opts.identity){return Promise.reject(new DOMException('FedCM unavailable','NotSupportedError'));}return o(opts);};}}catch(e){}\", setOf(\"*\"))\n            }",
        "WebViewCompat.addDocumentStartJavaScript(this, script, setOf(\"*\"))\n            }\n            WebViewCompat.addDocumentStartJavaScript(this, \"try{const c=navigator.credentials;if(c&&c.get){const o=c.get.bind(c);c.get=function(opts){if(opts&&opts.identity){return Promise.reject(new DOMException('FedCM unavailable','NotSupportedError'));}return o(opts);};}}catch(e){}\", setOf(\"*\"))",
    );
    if !patched.contains("FedCM unavailable") {
        let loop_end = "                WebViewCompat.addDocumentStartJavaScript(this, script, setOf(\"*\"));\n            }";
        if patched.contains(loop_end) {
            patched = patched.replace(
                loop_end,
                "                WebViewCompat.addDocumentStartJavaScript(this, script, setOf(\"*\"));\n            }\n            WebViewCompat.addDocumentStartJavaScript(this, \"try{const c=navigator.credentials;if(c&&c.get){const o=c.get.bind(c);c.get=function(opts){if(opts&&opts.identity){return Promise.reject(new DOMException('FedCM unavailable','NotSupportedError'));}return o(opts);};}}catch(e){}\", setOf(\"*\"))",
            );
        }
    }
    patched
}

/// Accepts a sign-in reply only when the host is exactly localhost or
/// 127.0.0.1. A prefix check treated http://localhost.evil.com as local and
/// loaded it in the main view. The `http://` prefix keeps the same plain-http
/// addresses that already counted as local, including ports and paths, and
/// rejects a userinfo trick such as http://localhost@evil.com.
pub(super) const LOOPBACK_FN: &str = r#"      private fun isLoopback(url: String): Boolean {
        val uri = android.net.Uri.parse(url)
        val host = uri.host ?: return false
        if (host != "localhost" && host != "127.0.0.1") return false
        return url.startsWith("http://$host")
      }"#;

pub(super) const OLD_LOOPBACK_FN: &str = r#"      private fun isLoopback(url: String): Boolean {
        return url.startsWith("http://localhost") || url.startsWith("http://127.0.0.1")
      }"#;

pub(super) fn oauth_popup_window_methods() -> String {
    r#"  // Visible popup WebView so provider Google/Apple SSO can finish without
  // destroying the host sign-in page that is waiting for the popup result.
  override fun onCreateWindow(
      view: WebView,
      isDialog: Boolean,
      isUserGesture: Boolean,
      resultMsg: android.os.Message
  ): Boolean {
    val popup = WebView(view.context)
    popup.settings.javaScriptEnabled = true
    popup.settings.domStorageEnabled = true
    popup.settings.databaseEnabled = true
    popup.settings.javaScriptCanOpenWindowsAutomatically = true
    popup.settings.setSupportMultipleWindows(false)
    val ua = popup.settings.userAgentString ?: ""
    if (ua.contains("; wv")) {
      popup.settings.userAgentString = ua.replace("; wv", "")
    }
    CookieManager.getInstance().setAcceptCookie(true)
    CookieManager.getInstance().setAcceptThirdPartyCookies(popup, true)

    // Same DOM-API button as mobile_auth.rs. Google's account page rejects
    // innerHTML under Trusted Types and drops nodes it did not create.
    val signInBackButtonJs = """
      (() => {
        try {
          if (window.top !== window.self) return;
          const root = document.documentElement;
          if (!root) return;
          const offset = 'calc(max(env(safe-area-inset-top, 0px), 28px) + 44px)';
          const headerId = '__ai_tracker_header';
          const buttonId = '__ai_tracker_back';
          const getBg = () => {
            try {
              const parse = (c) => (c && c !== 'transparent' && c !== 'rgba(0, 0, 0, 0)') ? c : null;
              const bodyBg = document.body && parse(window.getComputedStyle(document.body).backgroundColor);
              if (bodyBg) return bodyBg;
              const rootBg = parse(window.getComputedStyle(root).backgroundColor);
              if (rootBg) return rootBg;
            } catch (e) {}
            return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? '#131314' : '#ffffff';
          };
          const install = () => {
            const docEl = document.documentElement;
            if (!docEl) return;
            if (docEl.style.getPropertyValue('padding-top') !== offset) {
              docEl.style.setProperty('box-sizing', 'border-box', 'important');
              docEl.style.setProperty('padding-top', offset, 'important');
            }
            if (document.body && document.body.style.boxSizing !== 'border-box') {
              document.body.style.setProperty('box-sizing', 'border-box', 'important');
            }
            let header = document.getElementById(headerId);
            if (!header) {
              header = document.createElement('div');
              header.id = headerId;
              header.setAttribute('aria-hidden', 'true');
              docEl.appendChild(header);
            }
            header.style.cssText = [
              'position:fixed', 'top:0', 'left:0', 'right:0', 'width:100%',
              'height:' + offset, 'z-index:2147483646', 'background:' + getBg(),
              'pointer-events:none',
            ].join(';');

            if (document.getElementById(buttonId)) return;
            const button = document.createElement('button');
            button.id = buttonId;
            button.type = 'button';
            button.setAttribute('aria-label', 'Back to AI Usage Tracker');
            button.style.cssText = [
              'position:fixed', 'top:max(env(safe-area-inset-top, 0px), 28px)', 'left:8px', 'z-index:2147483647',
              'display:inline-flex', 'align-items:center', 'gap:7px',
              'padding:8px 16px 8px 11px', 'border:0', 'border-radius:999px', 'background:#6d3bd7', 'color:#fff',
              'font:700 15px -apple-system,system-ui,sans-serif', 'line-height:1', 'box-shadow:0 2px 10px rgba(0,0,0,.4)',
            ].join(';');
            const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            svg.setAttribute('viewBox', '0 0 24 24');
            svg.setAttribute('width', '10');
            svg.setAttribute('height', '16');
            svg.setAttribute('fill', 'none');
            svg.setAttribute('stroke', 'currentColor');
            svg.setAttribute('stroke-width', '2.6');
            svg.setAttribute('stroke-linecap', 'round');
            svg.setAttribute('stroke-linejoin', 'round');
            svg.setAttribute('aria-hidden', 'true');
            svg.style.display = 'block';
            svg.style.flex = 'none';
            const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            path.setAttribute('d', 'm15 18-6-6 6-6');
            svg.appendChild(path);
            const label = document.createElement('span');
            label.textContent = 'Back to AI Usage Tracker';
            button.appendChild(svg);
            button.appendChild(label);
            button.addEventListener('click', (event) => {
              event.preventDefault();
              event.stopPropagation();
              location.hash = 'ai-usage-tracker-back';
            }, true);
            docEl.appendChild(button);
          };
          install();
          if (window.__aiTrackerBackRoot !== root) {
            window.__aiTrackerBackRoot = root;
            new MutationObserver(install).observe(root, { childList: true });
          }
        } catch (e) {}
      })();
    """.trimIndent()
    if (androidx.webkit.WebViewFeature.isFeatureSupported(androidx.webkit.WebViewFeature.DOCUMENT_START_SCRIPT)) {
      androidx.webkit.WebViewCompat.addDocumentStartJavaScript(popup, signInBackButtonJs, setOf("*"))
    }

    val dialog = android.app.Dialog(view.context, android.R.style.Theme_DeviceDefault_NoActionBar)
    popup.webViewClient = object : WebViewClient() {
@@LOOPBACK@@
      private var leavingToApp = false
      private fun isSignInBack(url: String): Boolean {
        val uri = android.net.Uri.parse(url)
        return uri.fragment == "ai-usage-tracker-back"
      }
      private fun leaveSignInToApp() {
        if (leavingToApp) return
        leavingToApp = true
        dialog.dismiss()
        view.post {
          val hostUrl = view.url ?: return@post
          val scheme = android.net.Uri.parse(hostUrl).scheme ?: return@post
          if (scheme == "javascript" || scheme == "file" || scheme == "content") return@post
          if (isSignInBack(hostUrl)) return@post
          view.evaluateJavascript(
            "(function(){try{location.hash='ai-usage-tracker-back';}catch(e){}})();",
            null
          )
        }
      }
      override fun onPageFinished(v: WebView, url: String) {
        if (isSignInBack(url)) {
          leaveSignInToApp()
          return
        }
        v.evaluateJavascript(signInBackButtonJs, null)
      }
      override fun doUpdateVisitedHistory(v: WebView, url: String, isReload: Boolean) {
        if (isSignInBack(url)) {
          leaveSignInToApp()
        }
      }
      override fun shouldOverrideUrlLoading(v: WebView, request: WebResourceRequest): Boolean {
        val url = request.url.toString()
        val scheme = request.url.scheme ?: ""
        if (scheme == "javascript" || scheme == "file" || scheme == "content") {
          return true
        }
        if (isSignInBack(url)) {
          leaveSignInToApp()
          return true
        }
        if (isLoopback(url)) {
          view.post { view.loadUrl(url) }
          dialog.dismiss()
          return true
        }
        return false
      }
    }
    popup.webChromeClient = object : WebChromeClient() {
      override fun onCloseWindow(window: WebView) {
        dialog.dismiss()
      }
    }
    dialog.setContentView(
      popup,
      android.view.ViewGroup.LayoutParams(
        android.view.ViewGroup.LayoutParams.MATCH_PARENT,
        android.view.ViewGroup.LayoutParams.MATCH_PARENT
      )
    )
    dialog.setCanceledOnTouchOutside(false)
    dialog.setOnKeyListener { _, keyCode, event ->
      if (keyCode == android.view.KeyEvent.KEYCODE_BACK && event.action == android.view.KeyEvent.ACTION_UP) {
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
      android.view.ViewGroup.LayoutParams.MATCH_PARENT,
      android.view.ViewGroup.LayoutParams.MATCH_PARENT
    )

    val transport = resultMsg.obj as? WebView.WebViewTransport ?: return false
    transport.webView = popup
    resultMsg.sendToTarget()
    return true
  }

  // This client belongs to the app's only WebView (popups above have their own). A page in it
  // that calls window.close() must not take the app with it: the sign-in's "Account connected"
  // page does when its countdown ends, and destroying the WebView froze the app on "1".
  // Rust returns the WebView to the dashboard (mobile_auth.rs).
  override fun onCloseWindow(window: WebView) {
    android.util.Log.i("AIUsageSignIn", "Ignored window.close() from the app WebView")
  }
}"#
    .replace("@@LOOPBACK@@", LOOPBACK_FN)
}

pub(super) fn patch_chrome_client(content: &str) -> String {
    // A file patched by an older build still has the prefix check. Replace it
    // even when the popup methods are already present, or the early return
    // below would leave the lookalike host in place.
    let patched = content.replace(OLD_LOOPBACK_FN, LOOPBACK_FN);
    const POPUP_MARKER: &str =
        "  // Visible popup WebView so provider Google/Apple SSO can finish without";
    let methods = oauth_popup_window_methods();
    if let Some(start) = patched.find(POPUP_MARKER) {
        return format!("{}{}", &patched[..start], methods);
    }
    let title_hook = r#"  override fun onReceivedTitle(
      view: WebView,
      title: String
  ) {
    Rust.handleReceivedTitle((view as RustWebView).id, title)
  }
}"#;
    if patched.contains("override fun onCreateWindow") {
        if let Some(start) = patched.find("  override fun onCreateWindow") {
            return format!("{}{}", &patched[..start], methods);
        }
    }
    if patched.contains(title_hook) {
        patched.replace(
            title_hook,
            &format!(
                "  override fun onReceivedTitle(\n      view: WebView,\n      title: String\n  ) {{\n    Rust.handleReceivedTitle((view as RustWebView).id, title)\n  }}\n\n{methods}"
            ),
        )
    } else {
        patched
    }
}

pub(super) fn patch_webview_client(content: &str) -> String {
    let patched = if content.contains("browser_fallback_url") {
        content.to_string()
    } else {
        patch_webview_client_navigation(content)
    };
    patch_webview_client_insets(&patched)
}

/// The inset listener often runs before the document exists, and a navigation
/// drops the CSS variables it wrote. Reapply them once the page has loaded.
fn patch_webview_client_insets(content: &str) -> String {
    if content.contains("reapplyWindowInsetsFrom(view)") {
        return content.to_string();
    }
    let needle = "        Rust.onPageLoaded((view as RustWebView).id, url)\n";
    if !content.contains(needle) {
        return content.to_string();
    }
    content.replacen(
        needle,
        "        Rust.onPageLoaded((view as RustWebView).id, url)\n        reapplyWindowInsetsFrom(view)\n",
        1,
    )
}

fn patch_webview_client_navigation(content: &str) -> String {
    let mut patched = content.to_string();
    if !patched.contains("import android.content.Intent") {
        patched = patched.replace(
            "import android.content.Context",
            "import android.content.Context\nimport android.content.Intent",
        );
    }
    patched = patched.replace(
        r#"    override fun shouldOverrideUrlLoading(
        view: WebView,
        request: WebResourceRequest
    ): Boolean {
        return Rust.shouldOverride((view as RustWebView).id, request.url.toString())
    }"#,
        r#"    override fun shouldOverrideUrlLoading(
        view: WebView,
        request: WebResourceRequest
    ): Boolean {
        val uri = request.url
        val scheme = uri.scheme ?: ""
        if (scheme == "intent" || scheme == "android-app") {
            try {
                val intent = Intent.parseUri(uri.toString(), Intent.URI_INTENT_SCHEME)
                val fallback = intent.getStringExtra("browser_fallback_url")
                // Only load HTTPS fallbacks. A javascript:/file: fallback would run
                // arbitrary script inside the WebView (universal XSS).
                if (!fallback.isNullOrBlank() && fallback.startsWith("https://")) {
                    view.loadUrl(fallback)
                    return true
                }
            } catch (_: Exception) {
            }
            return true
        }
        return Rust.shouldOverride((view as RustWebView).id, uri.toString())
    }"#,
    );
    patched
}

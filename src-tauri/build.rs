use base64::{engine::general_purpose::STANDARD, Engine};
use image::{imageops::FilterType, ImageFormat};
use std::{env, fs, io::Cursor, path::PathBuf};

const WINDOWS_ICON_SIZES: [u32; 9] = [16, 20, 24, 32, 40, 48, 64, 128, 256];

fn encode_png(source: &image::DynamicImage, size: u32) -> Vec<u8> {
    let resized = source.resize_exact(size, size, FilterType::Lanczos3);
    let mut png_cursor = Cursor::new(Vec::new());
    resized
        .write_to(&mut png_cursor, ImageFormat::Png)
        .expect("native icon PNG must be encodable");
    png_cursor.into_inner()
}

fn write_windows_icon(icon_dir: &PathBuf, image: &image::DynamicImage) {
    let images: Vec<(u32, Vec<u8>)> = WINDOWS_ICON_SIZES
        .into_iter()
        .map(|size| (size, encode_png(image, size)))
        .collect();

    let directory_size = 6 + images.len() * 16;
    let image_bytes = images.iter().map(|(_, png)| png.len()).sum::<usize>();
    let mut ico = Vec::with_capacity(directory_size + image_bytes);
    ico.extend_from_slice(&0_u16.to_le_bytes());
    ico.extend_from_slice(&1_u16.to_le_bytes());
    ico.extend_from_slice(&(images.len() as u16).to_le_bytes());

    let mut offset = directory_size as u32;
    for (size, png) in &images {
        let dimension = if *size == 256 { 0 } else { *size as u8 };
        ico.push(dimension);
        ico.push(dimension);
        ico.push(0);
        ico.push(0);
        ico.extend_from_slice(&1_u16.to_le_bytes());
        ico.extend_from_slice(&32_u16.to_le_bytes());
        ico.extend_from_slice(&(png.len() as u32).to_le_bytes());
        ico.extend_from_slice(&offset.to_le_bytes());
        offset += png.len() as u32;
    }

    for (_, png) in images {
        ico.extend_from_slice(&png);
    }

    fs::write(icon_dir.join("icon.ico"), ico)
        .expect("Windows application icon must be writable during the build");
}

fn write_macos_icon(icon_dir: &PathBuf, image: &image::DynamicImage) {
    let entries: [(&[u8], u32); 6] = [
        (b"icp4", 16),
        (b"icp5", 32),
        (b"icp6", 64),
        (b"ic07", 128),
        (b"ic08", 256),
        (b"ic09", 512),
    ];

    let mut body = Vec::new();
    for (tag, size) in entries {
        let png = encode_png(image, size);
        let entry_len = 8_u32 + png.len() as u32;
        body.extend_from_slice(tag);
        body.extend_from_slice(&entry_len.to_be_bytes());
        body.extend_from_slice(&png);
    }

    let total_len = 8_u32 + body.len() as u32;
    let mut icns = Vec::with_capacity(total_len as usize);
    icns.extend_from_slice(b"icns");
    icns.extend_from_slice(&total_len.to_be_bytes());
    icns.extend_from_slice(&body);

    fs::write(icon_dir.join("icon.icns"), icns)
        .expect("macOS application icon must be writable during the build");
}

fn main() {
    println!("cargo:rerun-if-changed=icons/app-icon.b64");
    println!("cargo:rerun-if-changed=tauri.conf.json");
    println!("cargo:rerun-if-changed=../dist");

    let icon_bytes = STANDARD
        .decode(include_str!("icons/app-icon.b64").trim())
        .expect("embedded application icon must be valid base64");
    let manifest_dir = PathBuf::from(
        env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR must be available"),
    );
    let icon_dir = manifest_dir.join("icons");

    let image = image::load_from_memory_with_format(&icon_bytes, ImageFormat::Png)
        .expect("embedded application icon must be a valid PNG");

    fs::write(icon_dir.join("icon.png"), encode_png(&image, 128))
        .expect("application icon must be writable during the build");
    fs::write(icon_dir.join("32x32.png"), encode_png(&image, 32))
        .expect("32x32 icon must be writable during the build");
    fs::write(icon_dir.join("128x128.png"), encode_png(&image, 128))
        .expect("128x128 icon must be writable during the build");
    fs::write(icon_dir.join("128x128@2x.png"), encode_png(&image, 256))
        .expect("128x128@2x icon must be writable during the build");

    write_windows_icon(&icon_dir, &image);
    write_macos_icon(&icon_dir, &image);

    tauri_build::build();
    patch_android_webview_templates(&manifest_dir);
}

fn patch_android_webview_templates(manifest_dir: &PathBuf) {
    let generated = manifest_dir.join("gen/android/app/src/main/java/com/yajinni/paseousagebridge/generated");
    patch_file(&generated.join("RustWebView.kt"), patch_rust_webview);
    patch_file(&generated.join("RustWebChromeClient.kt"), patch_chrome_client);
    patch_file(&generated.join("RustWebViewClient.kt"), patch_webview_client);
}

fn patch_file(path: &PathBuf, patch: fn(&str) -> String) {
    let Ok(content) = fs::read_to_string(path) else {
        return;
    };
    let patched = patch(&content);
    if patched != content {
        let _ = fs::write(path, patched);
    }
}

fn patch_rust_webview(content: &str) -> String {
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
    patched
}

fn patch_chrome_client(content: &str) -> String {
    if content.contains("override fun onCreateWindow") {
        return content.to_string();
    }
    let hook = r#"  override fun onReceivedTitle(
      view: WebView,
      title: String
  ) {
    Rust.handleReceivedTitle((view as RustWebView).id, title)
  }
}"#;
    let replacement = r#"  override fun onReceivedTitle(
      view: WebView,
      title: String
  ) {
    Rust.handleReceivedTitle((view as RustWebView).id, title)
  }

  override fun onCreateWindow(
      view: WebView,
      isDialog: Boolean,
      isUserGesture: Boolean,
      resultMsg: android.os.Message
  ): Boolean {
    val extra = view.hitTestResult.extra
    if (!extra.isNullOrBlank() && (extra.startsWith("http://") || extra.startsWith("https://"))) {
      view.post { view.loadUrl(extra) }
      return false
    }
    val temp = WebView(view.context)
    temp.settings.javaScriptEnabled = true
    temp.webViewClient = object : WebViewClient() {
      private fun hijack(url: String?) {
        if (url.isNullOrBlank() || url == "about:blank") return
        // Never load javascript:, file:, content:, or other non-web schemes
        // into the host WebView — that would allow universal XSS.
        if (!url.startsWith("https://")) return
        view.post { view.loadUrl(url) }
      }
      override fun shouldOverrideUrlLoading(v: WebView, request: WebResourceRequest): Boolean {
        hijack(request.url.toString())
        return true
      }
      override fun onPageStarted(v: WebView, url: String, favicon: android.graphics.Bitmap?) {
        hijack(url)
      }
    }
    val transport = resultMsg.obj as? WebView.WebViewTransport ?: return false
    transport.webView = temp
    resultMsg.sendToTarget()
    return true
  }

  override fun onCloseWindow(window: WebView) {
    window.destroy()
  }
}"#;
    if content.contains(hook) {
        content.replace(hook, replacement)
    } else {
        content.to_string()
    }
}

fn patch_webview_client(content: &str) -> String {
    if content.contains("browser_fallback_url") {
        return content.to_string();
    }
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

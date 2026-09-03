use base64::{engine::general_purpose::STANDARD, Engine};
use image::{imageops::FilterType, ImageFormat};
use std::{env, fs, io::Cursor, path::PathBuf};

const WINDOWS_ICON_SIZES: [u32; 9] = [16, 20, 24, 32, 40, 48, 64, 128, 256];

fn write_file_if_changed<P: AsRef<std::path::Path>>(path: P, data: &[u8]) {
    let path = path.as_ref();
    if let Ok(existing) = fs::read(path) {
        if existing == data {
            return;
        }
    }
    fs::write(path, data).unwrap_or_else(|err| {
        panic!("failed to write {}: {}", path.display(), err);
    });
}

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

    write_file_if_changed(icon_dir.join("icon.ico"), &ico);
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

    write_file_if_changed(icon_dir.join("icon.icns"), &icns);
}

const ANDROID_MIPMAP_SIZES: [(&str, u32, u32); 5] = [
    ("mipmap-mdpi", 48, 108),
    ("mipmap-hdpi", 72, 162),
    ("mipmap-xhdpi", 96, 216),
    ("mipmap-xxhdpi", 144, 324),
    ("mipmap-xxxhdpi", 192, 432),
];

fn write_android_icons(manifest_dir: &PathBuf, image: &image::DynamicImage) {
    let res_dir = manifest_dir.join("gen/android/app/src/main/res");
    if !res_dir.exists() {
        return;
    }

    for (dir_name, launcher_size, foreground_size) in ANDROID_MIPMAP_SIZES {
        let dir = res_dir.join(dir_name);
        let _ = fs::create_dir_all(&dir);

        let launcher_png = encode_png(image, launcher_size);
        write_file_if_changed(dir.join("ic_launcher.png"), &launcher_png);
        write_file_if_changed(dir.join("ic_launcher_round.png"), &launcher_png);

        let foreground_png = encode_png(image, foreground_size);
        write_file_if_changed(dir.join("ic_launcher_foreground.png"), &foreground_png);
    }

    let anydpi_dir = res_dir.join("mipmap-anydpi-v26");
    let _ = fs::create_dir_all(&anydpi_dir);

    let adaptive_xml = r#"<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background"/>
    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>
</adaptive-icon>
"#;

    write_file_if_changed(anydpi_dir.join("ic_launcher.xml"), adaptive_xml.as_bytes());
    write_file_if_changed(anydpi_dir.join("ic_launcher_round.xml"), adaptive_xml.as_bytes());
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

    write_file_if_changed(icon_dir.join("icon.png"), &encode_png(&image, 128));
    write_file_if_changed(icon_dir.join("32x32.png"), &encode_png(&image, 32));
    write_file_if_changed(icon_dir.join("128x128.png"), &encode_png(&image, 128));
    write_file_if_changed(icon_dir.join("128x128@2x.png"), &encode_png(&image, 256));

    write_windows_icon(&icon_dir, &image);
    write_macos_icon(&icon_dir, &image);
    write_android_icons(&manifest_dir, &image);

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

fn oauth_popup_window_methods() -> &'static str {
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

    val dialog = android.app.Dialog(view.context, android.R.style.Theme_DeviceDefault_NoActionBar)
    popup.webViewClient = object : WebViewClient() {
      private fun isLoopback(url: String): Boolean {
        return url.startsWith("http://localhost") || url.startsWith("http://127.0.0.1")
      }
      override fun shouldOverrideUrlLoading(v: WebView, request: WebResourceRequest): Boolean {
        val url = request.url.toString()
        val scheme = request.url.scheme ?: ""
        if (scheme == "javascript" || scheme == "file" || scheme == "content") {
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

  override fun onCloseWindow(window: WebView) {
    window.destroy()
  }
}"#
}

fn patch_chrome_client(content: &str) -> String {
    if content.contains("Visible popup WebView so provider Google/Apple") {
        return content.to_string();
    }
    let methods = oauth_popup_window_methods();
    let title_hook = r#"  override fun onReceivedTitle(
      view: WebView,
      title: String
  ) {
    Rust.handleReceivedTitle((view as RustWebView).id, title)
  }
}"#;
    if content.contains("override fun onCreateWindow") {
        if let Some(start) = content.find("  override fun onCreateWindow") {
            return format!("{}{}", &content[..start], methods);
        }
    }
    if content.contains(title_hook) {
        content.replace(
            title_hook,
            &format!(
                "  override fun onReceivedTitle(\n      view: WebView,\n      title: String\n  ) {{\n    Rust.handleReceivedTitle((view as RustWebView).id, title)\n  }}\n\n{methods}"
            ),
        )
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

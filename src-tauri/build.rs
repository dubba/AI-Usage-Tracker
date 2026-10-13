use image::ImageFormat;
use resvg::{tiny_skia, usvg};
use std::{
    env, fs,
    io::Cursor,
    path::{Path, PathBuf},
};

// Kotlin patches for origin-safe Android IPC. A separate file so `cargo test` can cover them
// (see the matching `#[path]` module in `src/lib.rs`).
#[path = "webview_ipc_patch.rs"]
mod webview_ipc_patch;

const WINDOWS_ICON_SIZES: [u32; 9] = [16, 20, 24, 32, 40, 48, 64, 128, 256];

/// The app icon: a full-bleed square that every platform's icon files are rendered from.
/// iOS and Android cut their own shape out of it; Windows and macOS get a rounded frame.
const ICON_SVG: &str = include_str!("icons/icon.svg");

/// The icon's base color, which also fills the Android adaptive icon background
/// (`ic_launcher_background` in `colors.xml`).
const ICON_BACKGROUND: [u8; 3] = [0x0e, 0x0f, 0x1a];

/// The rounded Windows and macOS frame, as fractions of the icon's side.
const DESKTOP_CORNER_RADIUS: f32 = 115.0 / 512.0;
const DESKTOP_BORDER_WIDTH: f32 = 3.0 / 512.0;

/// Apple's macOS grid: an 824-pixel rounded square centered on a 1024-pixel canvas.
const MACOS_ICON_SCALE: f32 = 824.0 / 1024.0;

/// Launchers show the middle 72dp of the 108dp adaptive foreground, and only promise a 66dp
/// circle of it. At 80dp the gauge's outer ring (radius 175.5 of 512) sits well inside that
/// circle, about as large as on iOS, while the square's edges stay outside the 72dp view.
const ANDROID_FOREGROUND_SCALE: f32 = 80.0 / 108.0;

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

fn parse_icon() -> usvg::Tree {
    usvg::Tree::from_str(ICON_SVG, &usvg::Options::default())
        .expect("icons/icon.svg must be a valid SVG")
}

/// Renders the icon `art` pixels wide, centered on a transparent `canvas`-pixel square.
fn render_icon(icon: &usvg::Tree, canvas: u32, art: f32) -> tiny_skia::Pixmap {
    let mut pixmap = tiny_skia::Pixmap::new(canvas, canvas).expect("icon size must be non-zero");
    let scale = art / icon.size().width();
    let offset = (canvas as f32 - art) / 2.0;
    let transform = tiny_skia::Transform::from_row(scale, 0.0, 0.0, scale, offset, offset);
    resvg::render(icon, transform, &mut pixmap.as_mut());
    pixmap
}

/// A square with circular corners, drawn with the usual cubic approximation of a quarter circle.
fn rounded_square(x: f32, y: f32, side: f32, radius: f32) -> tiny_skia::Path {
    const KAPPA: f32 = 0.552_284_8;
    let (r, c) = (radius, radius * (1.0 - KAPPA));
    let (right, bottom) = (x + side, y + side);
    let mut path = tiny_skia::PathBuilder::new();
    path.move_to(x + r, y);
    path.line_to(right - r, y);
    path.cubic_to(right - c, y, right, y + c, right, y + r);
    path.line_to(right, bottom - r);
    path.cubic_to(right, bottom - c, right - c, bottom, right - r, bottom);
    path.line_to(x + r, bottom);
    path.cubic_to(x + c, bottom, x, bottom - c, x, bottom - r);
    path.line_to(x, y + r);
    path.cubic_to(x, y + c, x + c, y, x + r, y);
    path.close();
    path.finish().expect("rounded square path must be valid")
}

/// The Windows and macOS icon: the square with rounded corners and a thin gradient border.
fn render_desktop_icon(icon: &usvg::Tree, canvas: u32, art: f32) -> tiny_skia::Pixmap {
    let mut pixmap = render_icon(icon, canvas, art);
    let offset = (canvas as f32 - art) / 2.0;
    let radius = art * DESKTOP_CORNER_RADIUS;

    let mut mask = tiny_skia::Mask::new(canvas, canvas).expect("icon size must be non-zero");
    mask.fill_path(
        &rounded_square(offset, offset, art, radius),
        tiny_skia::FillRule::Winding,
        true,
        tiny_skia::Transform::identity(),
    );
    pixmap.apply_mask(&mask);

    let width = art * DESKTOP_BORDER_WIDTH;
    let inset = width / 2.0;
    let border = rounded_square(offset + inset, offset + inset, art - width, radius - inset);
    let shader = tiny_skia::LinearGradient::new(
        tiny_skia::Point::from_xy(offset, offset),
        tiny_skia::Point::from_xy(offset + art, offset + art),
        vec![
            tiny_skia::GradientStop::new(0.0, tiny_skia::Color::from_rgba8(0x4a, 0x4d, 0x75, 230)),
            tiny_skia::GradientStop::new(1.0, tiny_skia::Color::from_rgba8(0x1a, 0x1b, 0x2e, 77)),
        ],
        tiny_skia::SpreadMode::Pad,
        tiny_skia::Transform::identity(),
    )
    .expect("border gradient must be valid");
    let paint = tiny_skia::Paint {
        shader,
        anti_alias: true,
        ..Default::default()
    };
    let stroke = tiny_skia::Stroke {
        width,
        ..Default::default()
    };
    pixmap.stroke_path(
        &border,
        &paint,
        &stroke,
        tiny_skia::Transform::identity(),
        None,
    );
    pixmap
}

fn encode_image(image: image::DynamicImage) -> Vec<u8> {
    let mut png_cursor = Cursor::new(Vec::new());
    image
        .write_to(&mut png_cursor, ImageFormat::Png)
        .expect("native icon PNG must be encodable");
    png_cursor.into_inner()
}

fn encode_png(pixmap: &tiny_skia::Pixmap) -> Vec<u8> {
    let rgba = pixmap
        .pixels()
        .iter()
        .flat_map(|pixel| {
            let color = pixel.demultiply();
            [color.red(), color.green(), color.blue(), color.alpha()]
        })
        .collect();
    let image = image::RgbaImage::from_raw(pixmap.width(), pixmap.height(), rgba)
        .expect("pixmap must hold width * height pixels");
    encode_image(image.into())
}

/// iOS icons must have no alpha channel, so the canvas is filled with the base color first.
fn encode_opaque_png(icon: &usvg::Tree, size: u32) -> Vec<u8> {
    let [red, green, blue] = ICON_BACKGROUND;
    let mut pixmap = tiny_skia::Pixmap::new(size, size).expect("icon size must be non-zero");
    pixmap.fill(tiny_skia::Color::from_rgba8(red, green, blue, 255));
    let scale = size as f32 / icon.size().width();
    resvg::render(
        icon,
        tiny_skia::Transform::from_scale(scale, scale),
        &mut pixmap.as_mut(),
    );
    let rgb = pixmap
        .pixels()
        .iter()
        .flat_map(|pixel| [pixel.red(), pixel.green(), pixel.blue()])
        .collect();
    let image =
        image::RgbImage::from_raw(size, size, rgb).expect("pixmap must hold width * height pixels");
    encode_image(image.into())
}

fn write_windows_icon(icon_dir: &Path, icon: &usvg::Tree) {
    let images: Vec<(u32, Vec<u8>)> = WINDOWS_ICON_SIZES
        .into_iter()
        .map(|size| {
            let png = encode_png(&render_desktop_icon(icon, size, size as f32));
            (size, png)
        })
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

fn write_macos_icon(icon_dir: &Path, icon: &usvg::Tree) {
    let entries: [(&[u8], u32); 7] = [
        (b"icp4", 16),
        (b"icp5", 32),
        (b"icp6", 64),
        (b"ic07", 128),
        (b"ic08", 256),
        (b"ic09", 512),
        (b"ic10", 1024),
    ];

    let mut body = Vec::new();
    for (tag, size) in entries {
        let png = encode_png(&render_desktop_icon(
            icon,
            size,
            size as f32 * MACOS_ICON_SCALE,
        ));
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

fn write_android_icons(manifest_dir: &Path, icon: &usvg::Tree) {
    let res_dir = manifest_dir.join("gen/android/app/src/main/res");
    if !res_dir.exists() {
        return;
    }

    for (dir_name, launcher_size, foreground_size) in ANDROID_MIPMAP_SIZES {
        let dir = res_dir.join(dir_name);
        let _ = fs::create_dir_all(&dir);

        // Android 7 shows these as drawn, so they keep the rounded frame.
        let launcher_png = encode_png(&render_desktop_icon(
            icon,
            launcher_size,
            launcher_size as f32,
        ));
        write_file_if_changed(dir.join("ic_launcher.png"), &launcher_png);
        write_file_if_changed(dir.join("ic_launcher_round.png"), &launcher_png);

        let foreground_png = encode_png(&render_icon(
            icon,
            foreground_size,
            foreground_size as f32 * ANDROID_FOREGROUND_SCALE,
        ));
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
    write_file_if_changed(
        anydpi_dir.join("ic_launcher_round.xml"),
        adaptive_xml.as_bytes(),
    );
}

/// Fills every image the iOS asset catalog lists. `tauri ios init` writes Tauri's own
/// logo there, and iOS rounds the corners itself, so these are plain opaque squares.
fn write_ios_icons(manifest_dir: &Path, icon: &usvg::Tree) {
    let icon_set = manifest_dir.join("gen/apple/Assets.xcassets/AppIcon.appiconset");
    let Ok(contents) = fs::read_to_string(icon_set.join("Contents.json")) else {
        return;
    };
    let contents: serde_json::Value =
        serde_json::from_str(&contents).expect("AppIcon Contents.json must be valid JSON");
    let images = contents["images"]
        .as_array()
        .expect("AppIcon Contents.json must list images");

    for image in images {
        let Some(filename) = image["filename"].as_str() else {
            continue;
        };
        let points: f32 = image["size"]
            .as_str()
            .and_then(|size| size.split('x').next())
            .and_then(|width| width.parse().ok())
            .expect("AppIcon image size must look like 60x60");
        let scale: f32 = image["scale"]
            .as_str()
            .and_then(|scale| scale.strip_suffix('x'))
            .and_then(|scale| scale.parse().ok())
            .expect("AppIcon image scale must look like 2x");
        let pixels = (points * scale).round() as u32;
        write_file_if_changed(icon_set.join(filename), &encode_opaque_png(icon, pixels));
    }
}

/// Every command the frontend can invoke. Tauri generates an `allow-<command>`
/// permission for each, and the capability files decide which window gets which.
/// Keep in sync with `generate_handler!` in `src/lib.rs` (a test enforces it).
const APP_COMMANDS: &[&str] = &[
    "get_startup_issue",
    "get_diagnostics",
    "retry_startup",
    "get_dashboard_snapshot",
    "get_bridge_info",
    "start_login",
    "probe_google_ai_studio_key",
    "add_google_ai_studio_account",
    "start_google_ai_studio_usage_login",
    "add_opencode_go_account",
    "add_grok_account",
    "get_login_status",
    "current_login_status",
    "cancel_login",
    "refresh_account",
    "refresh_all",
    "get_app_settings",
    "set_account_refresh_minutes",
    "set_automatic_updates_enabled",
    "set_include_beta_updates",
    "get_autostart",
    "set_autostart",
    "set_api_integration_enabled",
    "open_api_integration_window",
    "reorder_accounts",
    "get_account_alerts",
    "save_account_alerts",
    "rename_account",
    "remove_account",
    "get_account_buckets",
    "save_account_bucket",
    "delete_account_bucket",
    "regenerate_bridge_token",
    "reveal_bridge_token",
    "check_for_app_update",
    "install_app_update",
    "get_pending_update_notice",
    "ensure_camera_permission",
    "pairing_start_host",
    "pairing_start_receiver",
    "pairing_start_client",
    "pairing_start_client_by_code",
    "pairing_start_sender",
    "pairing_select_role",
    "pairing_confirm_sas",
    "pairing_cancel",
    "pairing_status",
    "pairing_set_include_settings",
    "pairing_set_allow_credential_replace",
    "pairing_set_pending_ui_state",
    "pairing_clear_pending_ui_state",
    "pairing_prepare_airgap_export",
    "pairing_verify_airgap",
    "pairing_import_airgap",
    "get_pending_pairing_uri",
];

fn main() {
    println!("cargo:rerun-if-changed=icons/icon.svg");
    println!("cargo:rerun-if-changed=gen/apple/Assets.xcassets/AppIcon.appiconset/Contents.json");
    println!("cargo:rerun-if-changed=tauri.conf.json");
    println!("cargo:rerun-if-changed=capabilities");
    println!("cargo:rerun-if-changed=../dist");
    // The Tauri CLI rewrites these templates during `tauri android build`;
    // re-running the build script when they change guarantees the WebView
    // patches below are re-applied before kotlinc compiles them.
    println!("cargo:rerun-if-changed=gen/android/app/src/main/java/com/dubba/ai/usage/tracker/generated/RustWebView.kt");
    println!("cargo:rerun-if-changed=gen/android/app/src/main/java/com/dubba/ai/usage/tracker/generated/RustWebChromeClient.kt");
    println!("cargo:rerun-if-changed=gen/android/app/src/main/java/com/dubba/ai/usage/tracker/generated/RustWebViewClient.kt");
    println!("cargo:rerun-if-changed=gen/android/app/src/main/java/com/dubba/ai/usage/tracker/generated/Ipc.kt");
    println!("cargo:rerun-if-changed=webview_ipc_patch.rs");

    let manifest_dir = PathBuf::from(
        env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR must be available"),
    );
    let icon_dir = manifest_dir.join("icons");
    let icon = parse_icon();

    for (file_name, size) in [
        ("icon.png", 128),
        ("32x32.png", 32),
        ("128x128.png", 128),
        ("128x128@2x.png", 256),
    ] {
        let png = encode_png(&render_desktop_icon(&icon, size, size as f32));
        write_file_if_changed(icon_dir.join(file_name), &png);
    }

    write_windows_icon(&icon_dir, &icon);
    write_macos_icon(&icon_dir, &icon);
    write_android_icons(&manifest_dir, &icon);
    write_ios_icons(&manifest_dir, &icon);

    let mut attributes = tauri_build::Attributes::new()
        .app_manifest(tauri_build::AppManifest::new().commands(APP_COMMANDS));
    if env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc") {
        attributes = attributes
            .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest());
        embed_windows_app_manifest(&manifest_dir);
    }
    if let Err(error) = tauri_build::try_build(attributes) {
        println!("{error:#}");
        std::process::exit(1);
    }
    patch_android_webview_templates(&manifest_dir);
}

/// tauri-build links its Windows application manifest into the app binary only, so the
/// `cargo test` binary started without the Common Controls v6 dependency that tauri's code needs
/// and Windows refused to run it (STATUS_ENTRYPOINT_NOT_FOUND, 0xc0000139). Embedding the same
/// manifest through the linker covers every binary. tauri-build's own copy is turned off in
/// `main`, because two manifests in one binary fail to link.
fn embed_windows_app_manifest(manifest_dir: &Path) {
    let manifest = manifest_dir.join("windows-app-manifest.xml");
    println!("cargo:rerun-if-changed={}", manifest.display());
    println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
    println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
}

fn patch_android_webview_templates(manifest_dir: &Path) {
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

fn patch_file(path: &PathBuf, patch: impl Fn(&str) -> String) {
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

/// Accepts a sign-in reply only when the host is exactly localhost or
/// 127.0.0.1. A prefix check treated http://localhost.evil.com as local and
/// loaded it in the main view. The `http://` prefix keeps the same plain-http
/// addresses that already counted as local, including ports and paths, and
/// rejects a userinfo trick such as http://localhost@evil.com.
const LOOPBACK_FN: &str = r#"      private fun isLoopback(url: String): Boolean {
        val uri = android.net.Uri.parse(url)
        val host = uri.host ?: return false
        if (host != "localhost" && host != "127.0.0.1") return false
        return url.startsWith("http://$host")
      }"#;

const OLD_LOOPBACK_FN: &str = r#"      private fun isLoopback(url: String): Boolean {
        return url.startsWith("http://localhost") || url.startsWith("http://127.0.0.1")
      }"#;

fn oauth_popup_window_methods() -> String {
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
          const root = document.documentElement;
          if (!root) return;
          const id = '__ai_tracker_back';
          const install = () => {
            if (!document.documentElement || document.getElementById(id)) return;
            const button = document.createElement('button');
            button.id = id;
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
            document.documentElement.appendChild(button);
          };
          install();
          if (window.__aiTrackerBackRoot !== document.documentElement) {
            window.__aiTrackerBackRoot = document.documentElement;
            new MutationObserver(install).observe(document.documentElement, { childList: true });
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

  override fun onCloseWindow(window: WebView) {
    window.destroy()
  }
}"#
    .replace("@@LOOPBACK@@", LOOPBACK_FN)
}

fn patch_chrome_client(content: &str) -> String {
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

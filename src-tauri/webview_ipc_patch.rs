//! Origin-safe IPC for the Android WebView.
//!
//! wry exposes IPC to the page through `addJavascriptInterface(ipc, "ipc")`. A JavaScript interface
//! cannot say which document called it, so the generated Kotlin tagged every message with
//! `RustWebViewClient.currentUrl`, a field written at the start of each main-frame navigation. That
//! field is not the calling document: a page that is still running while a navigation to the app's
//! own origin is under way, or never commits, was attributed the app's origin and so passed Tauri's
//! ACL for every command.
//!
//! These patches take the origin from `WebViewCompat.addWebMessageListener`, which hands the listener
//! the real origin of the frame that posted. Tauri then decides `is_local` from that, and remote
//! origins stay denied by the capability files exactly as before.
//!
//! Shared by `build.rs` (applies the patches to the generated Kotlin) and the unit tests in
//! `src/lib.rs`, so the transformations can be checked without a device.

/// The line in the generated `Ipc.kt` that attributes a message to the last navigation URL.
const LEGACY_FORWARD: &str = "Rust.ipc(webView.id, webViewClient.currentUrl, m)";

/// Marks a `RustWebView.kt` that already has the listener installed.
const LISTENER_MARKER: &str = "installIpcListener()";

/// Makes the legacy `ipc` JavaScript interface inert. The interface should never be reachable
/// (see [`patch_rust_webview_ipc`]); this keeps it harmless if a future wry exposes it under
/// another name.
pub fn patch_ipc(content: &str) -> String {
    if !content.contains(LEGACY_FORWARD) {
        return content.to_string();
    }
    content.replace(
        LEGACY_FORWARD,
        "// Origin cannot be known from a JavaScript interface, so nothing is forwarded.\n            // Messages arrive through the WebMessageListener installed in RustWebView.\n            Logger.warn(\"Dropped a message from the legacy IPC interface (\" + m.length + \" chars)\")",
    )
}

/// Replaces wry's `ipc` JavaScript interface in `RustWebView.kt` with a WebMessageListener that
/// forwards the frame's real origin. Idempotent. Returns the input unchanged when the template
/// does not have the shape this patch expects, which `webview_ipc_patch_applies_to_generated_kotlin`
/// turns into a failing test.
pub fn patch_rust_webview_ipc(content: &str) -> String {
    if content.contains(LISTENER_MARKER) {
        return content.to_string();
    }
    let property_anchor = "    val isDocumentStartScriptEnabled: Boolean\n";
    let init_anchor = "          isDocumentStartScriptEnabled = false\n        }\n";
    let method_anchor = "    fun loadUrlMainThread(url: String) {\n";
    if !content.contains(property_anchor)
        || !content.contains(init_anchor)
        || !content.contains(method_anchor)
    {
        return content.to_string();
    }

    let mut patched = content.replace(
        property_anchor,
        &format!(
            "{property_anchor}\n    // The listener below runs on the UI thread. The JavaScript interface it replaces ran on a\n    // background thread, and some commands are slow, so hand messages to one worker to keep\n    // them in order and off the UI thread.\n    private val ipcExecutor: java.util.concurrent.ExecutorService =\n        java.util.concurrent.Executors.newSingleThreadExecutor()\n"
        ),
    );
    patched = patched.replace(
        init_anchor,
        &format!("{init_anchor}\n        {LISTENER_MARKER}\n"),
    );
    patched.replace(method_anchor, &format!("{IPC_METHODS}\n{method_anchor}"))
}

const IPC_METHODS: &str = r#"    // wry adds its IPC object with addJavascriptInterface after creating the view. That interface
    // cannot tell which frame called it, so it is never registered; IPC arrives through
    // installIpcListener() instead.
    override fun addJavascriptInterface(obj: Any, name: String) {
        if (name == "ipc") return
        super.addJavascriptInterface(obj, name)
    }

    // Gives the page `window.ipc.postMessage(...)` as before, but each message carries the origin
    // of the frame that sent it. Without support, IPC stays off rather than falling back to an
    // interface that cannot identify the caller.
    private fun installIpcListener() {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            Logger.error("This WebView cannot report which page sent an IPC message; IPC stays off.")
            return
        }
        WebViewCompat.addWebMessageListener(
            this,
            "ipc",
            setOf("*"),
            WebViewCompat.WebMessageListener { _, message, sourceOrigin, _, _ ->
                val data = message.data ?: return@WebMessageListener
                // An opaque origin (sandboxed frame, data: URL) has no scheme and host, and Tauri
                // cannot parse it. Such pages are not the app, so drop the message.
                val scheme = sourceOrigin.scheme
                if (sourceOrigin.host.isNullOrEmpty() || (scheme != "http" && scheme != "https")) {
                    return@WebMessageListener
                }
                val origin = sourceOrigin.toString()
                ipcExecutor.execute { Rust.ipc(id, origin, data) }
            },
        )
    }
"#;

#[cfg(test)]
mod tests {
    use super::*;

    // wry 0.55.1 `src/android/kotlin/Ipc.kt` and the relevant part of `RustWebView.kt`.
    const UPSTREAM_IPC: &str = "class Ipc(val webView: RustWebView, val webViewClient: RustWebViewClient) {\n    @JavascriptInterface\n    fun postMessage(message: String?) {\n        message?.let {m ->\n            Rust.ipc(webView.id, webViewClient.currentUrl, m)\n        }\n    }\n}\n";
    const UPSTREAM_WEBVIEW: &str = "class RustWebView(context: Context, val initScripts: Array<String>, val id: String): WebView(context) {\n    val isDocumentStartScriptEnabled: Boolean\n\n    init {\n        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {\n            isDocumentStartScriptEnabled = true\n        } else {\n          isDocumentStartScriptEnabled = false\n        }\n    }\n\n    fun loadUrlMainThread(url: String) {\n        post {\n          loadUrl(url)\n        }\n    }\n}\n";

    #[test]
    fn legacy_interface_no_longer_forwards_the_navigation_url() {
        let patched = patch_ipc(UPSTREAM_IPC);
        assert!(!patched.contains("currentUrl"));
        assert!(!patched.contains("Rust.ipc("));
    }

    #[test]
    fn ipc_patch_is_idempotent() {
        let once = patch_ipc(UPSTREAM_IPC);
        assert_eq!(patch_ipc(&once), once);
        let webview = patch_rust_webview_ipc(UPSTREAM_WEBVIEW);
        assert_eq!(patch_rust_webview_ipc(&webview), webview);
    }

    #[test]
    fn webview_blocks_the_javascript_interface_and_installs_the_listener() {
        let patched = patch_rust_webview_ipc(UPSTREAM_WEBVIEW);
        // The generic interface is refused by name.
        assert!(patched.contains("override fun addJavascriptInterface(obj: Any, name: String)"));
        assert!(patched.contains("if (name == \"ipc\") return"));
        // The listener is installed from `init`, after the other setup.
        let init = patched.find("init {").unwrap();
        let call = patched.find("        installIpcListener()\n").unwrap();
        assert!(call > init);
        // The origin handed to Rust is the frame's own, never the navigation field.
        assert!(patched.contains("sourceOrigin.toString()"));
        assert!(patched.contains("Rust.ipc(id, origin, data)"));
        assert!(!patched.contains("currentUrl"));
    }

    #[test]
    fn webview_listener_fails_closed() {
        let patched = patch_rust_webview_ipc(UPSTREAM_WEBVIEW);
        // No support: IPC stays off, with no fallback to the JavaScript interface.
        assert!(patched.contains("WebViewFeature.WEB_MESSAGE_LISTENER"));
        assert!(patched.contains("IPC stays off"));
        // Opaque or non-web origins are dropped, because Tauri cannot parse them.
        assert!(patched.contains("sourceOrigin.host.isNullOrEmpty()"));
        assert!(patched.contains("scheme != \"http\" && scheme != \"https\""));
        // Every origin gets the object, so a remote page's call arrives with its real origin
        // and is denied by the capability files rather than by silently missing `window.ipc`.
        assert!(patched.contains("setOf(\"*\")"));
    }

    #[test]
    fn unrecognized_templates_are_left_alone() {
        assert_eq!(patch_ipc("class Other {}"), "class Other {}");
        assert_eq!(patch_rust_webview_ipc("class Other {}"), "class Other {}");
    }

    /// The generated Kotlin in the repository must be patchable. If the Tauri CLI regenerates the
    /// templates with a different shape, the patch would silently do nothing and the legacy
    /// interface would ship; this test fails instead.
    #[test]
    fn webview_ipc_patch_applies_to_generated_kotlin() {
        let dir = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/gen/android/app/src/main/java/com/yajinni/paseousagebridge/generated/"
        );
        let ipc = std::fs::read_to_string(format!("{dir}Ipc.kt")).unwrap();
        let webview = std::fs::read_to_string(format!("{dir}RustWebView.kt")).unwrap();
        assert!(
            !patch_ipc(&ipc).contains("currentUrl"),
            "Ipc.kt still attributes messages to currentUrl after patching"
        );
        let patched = patch_rust_webview_ipc(&webview);
        assert!(
            patched.contains("installIpcListener()") && patched.contains("name == \"ipc\""),
            "RustWebView.kt does not match the shape the IPC patch expects"
        );
    }
}

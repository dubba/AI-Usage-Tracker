# JNI entry points used by wry/tauri from Rust. R8 otherwise strips them
# because they are never called from Kotlin, which crashes Grok/OpenCode login.
-keep class com.dubba.ai.usage.tracker.Rust { *; }
-keep class com.dubba.ai.usage.tracker.RustWebView { *; }
-keep class com.dubba.ai.usage.tracker.RustWebViewClient { *; }
-keep class com.dubba.ai.usage.tracker.RustWebChromeClient { *; }
-keep class com.dubba.ai.usage.tracker.Ipc { *; }
-keep class com.dubba.ai.usage.tracker.WryActivity { *; }
-keep class com.dubba.ai.usage.tracker.TauriActivity { *; }
-keep class com.dubba.ai.usage.tracker.MainActivity { *; }
-keepclassmembers class com.dubba.ai.usage.tracker.RustWebView {
    public <init>(...);
    public java.lang.String getCookies(java.lang.String);
    public void evalScript(int, java.lang.String);
    public void loadUrlMainThread(java.lang.String);
    public void loadUrlMainThread(java.lang.String, java.util.Map);
    public void loadHTMLMainThread(java.lang.String);
    public void clearAllBrowsingData();
}
# Called by name over JNI from Rust (background_refresh.rs, android_keystore.rs) and
# created by WorkManager from its class name.
-keep class com.dubba.ai.usage.tracker.BackgroundRefreshWorker { *; }
-keep class com.dubba.ai.usage.tracker.BackgroundRefreshWorker$Companion { *; }
-keep class com.dubba.ai.usage.tracker.CredentialVault { *; }

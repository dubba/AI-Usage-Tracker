# JNI entry points used by wry/tauri from Rust. R8 otherwise strips them
# because they are never called from Kotlin, which crashes Grok/OpenCode login.
-keep class com.yajinni.paseousagebridge.Rust { *; }
-keep class com.yajinni.paseousagebridge.RustWebView { *; }
-keep class com.yajinni.paseousagebridge.RustWebViewClient { *; }
-keep class com.yajinni.paseousagebridge.RustWebChromeClient { *; }
-keep class com.yajinni.paseousagebridge.Ipc { *; }
-keep class com.yajinni.paseousagebridge.WryActivity { *; }
-keep class com.yajinni.paseousagebridge.TauriActivity { *; }
-keep class com.yajinni.paseousagebridge.MainActivity { *; }
-keepclassmembers class com.yajinni.paseousagebridge.RustWebView {
    public <init>(...);
    public java.lang.String getCookies(java.lang.String);
    public void evalScript(int, java.lang.String);
    public void loadUrlMainThread(java.lang.String);
    public void loadUrlMainThread(java.lang.String, java.util.Map);
    public void loadHTMLMainThread(java.lang.String);
    public void clearAllBrowsingData();
}
use super::*;

#[cfg(mobile)]
pub(super) fn open_mobile_oauth(
    app: &Arc<AppState>,
    context: Arc<LoginContext>,
    authorization_url: &str,
) -> Result<(), String> {
    let handle = app
        .app_handle
        .read()
        .clone()
        .ok_or_else(|| "The app is not ready for in-app sign-in.".to_string())?;
    let target = Url::parse(authorization_url).map_err(|error| error.to_string())?;
    if target.scheme() != "https" {
        return Err("Authorization URL must use HTTPS".to_string());
    }
    let host = target.host_str().unwrap_or("");
    let allowed = ["auth.openai.com", "claude.ai", "accounts.google.com"];
    if !allowed
        .iter()
        .any(|&h| host == h || host.ends_with(&format!(".{h}")))
    {
        return Err("Disallowed authorization URL host".to_string());
    }
    // Google refuses sign-in in the app's WebView, so Android uses the browser's tab when it can.
    #[cfg(target_os = "android")]
    if crate::auth::sign_in_tab::uses_sign_in_tab(&context.provider)
        && crate::auth::sign_in_tab::open(
            app.clone(),
            &context.provider,
            &context.attempt_id,
            context.callback_claimed.clone(),
            &target,
        )
    {
        return Ok(());
    }
    let intercept_started = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    crate::auth::mobile_auth::open_in_main_webview(
        handle,
        app.clone(),
        context.attempt_id.clone(),
        target,
        move |url| {
            if !looks_like_oauth_callback(&url) {
                return;
            }
            if intercept_started.swap(true, std::sync::atomic::Ordering::SeqCst) {
                return;
            }
            let context = context.clone();
            tauri::async_runtime::spawn(async move {
                let _ = handle_callback(context, callback_query_from_url(&url)).await;
            });
        },
    )
}

//! Where the main app window may navigate on Android and iOS.
//!
//! In-app sign-in (`mobile_auth.rs`) loads a provider's sign-in page into the
//! main window, which only checks the first URL. From there a link or an open
//! redirect could load any page inside the app's own window, which is a place
//! users trust. This plugin's navigation hook runs before each navigation of
//! the main window loads, and decides:
//!
//! - the app's own pages and `about:blank` are always allowed;
//! - while a sign-in is in progress, HTTPS pages on [`SIGN_IN_HOSTS`] (the
//!   providers and the single-sign-on, account, and challenge pages their
//!   flows pass through) and the loopback OAuth callback are allowed too;
//! - everything else is blocked, and its host is logged so that a sign-in
//!   host missing from the list shows up in the diagnostics report.

use std::sync::Arc;
use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime, Url,
};

/// Hosts (and their subdomains) a sign-in may pass through in the main window.
const SIGN_IN_HOSTS: &[&str] = &[
    // Providers.
    "openai.com",
    "chatgpt.com",
    "claude.ai",
    "anthropic.com",
    "google.com",
    "x.ai",
    "xai.com",
    "grok.com",
    "opencode.ai",
    // Single sign-on and account pages the providers hand off to.
    "apple.com",
    "github.com",
    "microsoftonline.com",
    "live.com",
    "microsoft.com",
    "x.com",
    "twitter.com",
    "t.co",
    "auth0.com",
    "okta.com",
    // Bot checks and assets those pages load.
    "cloudflare.com",
    "hcaptcha.com",
    "recaptcha.net",
    "arkoselabs.com",
    "gstatic.com",
    "twimg.com",
    "grokusercontent.com",
];

/// Whether the main window may navigate to `url`. `dev_url` is the dev server
/// (`build.devUrl`), whose pages are the app's own in development builds.
pub(crate) fn is_allowed_main_navigation(
    url: &Url,
    dev_url: Option<&Url>,
    signing_in: bool,
) -> bool {
    if url.as_str() == "about:blank" {
        return true;
    }
    let Some(host) = url
        .host_str()
        .map(|host| host.trim_end_matches('.').to_ascii_lowercase())
    else {
        return false;
    };
    let web = matches!(url.scheme(), "http" | "https");
    // The app's own pages (Tauri serves them from tauri.localhost on mobile).
    if web && host == "tauri.localhost" && url.port().is_none() {
        return true;
    }
    if dev_url.is_some_and(|dev| dev.origin() == url.origin()) {
        return true;
    }
    if !signing_in {
        return false;
    }
    // The loopback OAuth callback, which mobile_auth.rs intercepts.
    if url.scheme() == "http" && matches!(host.as_str(), "localhost" | "127.0.0.1") {
        return true;
    }
    url.scheme() == "https"
        && url.port().is_none()
        && url.username().is_empty()
        && SIGN_IN_HOSTS
            .iter()
            .any(|allowed| host == *allowed || host.ends_with(&format!(".{allowed}")))
}

/// The navigation guard for the main window. Registered on mobile only, where
/// sign-in uses the main window; other windows are not affected.
#[cfg_attr(desktop, allow(dead_code))]
pub(crate) fn plugin<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("signin-navigation")
        .on_navigation(|webview, url| {
            if webview.label() != "main" {
                return true;
            }
            let signing_in = webview
                .try_state::<Arc<crate::state::AppState>>()
                .is_some_and(|state| {
                    state
                        .pending_login
                        .read()
                        .as_ref()
                        .is_some_and(|login| login.status.is_in_progress())
                });
            let allowed = is_allowed_main_navigation(
                url,
                webview.config().build.dev_url.as_ref(),
                signing_in,
            );
            if !allowed {
                crate::diagnostics::warn(&format!(
                    "Blocked the app window from navigating to {}",
                    url.host_str().unwrap_or("(no host)")
                ));
            }
            allowed
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn allowed(url: &str, signing_in: bool) -> bool {
        let dev: Url = "http://192.168.1.20:1420".parse().unwrap();
        is_allowed_main_navigation(&url.parse().unwrap(), Some(&dev), signing_in)
    }

    #[test]
    fn the_app_itself_is_always_allowed() {
        for signing_in in [false, true] {
            assert!(allowed("http://tauri.localhost/", signing_in));
            assert!(allowed("https://tauri.localhost/index.html", signing_in));
            assert!(
                allowed("http://192.168.1.20:1420/", signing_in),
                "dev server"
            );
            assert!(allowed("about:blank", signing_in));
        }
    }

    #[test]
    fn nothing_else_loads_in_the_app_window_outside_sign_in() {
        for url in [
            "https://claude.ai/login",
            "https://accounts.google.com/",
            "http://localhost:1455/auth/callback?code=x",
            "https://evil.example/",
        ] {
            assert!(!allowed(url, false), "{url}");
        }
    }

    #[test]
    fn during_sign_in_only_sign_in_pages_and_the_callback_load() {
        for url in [
            "https://auth.openai.com/oauth/authorize",
            "https://claude.ai/login",
            "https://accounts.google.com/o/oauth2/auth",
            "https://appleid.apple.com/auth/authorize",
            "https://login.microsoftonline.com/common/oauth2",
            "https://accounts.x.ai/sign-in",
            "https://opencode.ai/auth",
            "https://github.com/login/oauth/authorize",
            "https://challenges.cloudflare.com/x",
            "http://localhost:1455/auth/callback?code=x&state=y",
            "http://127.0.0.1:53692/callback?code=x",
        ] {
            assert!(allowed(url, true), "{url}");
        }
        for url in [
            "https://evil.example/login",
            "https://claude.ai.evil.example/",
            "https://evilclaude.ai/",
            "http://claude.ai/login",
            "https://claude.ai:8443/",
            "https://user@claude.ai/",
            "http://192.168.1.50/",
            "file:///data/data/app/files/credentials",
            "javascript:alert(1)",
            "data:text/html,<p>sign in</p>",
        ] {
            assert!(!allowed(url, true), "{url}");
        }
    }
}

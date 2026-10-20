//! Signing in to providers: OAuth flows, sign-in WebViews and the cookie and token capture behind them.

pub(crate) mod google_ai_studio_oauth;
pub(crate) mod google_client;
pub(crate) mod grok_login;
#[cfg(target_os = "ios")]
pub(crate) mod ios_cookies;
#[cfg(target_os = "ios")]
pub(crate) mod ios_popups;
#[cfg(desktop)]
pub(crate) mod login_profile;
pub(crate) mod login_window;
pub(crate) mod mobile_auth;
pub(crate) mod oauth;
pub(crate) mod oauth_common;
pub(crate) mod opencode_login;
pub(crate) mod sign_in_tab;
pub(crate) mod signin_navigation;

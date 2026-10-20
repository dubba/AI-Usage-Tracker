use super::*;

/// Label of the provider OAuth sign-in window; `cancel_login` closes it by this name.
pub(crate) const PROVIDER_LOGIN_WINDOW: &str = "provider-login";
/// Label prefix of the popups a sign-in page opens (see `open_provider_login_popup`).
pub(super) const PROVIDER_LOGIN_POPUP_PREFIX: &str = "provider-login-popup-";
pub(crate) const PROVIDER_LOGIN_PROFILE_PREFIX: &str = "ai-usage-oauth-";

/// Top-left Back button for a provider page that has no browser chrome.
/// Built without `innerHTML` and reattached if removed: Antigravity loads
/// `accounts.google.com`, which rejects HTML assignment and drops nodes it
/// did not create. Claude and ChatGPT leave the button in place.
pub(super) const LOGIN_BACK_BUTTON_SCRIPT: &str = r#"
(() => {
  try {
    if (window.top !== window || !document.documentElement) return;
    // A sign-in popup (Google's, opened by Claude) shares this window's WebView
    // configuration and so this script; it is closed by the app, not Back.
    if (window.opener) return;
    const id = '__ai_tracker_back';
    const install = () => {
      if (!document.documentElement || document.getElementById(id)) return;
      const button = document.createElement('button');
      button.id = id;
      button.type = 'button';
      button.textContent = '‹ Back';
      button.setAttribute('aria-label', 'Back to AI Usage Tracker');
      button.style.cssText = [
        'position:fixed', 'top:12px', 'left:12px', 'z-index:2147483647',
        'padding:8px 14px', 'border:0', 'border-radius:999px', 'background:#6d3bd7', 'color:#fff',
        'font:600 14px -apple-system,system-ui,sans-serif', 'box-shadow:0 2px 10px rgba(0,0,0,.4)',
        'cursor:pointer',
      ].join(';');
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        try {
          const url = new URL(window.location.href);
          url.searchParams.set('ai-usage-tracker-back', '1');
          window.location.href = url.toString();
        } catch (e) {}
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
"#;

pub(crate) fn is_provider_login_back_request(url: &Url) -> bool {
    is_back_request(url, BACK_QUERY_FLAG)
}

/// Query flag injected into popups when `window.close()` is called or when
/// credentials have been handed to the opener.
pub(super) const POPUP_CLOSE_QUERY_FLAG: &str = "ai-usage-tracker-popup-close";

pub(crate) fn is_provider_login_popup_close_request(url: &Url) -> bool {
    url.query_pairs()
        .any(|(key, value)| key == POPUP_CLOSE_QUERY_FLAG && value == "1")
}

/// Script injected into sign-in popups. Google Identity Services calls
/// `window.close()` when the user finishes or cancels, but Tauri/wry does not
/// act on `window.close()`, so this intercepts it and navigates with a flag that
/// `on_navigation` uses to dismiss the popup window.
pub(super) const POPUP_AUTO_CLOSE_SCRIPT: &str = r#"
(() => {
  try {
    const origClose = window.close;
    const triggerClose = () => {
      try {
        const u = new URL(window.location.href);
        u.searchParams.set('ai-usage-tracker-popup-close', '1');
        window.location.replace(u.toString());
      } catch (e) {
        try {
          window.location.replace('about:blank?ai-usage-tracker-popup-close=1');
        } catch (e2) {}
      }
    };
    const closeHandler = function () {
      try {
        if (origClose) origClose.call(window);
      } catch (e) {}
      setTimeout(triggerClose, 50);
    };
    try { window.close = closeHandler; } catch (e) {}
    try {
      Object.defineProperty(window, 'close', {
        value: closeHandler,
        writable: true,
        configurable: true,
      });
    } catch (e) {}
  } catch (e) {}
})();
"#;

/// The first page of a desktop sign-in window. Narrower than the pages a
/// sign-in may pass through afterwards.
pub(crate) fn is_allowed_provider_login_start(url: &Url) -> bool {
    if is_provider_login_back_request(url) || is_provider_login_popup_close_request(url) {
        return false;
    }
    if url.scheme() != "https" || url.port().is_some() || !url.username().is_empty() {
        return false;
    }
    let Some(host) = url.host_str() else {
        return false;
    };
    let host = host.to_ascii_lowercase();
    ["openai.com", "claude.ai", "anthropic.com", "google.com"]
        .iter()
        .any(|allowed| host == *allowed || host.ends_with(&format!(".{allowed}")))
}

/// Pages the desktop sign-in window may load after it opens: provider and
/// single-sign-on hosts, plus the loopback callback that finishes the login.
/// A Back request is never loaded.
pub(crate) fn is_allowed_provider_login_navigation(url: &Url) -> bool {
    if is_provider_login_back_request(url) || is_provider_login_popup_close_request(url) {
        return false;
    }
    if url.as_str() == "about:blank" {
        return true;
    }
    if looks_like_oauth_callback(url) && url.scheme() == "http" && url.username().is_empty() {
        return true;
    }
    if url.scheme() != "https" || url.port().is_some() || !url.username().is_empty() {
        return false;
    }
    url.host_str()
        .is_some_and(crate::auth::signin_navigation::host_is_sign_in)
}

/// Opens `authorization_url` in a private window with a top-left Back button.
/// The loopback callback server is already listening; this window does not
/// receive the app's privileged IPC.
#[cfg(desktop)]
pub(crate) fn open_provider_login_window(
    app: &Arc<AppState>,
    attempt_id: &str,
    authorization_url: &str,
    title: &str,
) -> Result<(), String> {
    let target = Url::parse(authorization_url).map_err(|error| error.to_string())?;
    if !is_allowed_provider_login_start(&target) {
        return Err("Disallowed authorization URL host".into());
    }
    let handle = app
        .app_handle
        .read()
        .clone()
        .ok_or_else(|| "The app is not ready to open sign-in.".to_string())?;
    if let Some(window) = handle.get_webview_window(PROVIDER_LOGIN_WINDOW) {
        crate::auth::mobile_auth::dismiss_login_window(&window);
    }
    crate::auth::login_profile::sweep_stale_profiles(PROVIDER_LOGIN_PROFILE_PREFIX);
    let profile_dir = crate::auth::login_profile::create_private_profile_dir(
        PROVIDER_LOGIN_PROFILE_PREFIX,
        attempt_id,
    )?;
    let callback_seen = Arc::new(AtomicBool::new(false));
    let close_scheduled = Arc::new(AtomicBool::new(false));
    let back_handle = handle.clone();
    let back_state = app.clone();
    let back_attempt = attempt_id.to_string();
    let nav_callback_seen = callback_seen.clone();
    let nav_popups_handle = handle.clone();
    let load_dir = profile_dir.clone();
    let popup_handle = handle.clone();
    let window = match login_window::open_private_login_window(
        &handle,
        LoginWindowSpec {
            label: PROVIDER_LOGIN_WINDOW,
            title,
            start_url: target,
            profile_dir: profile_dir.clone(),
            init_script: LOGIN_BACK_BUTTON_SCRIPT.to_string(),
            user_agent: Some(LOGIN_USER_AGENT),
        },
        |builder| {
            builder
                .on_page_load(move |window, payload| {
                    if matches!(payload.event(), PageLoadEvent::Finished) {
                        let _ = window.eval(LOGIN_BACK_BUTTON_SCRIPT);
                        // A new page here means the popup's job is done: Claude moves on once
                        // Google's popup has handed it the sign-in result.
                        close_provider_login_popups(window.app_handle());
                        // Time the close from when the result page is shown, not from when
                        // the callback was requested: the callback server answers only after
                        // the token exchange (and, for Antigravity, the project lookup),
                        // which can take seconds and would cut the page's countdown short.
                        if is_loopback_callback(payload.url())
                            && !close_scheduled.swap(true, Ordering::SeqCst)
                        {
                            let close_dir = load_dir.clone();
                            tauri::async_runtime::spawn(async move {
                                tokio::time::sleep(
                                    crate::auth::oauth_common::CONNECTED_PAGE_DISPLAY,
                                )
                                .await;
                                let _ = std::fs::remove_dir_all(&close_dir);
                                crate::auth::mobile_auth::dismiss_login_window(&window);
                            });
                        }
                    }
                })
                .on_new_window(move |url, features| {
                    // Claude's "Continue with Google" is a Google Identity Services popup
                    // that hands the result back through `window.opener`, so it needs a
                    // real window; without one Claude reports an error.
                    if url.scheme() != "https" || !is_allowed_provider_login_navigation(&url) {
                        crate::diagnostics::warn(&format!(
                            "Sign-in blocked a popup to host {}",
                            url.host_str().unwrap_or("(none)")
                        ));
                        return NewWindowResponse::Deny;
                    }
                    match open_provider_login_popup(&popup_handle, features) {
                        Ok(window) => NewWindowResponse::Create { window },
                        Err(error) => {
                            crate::diagnostics::warn(&format!(
                                "Unable to open the sign-in popup: {}",
                                crate::diagnostics::command_error(error)
                            ));
                            NewWindowResponse::Deny
                        }
                    }
                })
                .on_navigation(move |url| {
                    if is_provider_login_back_request(url) {
                        back_state
                            .fail_login_if_waiting(&back_attempt, "Sign-in was canceled.".into());
                        back_state.abort_login_resources(&back_attempt);
                        if let Some(window) = back_handle.get_webview_window(PROVIDER_LOGIN_WINDOW)
                        {
                            crate::auth::mobile_auth::dismiss_login_window(&window);
                        }
                        return false;
                    }
                    if is_loopback_callback(url) {
                        close_provider_login_popups(&nav_popups_handle);
                        // The window closes once the result page has been shown (on_page_load).
                        nav_callback_seen.store(true, Ordering::SeqCst);
                        return true;
                    }
                    let allowed = is_allowed_provider_login_navigation(url);
                    if !allowed {
                        crate::diagnostics::warn(&format!(
                            "Sign-in blocked navigation to host {}",
                            url.host_str().unwrap_or("(none)")
                        ));
                    }
                    allowed
                })
        },
    ) {
        Ok(window) => window,
        Err(error) => {
            let _ = std::fs::remove_dir_all(&profile_dir);
            return Err(format!(
                "Unable to open the sign-in window: {}",
                crate::diagnostics::command_error(error)
            ));
        }
    };
    let close_state = app.clone();
    let close_attempt = attempt_id.to_string();
    let close_dir = profile_dir;
    let close_seen = callback_seen;
    let close_handle = handle.clone();
    window.on_window_event(move |event| {
        if matches!(
            event,
            WindowEvent::CloseRequested { .. } | WindowEvent::Destroyed
        ) {
            close_provider_login_popups(&close_handle);
        }
        if matches!(event, WindowEvent::CloseRequested { .. }) {
            let _ = std::fs::remove_dir_all(&close_dir);
            if !close_seen.load(Ordering::SeqCst) {
                close_state.fail_login_if_waiting(&close_attempt, "Sign-in was canceled.".into());
                close_state.abort_login_resources(&close_attempt);
            }
        }
    });
    Ok(())
}

/// A popup opened by the sign-in page. Built from the opener's WebView
/// configuration (`window_features`) so WebKit links it to its opener and it
/// shares the sign-in session, and held to the same hosts as the sign-in window.
/// On Windows that shares the WebView2 environment only; the profile comes from
/// `incognito`, which must match the opener's or WebView2 refuses the popup and
/// it stays black. macOS takes the profile from the shared configuration.
#[cfg(desktop)]
pub(super) fn open_provider_login_popup(
    handle: &tauri::AppHandle,
    features: tauri::webview::NewWindowFeatures,
) -> tauri::Result<tauri::WebviewWindow> {
    static NEXT_POPUP: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let label = format!(
        "{PROVIDER_LOGIN_POPUP_PREFIX}{}",
        NEXT_POPUP.fetch_add(1, Ordering::Relaxed)
    );
    let close_handle = handle.clone();
    // The page's own window.open size is about 640×800 and clips 2-step
    // verification. Open as tall as the sign-in window instead, then apply it
    // again after build so the requested size does not stick.
    let (width, height, position) = popup_geometry(handle);
    let mut window_builder = WebviewWindowBuilder::new(
        handle,
        label,
        WebviewUrl::External(Url::parse("about:blank").expect("about:blank is a valid URL")),
    )
    .title("Sign in with Google")
    .window_features(features)
    .incognito(login_window::SIGN_IN_INCOGNITO)
    .inner_size(width, height)
    .min_inner_size(520.0, login_window::LOGIN_WINDOW_SIZE.1)
    .resizable(true)
    .devtools(false)
    .initialization_script(POPUP_AUTO_CLOSE_SCRIPT)
    .user_agent(LOGIN_USER_AGENT);
    if let Some((x, y)) = position {
        window_builder = window_builder.position(x, y);
    } else {
        window_builder = window_builder.center();
    }
    let window = window_builder
        .on_navigation(move |url| {
            if is_provider_login_popup_close_request(url) {
                close_provider_login_popups(&close_handle);
                return false;
            }
            let allowed = url.as_str() == "about:blank"
                || (url.scheme() == "https" && is_allowed_provider_login_navigation(url));
            if !allowed {
                crate::diagnostics::warn(&format!(
                    "Sign-in popup blocked navigation to host {}",
                    url.host_str().unwrap_or("(none)")
                ));
            }
            allowed
        })
        .build()?;
    let _ = window.set_size(tauri::LogicalSize::new(width, height));
    if let Some((x, y)) = position {
        let _ = window.set_position(tauri::LogicalPosition::new(x, y));
    }

    let watch_handle = handle.clone();
    let watch_label = window.label().to_string();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            let Some(popup) = watch_handle.get_webview_window(&watch_label) else {
                break;
            };
            let Some(opener) = watch_handle.get_webview_window(PROVIDER_LOGIN_WINDOW) else {
                crate::auth::mobile_auth::dismiss_login_window(&popup);
                break;
            };
            if let Ok(current) = opener.url() {
                if is_loopback_callback(&current) {
                    crate::auth::mobile_auth::dismiss_login_window(&popup);
                    break;
                }
            }
        }
    });

    Ok(window)
}

/// Width of the Google sign-in popup: the size its page asks for.
const POPUP_WIDTH: f64 = 640.0;

/// Where the sign-in popup opens: as tall as the sign-in window (Claude's) and
/// level with it, centered across it. Falls back to the old fixed size when the
/// sign-in window cannot be measured.
#[cfg(desktop)]
fn popup_geometry(handle: &tauri::AppHandle) -> (f64, f64, Option<(f64, f64)>) {
    let measured = handle
        .get_webview_window(PROVIDER_LOGIN_WINDOW)
        .and_then(|window| {
            let scale = window.scale_factor().ok()?.max(0.1);
            let position = window.outer_position().ok()?.to_logical::<f64>(scale);
            let outer = window.outer_size().ok()?.to_logical::<f64>(scale);
            let inner = window.inner_size().ok()?.to_logical::<f64>(scale);
            Some(popup_geometry_over(
                (position.x, position.y),
                outer.width,
                inner.height,
            ))
        });
    match measured {
        Some((width, height, position)) => (width, height, Some(position)),
        None => crate::auth::oauth_common::window_geometry_centered_on(
            handle,
            PROVIDER_LOGIN_WINDOW,
            0.0,
            0.0,
            POPUP_WIDTH,
            1040.0,
        ),
    }
}

/// The popup's inner size and outer position over a sign-in window with the
/// given outer position, outer width and inner height. Both windows have the
/// same title bar, so matching inner heights and tops makes them line up.
#[cfg_attr(not(desktop), allow(dead_code))]
pub(super) fn popup_geometry_over(
    opener_position: (f64, f64),
    opener_outer_width: f64,
    opener_inner_height: f64,
) -> (f64, f64, (f64, f64)) {
    let x = opener_position.0 + (opener_outer_width - POPUP_WIDTH) / 2.0;
    (POPUP_WIDTH, opener_inner_height, (x, opener_position.1))
}

/// Closes any sign-in popups. Google's popup calls `window.close()` when it is
/// done, which Tauri does not act on, so the app closes it instead.
#[cfg(desktop)]
pub(super) fn close_provider_login_popups(handle: &tauri::AppHandle) {
    for (label, popup) in handle.webview_windows() {
        if label.starts_with(PROVIDER_LOGIN_POPUP_PREFIX) {
            crate::auth::mobile_auth::dismiss_login_window(&popup);
        }
    }
}

//! Pieces shared by the browser-based OAuth logins (`oauth` and `google_ai_studio_oauth`):
//! the loopback callback query, PKCE helpers, and the HTML pages shown in the browser tab.

use crate::{
    model::{Account, Provider},
    state::AppState,
};
use axum::{
    http::{HeaderMap, HeaderValue},
    response::{Html, IntoResponse},
    Router,
};
use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine,
};
use parking_lot::Mutex;
use rand::RngCore;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{sync::Arc, time::Duration};
use tokio::{net::TcpListener, sync::oneshot};
use url::Url;

/// Why a second sign-in cannot start while one is still in progress.
pub(crate) const LOGIN_IN_PROGRESS_MESSAGE: &str = "Another provider login is already in progress.";

/// How long a sign-in keeps the "Account connected" page up once it is shown,
/// matching the page's own countdown (`account_connected_html`).
pub(crate) const CONNECTED_PAGE_DISPLAY: Duration = Duration::from_secs(5);

/// The `data:` URL of the last "Account connected" page the app put in a window
/// itself, for sign-ins without a loopback callback page (Grok, OpenCode). The
/// navigation guards allow exactly this URL, never `data:` in general.
static CONNECTED_PAGE_URL: Mutex<Option<String>> = Mutex::new(None);

/// The "Account connected" page as a self-contained `data:` URL, which the
/// navigation guards then allow (see `is_connected_page`).
pub(crate) fn connected_page_url(account: &Account) -> Option<Url> {
    let html = connected_html("Account connected", account, "");
    let url = Url::parse(&format!(
        "data:text/html;charset=utf-8;base64,{}",
        STANDARD.encode(html)
    ))
    .ok()?;
    *CONNECTED_PAGE_URL.lock() = Some(url.as_str().to_string());
    Some(url)
}

/// Whether `url` is the page `connected_page_url` last made.
pub(crate) fn is_connected_page(url: &Url) -> bool {
    url.scheme() == "data" && CONNECTED_PAGE_URL.lock().as_deref() == Some(url.as_str())
}

/// The "Account connected" (or other result) page of a sign-in: the loopback
/// callback page, or the page `connected_page_url` made.
pub(crate) fn is_result_page(url: &Url) -> bool {
    crate::oauth::is_loopback_callback(url) || is_connected_page(url)
}

/// Counts the `connected_page_url` page down from 5 to 0 over
/// `CONNECTED_PAGE_DISPLAY`. Script the app evaluates is not held to the page's
/// Content Security Policy, unlike the page's own inline script, and the number
/// and the close then run on one clock.
pub(crate) async fn run_connected_countdown(window: &tauri::WebviewWindow) {
    let seconds = CONNECTED_PAGE_DISPLAY.as_secs();
    for remaining in (0..seconds).rev() {
        tokio::time::sleep(Duration::from_secs(1)).await;
        let _ = window.eval(format!(
            "(() => {{ const el = document.getElementById('sec'); if (el) el.textContent = '{remaining}'; }})();"
        ));
    }
}

/// Shows the "Account connected" page in a provider's own sign-in window (Grok,
/// OpenCode), then closes the window once its countdown has run. The countdown
/// starts when the page is shown, so the window is timed from then.
#[cfg(desktop)]
pub(crate) fn close_after_connected_page(window: tauri::WebviewWindow, account: &Account) {
    const SHOW_WAIT_LIMIT: Duration = Duration::from_secs(2);
    let page = connected_page_url(account);
    tauri::async_runtime::spawn(async move {
        if let Some(page) = page {
            if window.navigate(page.clone()).is_ok() {
                let deadline = tokio::time::Instant::now() + SHOW_WAIT_LIMIT;
                while window.url().ok().as_ref() != Some(&page)
                    && tokio::time::Instant::now() < deadline
                {
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
            }
        }
        run_connected_countdown(&window).await;
        crate::mobile_auth::dismiss_login_window(&window);
    });
}

/// What a sign-in settled on for an account: the label and the identity the provider reported,
/// each already combined with the existing account's values where the sign-in found none.
pub(crate) struct ConnectedFields {
    pub label: String,
    pub provider: Provider,
    pub email: Option<String>,
    pub provider_account_id: Option<String>,
    pub chatgpt_account_id: Option<String>,
    pub plan: Option<String>,
}

/// Builds the account a sign-in saves. When it signs in to an account that is already stored
/// (`duplicate`), the result keeps that account's id, creation time and last usage, so the
/// sign-in updates it instead of adding a second one; otherwise it is a new account with a
/// fresh id. The error state is cleared either way: the sign-in just worked.
pub(crate) fn merge_into_existing(duplicate: Option<&Account>, fields: ConnectedFields) -> Account {
    let now = crate::model::now_rfc3339();
    Account {
        id: duplicate
            .map(|account| account.id.clone())
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
        label: fields.label,
        provider: fields.provider,
        email: fields.email,
        provider_account_id: fields.provider_account_id,
        chatgpt_account_id: fields.chatgpt_account_id,
        plan: fields.plan,
        created_at: duplicate
            .map(|account| account.created_at.clone())
            .unwrap_or_else(|| now.clone()),
        updated_at: now,
        last_usage: duplicate.and_then(|account| account.last_usage.clone()),
        last_error: None,
        auth_required: false,
    }
}

/// Ends a sign-in that has its own window (Grok, OpenCode): marks the attempt complete if it is
/// still waiting and, on desktop, shows the "Account connected" page and closes the window.
/// On mobile the sign-in poll loop (`mobile_auth.rs`) shows the page instead. Returns whether
/// the attempt was still waiting; if not, nothing was shown.
pub(crate) fn finish_window_login(
    state: &AppState,
    attempt_id: &str,
    account: Account,
    window: tauri::WebviewWindow,
) -> bool {
    #[cfg(desktop)]
    let connected = account.clone();
    let completed = state.update_login_if_waiting(attempt_id, |login| {
        *login = crate::model::LoginStatus::complete(attempt_id, account);
    });
    #[cfg(desktop)]
    if completed {
        close_after_connected_page(window, &connected);
    }
    #[cfg(not(desktop))]
    let _ = window;
    completed
}

#[derive(Debug, Deserialize)]
pub(crate) struct CallbackQuery {
    pub code: Option<String>,
    pub state: Option<String>,
    pub error: Option<String>,
    pub error_description: Option<String>,
}

pub(crate) fn random_base64(bytes: usize) -> String {
    let mut value = vec![0u8; bytes];
    rand::thread_rng().fill_bytes(&mut value);
    URL_SAFE_NO_PAD.encode(value)
}

/// PKCE `code_challenge` (method S256) for a `code_verifier`.
pub(crate) fn pkce_challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

/// Serves a callback page with headers that keep it uncached, script-restricted, and unframed.
pub(crate) fn callback_html(body: String) -> axum::response::Response {
    let mut headers = HeaderMap::new();
    headers.insert(
        axum::http::header::CACHE_CONTROL,
        HeaderValue::from_static("no-store, no-cache, must-revalidate"),
    );
    headers.insert(
        axum::http::header::PRAGMA,
        HeaderValue::from_static("no-cache"),
    );
    headers.insert(
        axum::http::header::HeaderName::from_static("content-security-policy"),
        HeaderValue::from_static(
            "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
        ),
    );
    headers.insert(
        axum::http::header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        axum::http::header::HeaderName::from_static("referrer-policy"),
        HeaderValue::from_static("no-referrer"),
    );
    (headers, Html(body)).into_response()
}

pub(crate) fn escape_html(input: &str) -> String {
    input
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

/// How long a browser sign-in may stay open before it is given up on. The cookie sign-ins in app
/// windows (Grok, OpenCode) wait `COOKIE_LOGIN_TIMEOUT_MINUTES` (10) on purpose.
pub(crate) const OAUTH_LOGIN_TIMEOUT_MINUTES: i64 = 5;

/// Serves the loopback OAuth callback until `shutdown` fires. If the server itself fails (as
/// opposed to being shut down), `fail` is told why, prefixed with `failure_prefix`, and the
/// attempt's resources are released so the user can start again.
pub(crate) fn spawn_callback_server(
    app: Arc<AppState>,
    attempt_id: String,
    listener: TcpListener,
    router: Router,
    shutdown: oneshot::Receiver<()>,
    failure_prefix: &'static str,
    fail: impl FnOnce(String) + Send + 'static,
) {
    tokio::spawn(async move {
        if let Err(error) = axum::serve(listener, router)
            .with_graceful_shutdown(async {
                let _ = shutdown.await;
            })
            .await
        {
            fail(format!("{failure_prefix}: {error}"));
            app.abort_login_resources(&attempt_id);
        }
    });
}

/// After `after`, gives up on the attempt if it is still waiting: `fail` is told `message` and the
/// attempt's resources are released. An attempt that finished or failed in the meantime is left alone.
pub(crate) fn spawn_login_timeout(
    app: Arc<AppState>,
    attempt_id: String,
    after: Duration,
    message: String,
    fail: impl FnOnce(String) + Send + 'static,
) {
    tokio::spawn(async move {
        tokio::time::sleep(after).await;
        if app.login_is_waiting(&attempt_id) {
            fail(message);
            app.abort_login_resources(&attempt_id);
        }
    });
}

/// The page shown in the browser when a sign-in fails. `message` is escaped here.
const OPENAI_ICON: &str = r##"<svg viewBox="172 172 372 372" width="32" height="32" fill="currentColor" aria-hidden="true"><path d="M508.749 317.399C516.777 287.314 508.991 253.884 485.389 230.282C461.788 206.681 428.36 198.895 398.273 206.923C376.231 184.928 343.39 174.956 311.148 183.596C278.906 192.234 255.45 217.292 247.36 247.361C217.291 255.451 192.233 278.91 183.595 311.149C174.957 343.391 184.927 376.232 206.924 398.274C198.896 428.359 206.683 461.789 230.284 485.391C253.885 508.992 287.313 516.779 317.401 508.75C339.442 530.745 372.286 540.717 404.525 532.079C436.767 523.441 460.223 498.384 468.313 468.315C498.383 460.224 523.44 436.766 532.078 404.526C540.716 372.285 530.747 339.443 508.749 317.402V317.399ZM470.899 244.776C486.892 260.77 493.488 282.601 490.687 303.412L415.577 260.046C412.411 258.218 408.509 258.218 405.345 260.046L317.401 310.82V277.526C317.401 275.191 318.652 273.005 320.676 271.837L387.644 233.174C414.178 218.353 448.346 222.223 470.901 244.776H470.899ZM357.837 311.144L398.275 334.491V381.185L357.837 404.532L317.398 381.185V334.491L357.837 311.144ZM264.776 269.693C265.207 239.305 285.644 211.649 316.453 203.393C338.3 197.54 360.505 202.744 377.127 215.573L302.014 258.937C298.848 260.764 296.898 264.144 296.898 267.798V369.346L268.065 352.699C266.043 351.531 264.776 349.353 264.776 347.017V269.691V269.693ZM203.391 316.454C209.244 294.608 224.854 277.978 244.276 269.999V356.73C244.276 360.384 246.226 363.763 249.392 365.591L337.337 416.365L308.503 433.013C306.481 434.181 303.961 434.188 301.939 433.02L234.971 394.357C208.868 378.789 195.138 347.261 203.391 316.454ZM244.775 470.9C228.781 454.906 222.186 433.075 224.986 412.264L300.096 455.63C303.263 457.457 307.164 457.457 310.328 455.63L398.273 404.856V438.149C398.273 440.485 397.022 442.671 394.997 443.839L328.029 482.502C301.495 497.322 267.327 493.452 244.772 470.9H244.775ZM450.897 445.982C450.466 476.371 430.029 504.027 399.22 512.283C377.373 518.136 355.168 512.932 338.547 500.102L413.659 456.738C416.826 454.911 418.775 451.532 418.775 447.877V346.329L447.609 362.977C449.631 364.145 450.897 366.323 450.897 368.659V445.985V445.982ZM512.282 399.221C506.429 421.068 490.819 437.697 471.397 445.676V358.946C471.397 355.292 469.448 351.912 466.281 350.085L378.336 299.311L407.17 282.663C409.192 281.495 411.712 281.487 413.734 282.655L480.702 321.318C506.805 336.887 520.536 368.415 512.282 399.221Z"/></svg>"##;
const CLAUDE_ICON: &str = r##"<svg viewBox="0 0 94 94" width="32" height="32" aria-hidden="true"><path fill="#D97757" d="M18.7657 62.4437L37.1822 52.1167L37.4857 51.2122L37.1822 50.7085H36.2715L33.1852 50.5208L22.6615 50.2391L13.5545 49.8636L4.70044 49.3942L2.47428 48.9248L0.399902 46.1553L0.602281 44.794L2.47428 43.5266L5.15579 43.7613L11.0754 44.1837L19.98 44.794L26.4055 45.1695L35.9679 46.1553H37.4857L37.6881 45.545L37.1822 45.1695L36.7774 44.794L27.5692 38.5508L17.6021 31.9791L12.3908 28.1769L9.60812 26.2524L8.19147 24.4686L7.58433 20.5256L10.1141 17.7091L13.5545 17.9438L14.4146 18.1785L17.9056 20.8542L25.343 26.6279L35.0572 33.7629L36.4739 34.9364L37.0443 34.5514L37.1316 34.2792L36.4739 33.1996L31.212 23.6706L25.596 13.9539L23.0663 9.91695L22.4086 7.52296C22.1538 6.51831 22.0038 5.68714 22.0038 4.65957L24.8877 0.716544L26.5067 0.200195L30.4025 0.716544L32.0215 2.12477L34.4501 7.66379L38.3458 16.3478L44.4172 28.1769L46.188 31.6975L47.1493 34.9364L47.5035 35.9222H48.1106V35.3589L48.6166 28.6933L49.5273 20.5256L50.438 10.0108L50.7415 7.05356L52.2088 3.48605L55.1433 1.56148L57.42 2.64112L59.292 5.31674L59.039 7.05356L57.926 14.2824L55.7504 25.5952L54.3337 33.1996H55.1433L56.1046 32.2138L59.9497 27.1442L66.3752 19.0704L69.2085 15.8784L72.5478 12.3579L74.6728 10.668H78.7203L81.6548 15.0804L80.3394 19.6337L76.1906 24.8911L72.7502 29.3504L67.8172 35.9595L64.7562 41.2734L65.0307 41.7118L65.7681 41.6489L76.8989 39.255L82.9197 38.1753L90.1041 36.9549L93.3422 38.457L93.6963 40.006L92.4315 43.151L84.7411 45.0287L75.7353 46.8594L62.3244 50.0164L62.1759 50.1358L62.3512 50.3958L68.399 50.9432L70.9794 51.084H77.3037L89.0922 51.9759L92.1785 53.9944L93.9999 56.4822L93.6963 58.4068L88.9404 60.8008L82.5655 59.2987L67.6401 55.7312L62.5301 54.4638H61.8217V54.8862L66.0717 59.064L73.9139 66.1051L83.6786 75.2116L84.1845 77.4648L82.9197 79.2485L81.6042 79.0608L73.0032 72.5829L69.6639 69.6726L62.1759 63.3356H61.67V63.9928L63.3902 66.5276L72.5478 80.2812L73.0032 84.5059L72.3454 85.8672L69.9675 86.7121L67.3871 86.2427L61.9735 78.6852L56.4587 70.2359L52.0064 62.6315L51.4687 62.971L48.8189 91.2654L47.6047 92.7206L44.7714 93.8002L42.3934 92.0164L41.1286 89.1061L42.3934 83.3324L43.9113 75.8219L45.1255 69.8604L46.2386 62.4437L46.9184 59.9661L46.8583 59.8003L46.3153 59.8916L40.7238 67.5603L32.2239 79.0608L25.4948 86.2427L23.8758 86.8999L21.0931 85.4447L21.3461 82.863L22.9145 80.5629L32.2239 68.7338L37.8399 61.3641L41.4594 57.1337L41.4242 56.5218L41.2244 56.5048L16.489 72.6299L12.0873 73.1932L10.1647 71.4094L10.4176 68.4991L11.3283 67.5603L18.7657 62.4437Z"/></svg>"##;
const GOOGLE_ICON: &str = r##"<svg viewBox="0 0 24 24" width="32" height="32" aria-hidden="true"><path fill="#4285F4" d="M21.6 12.2c0-.7-.1-1.4-.2-2H12v3.8h5.4a4.7 4.7 0 0 1-2 3v2.5h3.2c1.9-1.8 3-4.3 3-7.3Z"/><path fill="#34A853" d="M12 22c2.7 0 5-.9 6.6-2.5L15.4 17c-.9.6-2 1-3.4 1-2.6 0-4.8-1.8-5.6-4.2H3.1v2.6A10 10 0 0 0 12 22Z"/><path fill="#FBBC05" d="M6.4 13.8A6 6 0 0 1 6.1 12c0-.6.1-1.2.3-1.8V7.6H3.1A10 10 0 0 0 2 12c0 1.6.4 3.1 1.1 4.4l3.3-2.6Z"/><path fill="#EA4335" d="M12 6c1.5 0 2.8.5 3.8 1.5l2.9-2.8A9.7 9.7 0 0 0 12 2a10 10 0 0 0-8.9 5.6l3.3 2.6C7.2 7.8 9.4 6 12 6Z"/></svg>"##;
const GROK_ICON: &str = r##"<svg viewBox="0 0 24 24" width="32" height="32" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M9.27 15.29l7.978-5.897c.391-.29.95-.177 1.137.272.98 2.369.542 5.215-1.41 7.169-1.951 1.954-4.667 2.382-7.149 1.406l-2.711 1.257c3.889 2.661 8.611 2.003 11.562-.953 2.341-2.344 3.066-5.539 2.388-8.42l.006.007c-.983-4.232.242-5.924 2.75-9.383.06-.082.12-.164.179-.248l-3.301 3.305v-.01L9.267 15.292M7.623 16.723c-2.792-2.67-2.31-6.801.071-9.184 1.761-1.763 4.647-2.483 7.166-1.425l2.705-1.25a7.808 7.808 0 00-1.829-1A8.975 8.975 0 005.984 5.83c-2.533 2.536-3.33 6.436-1.962 9.764 1.022 2.487-.653 4.246-2.34 6.022-.599.63-1.199 1.259-1.682 1.925l7.62-6.815"/></svg>"##;
const OPENCODE_ICON: &str = r##"<svg viewBox="-30 0 300 300" width="32" height="32" aria-hidden="true"><path fill="#4b4646" d="M180 240H60V120H180V240Z"/><path fill="#f1ecec" d="M180 60H60V240H180V60ZM240 300H0V0H240V300Z"/></svg>"##;

fn provider_icon_svg(provider: &Provider) -> &'static str {
    match provider {
        Provider::Openai => OPENAI_ICON,
        Provider::Anthropic => CLAUDE_ICON,
        Provider::Antigravity | Provider::GoogleAiStudio => GOOGLE_ICON,
        Provider::Grok => GROK_ICON,
        Provider::OpencodeGo => OPENCODE_ICON,
    }
}

/// The page shown after a provider connects: the provider's icon and name side by side, then
/// the signed-in email (or the account label when no email is known and it adds something),
/// with a 5-second visual countdown before automatic close.
pub(crate) fn account_connected_html(title: &str, account: &Account) -> String {
    connected_html(title, account, COUNTDOWN_SCRIPT)
}

/// The page's own countdown, for the loopback callback page. The `data:` copy
/// (`connected_page_url`) leaves it out: that page inherits the Content Security
/// Policy of the provider page it replaces (grok.com allows only nonce scripts),
/// so the app runs its countdown instead (`run_connected_countdown`).
const COUNTDOWN_SCRIPT: &str = "<script>let s=5;const el=document.getElementById('sec');const t=setInterval(()=>{s--;if(el)el.textContent=String(Math.max(0,s));if(s<=0){clearInterval(t);window.close();}},1000);</script>";

fn connected_html(title: &str, account: &Account, countdown_script: &str) -> String {
    let provider_name = account.provider.display_name();
    let identity = account
        .email
        .as_deref()
        .map(str::trim)
        .filter(|email| !email.is_empty())
        .or_else(|| {
            let label = account.label.trim();
            (!label.is_empty() && label != provider_name).then_some(label)
        });
    let identity_html = identity
        .map(|value| {
            format!(
                r#"<p style="margin:0 0 18px;font-size:16px;color:#a078ff;font-weight:600">{}</p>"#,
                escape_html(value)
            )
        })
        .unwrap_or_default();
    format!(
        r#"<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0;min-height:100vh;min-height:100dvh;box-sizing:border-box;display:flex;flex-direction:column;align-items:center;justify-content:center;background:#000000;color:#f4f6f8;font-family:system-ui;padding:24px 20px;text-align:center"><div style="max-width:480px;width:100%"><h1 style="margin:0 0 12px;font-size:28px">{}</h1><div style="display:flex;justify-content:center;align-items:center;gap:10px;margin:8px 0 18px;font-size:20px;font-weight:600">{}<span>{}</span></div>{}<p style="color:#8e9791;margin:0 0 6px">Returning to AI Usage Tracker in</p><div style="font-size:48px;font-weight:700;line-height:1.1;margin:0 0 16px;color:#a078ff"><span id="sec">5</span></div><p style="color:#626b65;font-size:13px;margin:0">You can also close this tab manually.</p></div>{}</body></html>"#,
        escape_html(title),
        provider_icon_svg(&account.provider),
        escape_html(provider_name),
        identity_html,
        countdown_script
    )
}

/// The page for a request to the callback that does not carry the attempt's
/// `state`: not the provider's redirect, so it changes nothing.
pub(crate) fn unrecognized_callback_response() -> axum::response::Response {
    callback_html(auth_failure_html(
        "Sign-in not recognized",
        "This page did not come from the sign-in you started in AI Usage Tracker.",
    ))
}

pub(crate) fn auth_failure_html(title: &str, message: &str) -> String {
    format!(
        r#"<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0;min-height:100vh;min-height:100dvh;box-sizing:border-box;display:flex;flex-direction:column;align-items:center;justify-content:center;background:#000000;color:#f4f6f8;font-family:system-ui;padding:24px 20px;text-align:center"><div style="max-width:480px;width:100%"><h1 style="margin:0 0 12px;font-size:28px">{}</h1><p style="color:#ff9d9d;margin:0 0 12px">{}</p><p style="color:#8e9791;margin:0">Return to the app and try again.</p></div></body></html>"#,
        escape_html(title),
        escape_html(message)
    )
}

/// Calculates logical width, height, and (x, y) coordinates to center a window over
/// a target window, covering the requested ratio of the target's dimensions while
/// respecting minimum sizes and monitor bounds.
#[cfg(desktop)]
pub(crate) fn calculate_centered_geometry(
    target_pos: (f64, f64),
    target_size: (f64, f64),
    monitor_bounds: Option<((f64, f64), (f64, f64))>,
    width_ratio: f64,
    height_ratio: f64,
    min_width: f64,
    min_height: f64,
) -> (f64, f64, (f64, f64)) {
    let (target_x, target_y) = target_pos;
    let (target_w, target_h) = target_size;

    let width = if width_ratio > 0.0 {
        (target_w * width_ratio).max(min_width)
    } else {
        min_width
    };

    let height = if height_ratio > 0.0 {
        (target_h * height_ratio).max(min_height)
    } else {
        min_height
    };

    let mut x = target_x + (target_w - width) / 2.0;
    let mut y = target_y + (target_h - height) / 2.0;

    if let Some(((mon_left, mon_top), (mon_right, mon_bottom))) = monitor_bounds {
        if x + width > mon_right {
            x = (mon_right - width).max(mon_left);
        }
        if x < mon_left {
            x = mon_left;
        }
        if y + height > mon_bottom {
            y = (mon_bottom - height).max(mon_top);
        }
        if y < mon_top {
            y = mon_top;
        }
    }

    (width, height, (x, y))
}

/// Returns the logical width, height, and optional (x, y) position to open a window
/// centered directly on `target_window_label` (falling back to `"main"`).
#[cfg(desktop)]
pub(crate) fn window_geometry_centered_on(
    handle: &tauri::AppHandle,
    target_window_label: &str,
    width_ratio: f64,
    height_ratio: f64,
    min_width: f64,
    min_height: f64,
) -> (f64, f64, Option<(f64, f64)>) {
    use tauri::Manager;
    let target = handle
        .get_webview_window(target_window_label)
        .or_else(|| handle.get_webview_window("main"));

    let Some(window) = target else {
        return (min_width.max(1080.0), min_height.max(760.0), None);
    };

    let Ok(pos) = window.outer_position() else {
        return (min_width.max(1080.0), min_height.max(760.0), None);
    };
    let Ok(size) = window.outer_size() else {
        return (min_width.max(1080.0), min_height.max(760.0), None);
    };
    let scale = window.scale_factor().unwrap_or(1.0).max(0.1);

    let target_pos = (pos.x as f64 / scale, pos.y as f64 / scale);
    let target_size = (size.width as f64 / scale, size.height as f64 / scale);

    let (width, height, (x, y)) = calculate_centered_geometry(
        target_pos,
        target_size,
        None,
        width_ratio,
        height_ratio,
        min_width,
        min_height,
    );

    crate::diagnostics::info(&format!(
        "Centering login window on '{target_window_label}': target pos=({:.1}, {:.1}) size=({:.1}, {:.1}), computed size=({:.1}, {:.1}) pos=({:.1}, {:.1})",
        target_pos.0, target_pos.1, target_size.0, target_size.1, width, height, x, y
    ));

    (width, height, Some((x, y)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::LoginState;

    fn fields(label: &str) -> ConnectedFields {
        ConnectedFields {
            label: label.into(),
            provider: Provider::Grok,
            email: Some("new@example.com".into()),
            provider_account_id: Some("pid".into()),
            chatgpt_account_id: None,
            plan: Some("SuperGrok".into()),
        }
    }

    #[test]
    fn merge_into_existing_makes_a_new_account_when_there_is_no_duplicate() {
        let merged = merge_into_existing(None, fields("Work"));
        assert!(!merged.id.is_empty());
        assert_eq!(merged.label, "Work");
        assert_eq!(merged.email.as_deref(), Some("new@example.com"));
        assert_eq!(merged.created_at, merged.updated_at);
        assert!(merged.last_usage.is_none());
        assert!(merged.last_error.is_none() && !merged.auth_required);
        let other = merge_into_existing(None, fields("Work"));
        assert_ne!(merged.id, other.id);
    }

    #[test]
    fn merge_into_existing_keeps_the_stored_accounts_identity_and_clears_its_error() {
        let mut stored = account(Provider::Grok, Some("old@example.com"), "Old");
        stored.id = "stored-id".into();
        stored.created_at = "2020-01-01T00:00:00Z".into();
        stored.last_error = Some("expired".into());
        stored.auth_required = true;

        let merged = merge_into_existing(Some(&stored), fields("Renamed"));

        assert_eq!(merged.id, "stored-id");
        assert_eq!(merged.created_at, "2020-01-01T00:00:00Z");
        assert_ne!(merged.updated_at, "2020-01-01T00:00:00Z");
        assert_eq!(merged.label, "Renamed");
        // The sign-in's own values win; the caller decides about fallbacks.
        assert_eq!(merged.email.as_deref(), Some("new@example.com"));
        assert!(merged.last_error.is_none());
        assert!(!merged.auth_required);
    }

    fn account(provider: Provider, email: Option<&str>, label: &str) -> Account {
        Account {
            id: String::new(),
            label: label.to_string(),
            provider,
            email: email.map(str::to_string),
            provider_account_id: None,
            chatgpt_account_id: None,
            plan: None,
            created_at: String::new(),
            updated_at: String::new(),
            last_usage: None,
            last_error: None,
            auth_required: false,
        }
    }

    #[test]
    fn connected_page_shows_icon_name_then_email_for_every_provider() {
        for provider in [
            Provider::Openai,
            Provider::Anthropic,
            Provider::Antigravity,
            Provider::GoogleAiStudio,
            Provider::Grok,
            Provider::OpencodeGo,
        ] {
            let name = provider.display_name();
            let html = account_connected_html(
                "Account connected",
                &account(provider, Some("me@example.com"), "My label"),
            );
            let svg = html.find("<svg").expect("icon");
            let name_at = html.find(&format!("<span>{name}</span>")).expect("name");
            let email = html.find("me@example.com").expect("email");
            assert!(svg < name_at && name_at < email, "{name}");
        }
    }

    #[test]
    fn connected_page_skips_a_label_that_only_repeats_the_provider_name() {
        let html = account_connected_html(
            "Account connected",
            &account(Provider::Openai, None, "ChatGPT"),
        );
        assert_eq!(html.matches("ChatGPT").count(), 1);
    }

    #[test]
    fn connected_page_includes_countdown_and_auto_close_script() {
        let html = account_connected_html(
            "Account connected",
            &account(Provider::Anthropic, Some("test@example.com"), "Claude"),
        );
        assert!(html.contains(r#"Returning to AI Usage Tracker in"#));
        assert!(html.contains(r#"<span id="sec">5</span>"#));
        assert!(html.contains("font-size:48px"));
        assert!(html.contains("color:#a078ff"));
        // The brand fill is too dark to read as text on the black page.
        assert!(!html.contains("color:#6d3bd7"));
        assert!(html.contains("window.close()"));
        assert_eq!(CONNECTED_PAGE_DISPLAY, Duration::from_secs(5));
    }

    #[test]
    fn connected_and_failure_pages_center_content_on_screen() {
        let connected = account_connected_html(
            "Account connected",
            &account(Provider::Grok, Some("test@example.com"), "Grok"),
        );
        assert!(connected.contains("justify-content:center"));
        assert!(connected.contains("align-items:center"));
        assert!(connected.contains("min-height:100dvh"));
        assert!(connected.contains("background:#000000"));

        let failure = auth_failure_html("Authentication failed", "Invalid state");
        assert!(failure.contains("justify-content:center"));
        assert!(failure.contains("align-items:center"));
        assert!(failure.contains("min-height:100dvh"));
        assert!(failure.contains("background:#000000"));
    }

    #[test]
    fn only_the_connected_page_the_app_made_is_allowed_as_data() {
        let page = connected_page_url(&account(Provider::Grok, Some("test@example.com"), "Grok"))
            .expect("the connected page is a valid data URL");
        assert!(page
            .as_str()
            .starts_with("data:text/html;charset=utf-8;base64,"));
        // The page inherits the provider page's Content Security Policy, so its
        // countdown is run by the app (run_connected_countdown), not inline script.
        let encoded = page.as_str().rsplit(',').next().unwrap();
        let html = String::from_utf8(STANDARD.decode(encoded).unwrap()).unwrap();
        assert!(html.contains(r#"<span id="sec">5</span>"#));
        assert!(!html.contains("<script"));
        assert!(is_connected_page(&page));
        assert!(is_result_page(&page));
        for other in [
            "data:text/html,<script>1</script>",
            "data:text/html;charset=utf-8;base64,PHNjcmlwdD4xPC9zY3JpcHQ+",
            "https://grok.com/",
        ] {
            let url = Url::parse(other).unwrap();
            assert!(!is_connected_page(&url), "{other}");
        }
        assert!(is_result_page(
            &Url::parse("http://127.0.0.1:1455/auth/callback?code=x&state=y").unwrap()
        ));
    }

    #[test]
    fn pkce_challenge_matches_the_rfc_7636_example() {
        assert_eq!(
            pkce_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn random_base64_is_url_safe_and_unique() {
        let a = random_base64(32);
        let b = random_base64(32);
        assert_ne!(a, b);
        assert_eq!(a.len(), 43);
        assert!(a
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
    }

    #[test]
    fn failure_page_escapes_the_message() {
        let page = auth_failure_html("Authentication failed", "<script>alert(1)</script>");
        assert!(page.contains("Authentication failed"));
        assert!(page.contains("&lt;script&gt;"));
        assert!(!page.contains("<script>"));
    }

    fn test_app() -> (Arc<AppState>, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let app = Arc::new(AppState::new(dir.path().to_path_buf(), "token".into()).unwrap());
        (app, dir)
    }

    fn waiting(attempt_id: &str, status: LoginState) -> crate::model::LoginStatus {
        crate::model::LoginStatus {
            attempt_id: attempt_id.into(),
            status,
            message: None,
            account: None,
            projects: None,
            selected_project_id: None,
        }
    }

    #[tokio::test]
    async fn the_callback_server_answers_until_it_is_shut_down() {
        let (app, _dir) = test_app();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (stop, shutdown) = oneshot::channel();
        let router = Router::new().route("/callback", axum::routing::get(|| async { "hello" }));
        spawn_callback_server(
            app,
            "a1".into(),
            listener,
            router,
            shutdown,
            "Callback server failed",
            |_| {},
        );

        let url = format!("http://{addr}/callback");
        assert_eq!(
            reqwest::get(&url).await.unwrap().text().await.unwrap(),
            "hello"
        );
        stop.send(()).unwrap();
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(
            reqwest::get(&url).await.is_err(),
            "the port should be released after shutdown"
        );
    }

    #[tokio::test]
    async fn the_timeout_fails_a_still_waiting_attempt_once() {
        let (app, _dir) = test_app();
        *app.pending_login.write() = Some(waiting("a1", LoginState::Waiting));
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        spawn_login_timeout(
            app.clone(),
            "a1".into(),
            Duration::from_millis(20),
            "timed out".into(),
            move |message| {
                tx.send(message).unwrap();
            },
        );
        assert_eq!(rx.recv().await.as_deref(), Some("timed out"));
    }

    #[tokio::test]
    async fn the_timeout_leaves_a_finished_or_different_attempt_alone() {
        let (app, _dir) = test_app();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
        for (attempt, status) in [
            ("a1", LoginState::Complete),
            ("someone-else", LoginState::Waiting),
        ] {
            *app.pending_login.write() = Some(waiting(attempt, status));
            let tx = tx.clone();
            spawn_login_timeout(
                app.clone(),
                "a1".into(),
                Duration::from_millis(20),
                "timed out".into(),
                move |message| {
                    tx.send(message).unwrap();
                },
            );
        }
        drop(tx);
        tokio::time::sleep(Duration::from_millis(120)).await;
        assert!(rx.try_recv().is_err());
    }

    #[cfg(desktop)]
    #[test]
    fn centers_window_over_target_window() {
        let target_pos = (100.0, 100.0);
        let target_size = (1440.0, 850.0);
        let (width, height, (x, y)) =
            calculate_centered_geometry(target_pos, target_size, None, 0.96, 0.96, 820.0, 620.0);
        assert!((width - 1382.4).abs() < 1e-4);
        assert!((height - 816.0).abs() < 1e-4);
        let target_center_x = target_pos.0 + target_size.0 / 2.0;
        let target_center_y = target_pos.1 + target_size.1 / 2.0;
        let window_center_x = x + width / 2.0;
        let window_center_y = y + height / 2.0;
        assert!((target_center_x - window_center_x).abs() < 1e-4);
        assert!((target_center_y - window_center_y).abs() < 1e-4);
    }

    #[cfg(desktop)]
    #[test]
    fn fixed_size_window_centers_over_target() {
        let target_pos = (200.0, 150.0);
        let target_size = (1000.0, 700.0);
        let (width, height, (x, y)) =
            calculate_centered_geometry(target_pos, target_size, None, 0.0, 0.0, 640.0, 800.0);
        assert_eq!(width, 640.0);
        assert_eq!(height, 800.0);
        let target_center_x = target_pos.0 + target_size.0 / 2.0;
        let target_center_y = target_pos.1 + target_size.1 / 2.0;
        assert_eq!(x + width / 2.0, target_center_x);
        assert_eq!(y + height / 2.0, target_center_y);
    }

    #[cfg(desktop)]
    #[test]
    fn clamps_within_monitor_bounds() {
        let target_pos = (1800.0, 900.0);
        let target_size = (500.0, 400.0);
        let monitor = Some(((0.0, 0.0), (1920.0, 1080.0)));
        let (width, height, (x, y)) =
            calculate_centered_geometry(target_pos, target_size, monitor, 0.0, 0.0, 640.0, 800.0);
        assert_eq!(width, 640.0);
        assert_eq!(height, 800.0);
        assert!(x + width <= 1920.0);
        assert!(y + height <= 1080.0);
        assert!(x >= 0.0);
        assert!(y >= 0.0);
    }

    #[cfg(desktop)]
    #[test]
    fn nested_popups_share_the_exact_same_center_point() {
        let main_pos = (350.0, 80.0);
        let main_size = (1440.0, 900.0);
        // Provider login window covers the full main-window width
        let (provider_w, provider_h, (provider_x, provider_y)) =
            calculate_centered_geometry(main_pos, main_size, None, 1.0, 0.96, 820.0, 620.0);
        // Sign-in popup (e.g. Google) centered on provider login window
        let (popup_w, popup_h, (popup_x, popup_y)) = calculate_centered_geometry(
            (provider_x, provider_y),
            (provider_w, provider_h),
            None,
            0.0,
            0.0,
            640.0,
            1040.0,
        );

        let main_center = (
            main_pos.0 + main_size.0 / 2.0,
            main_pos.1 + main_size.1 / 2.0,
        );
        let provider_center = (provider_x + provider_w / 2.0, provider_y + provider_h / 2.0);
        let popup_center = (popup_x + popup_w / 2.0, popup_y + popup_h / 2.0);

        assert!((main_center.0 - provider_center.0).abs() < 1e-4);
        assert!((main_center.1 - provider_center.1).abs() < 1e-4);
        // Full-width coverage: same left edge and width as the main window.
        assert!((provider_x - main_pos.0).abs() < 1e-4);
        assert!((provider_w - main_size.0).abs() < 1e-4);
        assert!((provider_center.0 - popup_center.0).abs() < 1e-4);
        assert!((provider_center.1 - popup_center.1).abs() < 1e-4);
    }
}

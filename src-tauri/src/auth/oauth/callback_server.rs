use super::*;

#[cfg_attr(not(any(test, mobile)), allow(dead_code))]
/// The app's own loopback callback page, as a sign-in window (desktop) or the
/// main window (mobile) loads it.
pub(crate) fn is_loopback_callback(url: &Url) -> bool {
    looks_like_oauth_callback(url) && url.scheme() == "http" && url.username().is_empty()
}

pub(crate) fn looks_like_oauth_callback(url: &Url) -> bool {
    let is_loopback = url
        .host_str()
        .map(|host| {
            let host = host
                .strip_prefix('[')
                .and_then(|h| h.strip_suffix(']'))
                .unwrap_or(host);
            matches!(host, "127.0.0.1" | "localhost" | "::1")
                || host.parse::<IpAddr>().is_ok_and(|ip| ip.is_loopback())
        })
        .unwrap_or(false);
    is_loopback
        && url
            .query_pairs()
            .any(|(key, _)| key == "code" || key == "error")
}

#[cfg_attr(not(any(test, mobile)), allow(dead_code))]
pub(crate) fn callback_query_from_url(url: &Url) -> CallbackQuery {
    let mut query = CallbackQuery {
        code: None,
        state: None,
        error: None,
        error_description: None,
    };
    for (key, value) in url.query_pairs() {
        match key.as_ref() {
            "code" => query.code = Some(value.into_owned()),
            "state" => query.state = Some(value.into_owned()),
            "error" => query.error = Some(value.into_owned()),
            "error_description" => query.error_description = Some(value.into_owned()),
            _ => {}
        }
    }
    query
}

pub(super) async fn callback(
    State(context): State<Arc<LoginContext>>,
    Query(query): Query<CallbackQuery>,
) -> axum::response::Response {
    handle_callback(context, query).await.into_response()
}

pub(super) async fn handle_callback(
    context: Arc<LoginContext>,
    query: CallbackQuery,
) -> axum::response::Response {
    // Only the provider's redirect carries this attempt's state. Any other
    // request to the callback (a local process, or a web page that knows the
    // port) is answered without claiming the callback, failing the sign-in, or
    // showing its text in the app.
    if query.state.as_deref() != Some(context.expected_state.as_str()) {
        return crate::auth::oauth_common::unrecognized_callback_response();
    }
    if context
        .callback_claimed
        .swap(true, std::sync::atomic::Ordering::SeqCst)
    {
        return callback_html(
            r#"<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0;min-height:100vh;min-height:100dvh;box-sizing:border-box;display:flex;flex-direction:column;align-items:center;justify-content:center;background:#000000;color:#f4f6f8;font-family:system-ui;padding:24px 20px;text-align:center"><div style="max-width:480px;width:100%"><h1 style="margin:0 0 12px;font-size:28px">Finishing sign-in</h1><p style="color:#d1d5db;margin:0">Return to AI Usage Tracker.</p></div></body></html>"#
                .into(),
        );
    }
    if let Some(error) = query.error {
        let message = query.error_description.unwrap_or(error);
        context
            .app
            .fail_login_if_waiting(&context.attempt_id, message.clone());
        stop_callback(&context).await;
        return callback_html(auth_failure_html("Authentication failed", &message));
    }
    let code = match query.code {
        Some(code) => code,
        None => {
            let message = format!(
                "{} did not return an authorization code.",
                context.provider.display_name()
            );
            context
                .app
                .fail_login_if_waiting(&context.attempt_id, message.clone());
            stop_callback(&context).await;
            return callback_html(auth_failure_html("Authentication failed", &message));
        }
    };
    if !context.app.login_is_waiting(&context.attempt_id) {
        stop_callback(&context).await;
        return callback_html(
            r#"<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0;min-height:100vh;min-height:100dvh;box-sizing:border-box;display:flex;flex-direction:column;align-items:center;justify-content:center;background:#000000;color:#f4f6f8;font-family:system-ui;padding:24px 20px;text-align:center"><div style="max-width:480px;width:100%"><h1 style="margin:0;font-size:28px">Login canceled</h1></div></body></html>"#
                .into(),
        );
    }

    match complete_exchange(&context, &code).await {
        Ok(account) => {
            stop_callback(&context).await;
            callback_html(account_connected_html("Account connected", &account))
        }
        Err(error) => {
            if error.is_retryable() && context.app.login_is_waiting(&context.attempt_id) {
                {
                    let mut pending = context.app.pending_auth_exchange.lock();
                    *pending = Some(crate::state::PendingAuthExchange {
                        attempt_id: context.attempt_id.clone(),
                        provider: context.provider.clone(),
                        label: context.label.clone(),
                        reconnect_account_id: context.reconnect_account_id.clone(),
                        code,
                        verifier: context.verifier.clone(),
                        expected_state: context.expected_state.clone(),
                        redirect_uri: context.redirect_uri.clone(),
                    });
                }
                stop_callback(&context).await;
                callback_html(
                    r#"<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0;min-height:100vh;min-height:100dvh;box-sizing:border-box;display:flex;flex-direction:column;align-items:center;justify-content:center;background:#000000;color:#f4f6f8;font-family:system-ui;padding:24px 20px;text-align:center"><div style="max-width:480px;width:100%"><h1 style="color:#4ade80;margin:0 0 12px;font-size:28px">Authorization received</h1><p style="color:#d1d5db;font-size:16px;margin:16px 0 0">Return to AI Usage Tracker to complete connection.</p></div></body></html>"#
                        .into(),
                )
            } else {
                context
                    .app
                    .fail_login_if_waiting(&context.attempt_id, error.message().to_string());
                stop_callback(&context).await;
                callback_html(auth_failure_html("Authentication failed", error.message()))
            }
        }
    }
}

/// HTTP origin for a bound loopback socket, with IPv6 literals bracketed.
pub(crate) fn loopback_http_origin(addr: SocketAddr) -> String {
    match addr.ip() {
        IpAddr::V4(ip) => format!("http://{ip}:{}", addr.port()),
        IpAddr::V6(ip) => format!("http://[{ip}]:{}", addr.port()),
    }
}

pub(crate) async fn bind_loopback_listener(port: u16) -> std::io::Result<TcpListener> {
    match TcpListener::bind(("127.0.0.1", port)).await {
        Ok(listener) => Ok(listener),
        Err(error) if error.kind() == std::io::ErrorKind::AddrInUse => Err(error),
        Err(ipv4_error) => match TcpListener::bind(("::1", port)).await {
            Ok(listener) => Ok(listener),
            Err(_) => Err(ipv4_error),
        },
    }
}

pub(crate) async fn bind_ephemeral_loopback() -> Result<(TcpListener, SocketAddr), String> {
    let listener = bind_loopback_listener(0)
        .await
        .map_err(|error| format!("Unable to start OAuth callback server: {error}"))?;
    let addr = listener
        .local_addr()
        .map_err(|error| format!("Unable to read OAuth callback address: {error}"))?;
    Ok((listener, addr))
}

pub(super) async fn bind_callback_port(
    provider: &Provider,
) -> Result<(TcpListener, SocketAddr), String> {
    if matches!(provider, Provider::Antigravity) {
        return bind_ephemeral_loopback().await;
    }
    let ports: Vec<u16> = match provider {
        Provider::Openai => OPENAI_CALLBACK_PORTS.to_vec(),
        Provider::Anthropic => (53692..=53696).collect(),
        Provider::Antigravity => Vec::new(),
        Provider::GoogleAiStudio | Provider::Grok | Provider::OpencodeGo => Vec::new(),
    };
    for port in ports {
        match bind_loopback_listener(port).await {
            Ok(listener) => {
                let addr = listener
                    .local_addr()
                    .map_err(|error| format!("Unable to read OAuth callback address: {error}"))?;
                return Ok((listener, addr));
            }
            Err(error) if error.kind() == std::io::ErrorKind::AddrInUse => continue,
            Err(error) => return Err(format!("Unable to start OAuth callback server: {error}")),
        }
    }
    Err(if matches!(provider, Provider::Openai) {
        "ChatGPT login needs localhost port 1455 (or 1457). Close another ChatGPT login and try again.".into()
    } else {
        format!(
            "No callback port is available for {}.",
            provider.display_name()
        )
    })
}

pub(super) async fn stop_callback(context: &LoginContext) {
    context.app.stop_login_shutdown(&context.attempt_id);
}

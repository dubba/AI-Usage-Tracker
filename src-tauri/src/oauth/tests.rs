use super::*;
use crate::model::now_rfc3339;

#[test]
fn extracts_openai_claims() {
    let payload = serde_json::json!({
        "email": "person@example.com",
        "exp": 2000000000,
        "https://api.openai.com/auth": {
            "chatgpt_account_id": "acct_123",
            "chatgpt_plan_type": "plus"
        }
    });
    let token = format!("x.{}.y", URL_SAFE_NO_PAD.encode(payload.to_string()));
    let claims = decode_claims(&token).unwrap();
    assert_eq!(claims.email.as_deref(), Some("person@example.com"));
    assert_eq!(claims.account_id.as_deref(), Some("acct_123"));
    assert_eq!(claims.plan.as_deref(), Some("plus"));
}

fn reconnect_context(app: Arc<AppState>, target: Option<&str>) -> LoginContext {
    LoginContext {
        app,
        attempt_id: "attempt".into(),
        label: "Work".into(),
        reconnect_account_id: target.map(str::to_string),
        provider: Provider::Openai,
        verifier: "v".into(),
        expected_state: "s".into(),
        redirect_uri: "http://localhost:1455/auth/callback".into(),
        callback_claimed: Arc::new(std::sync::atomic::AtomicBool::new(false)),
    }
}

fn stored_openai(app: &AppState, email: Option<&str>, account_id: Option<&str>) -> Account {
    let now = now_rfc3339();
    app.store
        .upsert(Account {
            id: "existing".into(),
            label: "Work".into(),
            provider: Provider::Openai,
            email: email.map(str::to_string),
            provider_account_id: account_id.map(str::to_string),
            chatgpt_account_id: account_id.map(str::to_string),
            plan: None,
            created_at: now.clone(),
            updated_at: now,
            last_usage: None,
            last_error: Some("expired".into()),
            auth_required: true,
        })
        .unwrap()
}

#[test]
fn reconnect_updates_the_account_even_when_sign_in_reports_a_different_id() {
    let temp = tempfile::tempdir().unwrap();
    let app = Arc::new(AppState::new(temp.path().to_path_buf(), "t".into()).unwrap());
    stored_openai(&app, Some("me@example.com"), Some("acct_old"));
    let context = reconnect_context(app, Some("existing"));
    let identity = ProviderIdentity {
        email: Some("ME@example.com".into()),
        account_id: Some("user-sub".into()),
        plan: None,
    };
    assert_eq!(
        find_account_to_update(&context, &identity).map(|a| a.id),
        Some("existing".into())
    );
}

#[test]
fn reconnect_updates_the_account_when_sign_in_reports_no_identity() {
    let temp = tempfile::tempdir().unwrap();
    let app = Arc::new(AppState::new(temp.path().to_path_buf(), "t".into()).unwrap());
    stored_openai(&app, Some("me@example.com"), Some("acct_old"));
    let context = reconnect_context(app, Some("existing"));
    assert_eq!(
        find_account_to_update(&context, &ProviderIdentity::default()).map(|a| a.id),
        Some("existing".into())
    );
}

#[test]
fn reconnect_does_not_overwrite_an_account_when_a_different_person_signs_in() {
    let temp = tempfile::tempdir().unwrap();
    let app = Arc::new(AppState::new(temp.path().to_path_buf(), "t".into()).unwrap());
    stored_openai(&app, Some("me@example.com"), Some("acct_old"));
    let context = reconnect_context(app, Some("existing"));
    let identity = ProviderIdentity {
        email: Some("other@example.com".into()),
        account_id: Some("acct_other".into()),
        plan: None,
    };
    assert!(find_account_to_update(&context, &identity).is_none());
}

#[test]
fn reconnect_without_a_stored_email_rejects_a_conflicting_account_id() {
    let temp = tempfile::tempdir().unwrap();
    let app = Arc::new(AppState::new(temp.path().to_path_buf(), "t".into()).unwrap());
    stored_openai(&app, None, Some("acct_old"));
    let context = reconnect_context(app, Some("existing"));
    let identity = ProviderIdentity {
        email: Some("other@example.com".into()),
        account_id: Some("acct_other".into()),
        plan: None,
    };
    assert!(find_account_to_update(&context, &identity).is_none());
}

#[test]
fn id_token_claims_fill_identity_gaps() {
    let payload = serde_json::json!({
        "email": "person@example.com",
        "https://api.openai.com/auth": { "chatgpt_account_id": "acct_123" }
    });
    let token = format!("x.{}.y", URL_SAFE_NO_PAD.encode(payload.to_string()));
    let claims = decode_claims(&token).unwrap();
    assert_eq!(claims.account_id.as_deref(), Some("acct_123"));
}

#[test]
fn openai_identity_comes_from_userinfo() {
    let userinfo = serde_json::json!({
        "email": "person@example.com",
        "https://api.openai.com/auth": {
            "chatgpt_account_id": "acct_123",
            "chatgpt_plan_type": "plus"
        }
    });
    let identity = identity_from_userinfo(&userinfo);
    assert_eq!(identity.email.as_deref(), Some("person@example.com"));
    assert_eq!(identity.account_id.as_deref(), Some("acct_123"));
    assert_eq!(identity.plan.as_deref(), Some("plus"));
}

#[test]
fn oauth_redirects_use_loopback_ipv4() {
    let openai: SocketAddr = "127.0.0.1:1455".parse().unwrap();
    let openai_fallback: SocketAddr = "127.0.0.1:1457".parse().unwrap();
    let anthropic: SocketAddr = "127.0.0.1:53692".parse().unwrap();
    let antigravity: SocketAddr = "127.0.0.1:11451".parse().unwrap();
    assert_eq!(
        redirect_uri(&Provider::Openai, openai),
        "http://localhost:1455/auth/callback"
    );
    assert_eq!(
        redirect_uri(&Provider::Openai, openai_fallback),
        "http://localhost:1457/auth/callback"
    );
    assert_eq!(
        redirect_uri(&Provider::Anthropic, anthropic),
        "http://localhost:53692/callback"
    );
    assert_eq!(
        redirect_uri(&Provider::Antigravity, antigravity),
        "http://127.0.0.1:11451"
    );
    assert_eq!(loopback_http_origin(antigravity), "http://127.0.0.1:11451");
}

#[tokio::test]
async fn ephemeral_loopback_advertises_the_bound_address() {
    let (listener, addr) = bind_ephemeral_loopback().await.unwrap();
    assert!(addr.ip().is_loopback());
    let origin = loopback_http_origin(addr);
    if addr.is_ipv6() {
        assert!(
            origin.starts_with("http://[") && origin.contains("]:"),
            "IPv6 loopback origin must bracket the host: {origin}"
        );
    } else {
        assert!(
            origin.starts_with("http://127.0.0.1:"),
            "IPv4 loopback origin should use 127.0.0.1: {origin}"
        );
    }
    drop(listener);
}

#[test]
fn oauth_redirects_bracket_loopback_ipv6() {
    let antigravity: SocketAddr = "[::1]:11451".parse().unwrap();
    let openai: SocketAddr = "[::1]:1455".parse().unwrap();
    assert_eq!(
        redirect_uri(&Provider::Antigravity, antigravity),
        "http://[::1]:11451"
    );
    assert_eq!(loopback_http_origin(antigravity), "http://[::1]:11451");
    assert_eq!(
        redirect_uri(&Provider::Openai, openai),
        "http://localhost:1455/auth/callback"
    );
}

#[test]
fn anthropic_authorize_url_omits_unused_scopes() {
    let url = build_authorization_url(
        &Provider::Anthropic,
        "http://localhost:53692/callback",
        "challenge",
        "state",
        None,
    )
    .unwrap();
    let parsed = Url::parse(&url).unwrap();
    let pairs: Vec<(String, String)> = parsed
        .query_pairs()
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect();
    assert_eq!(
        pairs
            .iter()
            .find(|(key, _)| key == "client_id")
            .map(|(_, value)| value.as_str()),
        Some(ANTHROPIC_CLIENT_ID)
    );
    assert_eq!(
        pairs
            .iter()
            .find(|(key, _)| key == "redirect_uri")
            .map(|(_, value)| value.as_str()),
        Some("http://localhost:53692/callback")
    );
    // `prompt=login` asks claude.ai to show its sign-in page even when a
    // session exists, so connecting a second account does not skip
    // straight to the consent screen for the first one.
    assert!(pairs
        .iter()
        .any(|(key, value)| key == "prompt" && value == "login"));
    assert!(pairs
        .iter()
        .any(|(key, value)| key == "code" && value == "true"));
    assert_eq!(
        pairs
            .iter()
            .find(|(key, _)| key == "response_type")
            .map(|(_, value)| value.as_str()),
        Some("code")
    );
    assert_eq!(
        pairs
            .iter()
            .find(|(key, _)| key == "code_challenge_method")
            .map(|(_, value)| value.as_str()),
        Some("S256")
    );
    let scopes = pairs
        .iter()
        .find(|(key, _)| key == "scope")
        .map(|(_, value)| value.as_str())
        .unwrap();
    assert_eq!(scopes, ANTHROPIC_SCOPES);
    for unused in [
        "org:create_api_key",
        "user:sessions:claude_code",
        "user:mcp_servers",
        "user:file_upload",
    ] {
        assert!(!scopes.split_whitespace().any(|scope| scope == unused));
    }
}

#[test]
fn antigravity_authorize_url_uses_cloud_platform_scope() {
    let url = build_authorization_url(
        &Provider::Antigravity,
        "http://127.0.0.1:11451",
        "challenge",
        "state",
        None,
    )
    .unwrap();
    let parsed = Url::parse(&url).unwrap();
    let pairs: Vec<(String, String)> = parsed
        .query_pairs()
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect();
    // `select_account` forces Google's account chooser so a second account
    // can be added while one session is active; `consent` keeps the
    // refresh token coming for that second account.
    assert_eq!(
        pairs
            .iter()
            .find(|(key, _)| key == "prompt")
            .map(|(_, value)| value.as_str()),
        Some("select_account consent")
    );
    assert_eq!(
        pairs
            .iter()
            .find(|(key, _)| key == "access_type")
            .map(|(_, value)| value.as_str()),
        Some("offline")
    );
    let scopes = pairs
        .iter()
        .find(|(key, _)| key == "scope")
        .map(|(_, value)| value.as_str())
        .unwrap();
    assert_eq!(scopes, ANTIGRAVITY_SCOPES);
    assert!(!pairs.iter().any(|(key, _)| key == "include_granted_scopes"));
    for unused in [
        "https://www.googleapis.com/auth/cclog",
        "https://www.googleapis.com/auth/experimentsandconfigs",
    ] {
        assert!(!scopes.split_whitespace().any(|scope| scope == unused));
    }
    assert!(scopes
        .split_whitespace()
        .any(|scope| scope == "https://www.googleapis.com/auth/cloud-platform"));
}

#[test]
fn detects_loopback_oauth_callback_urls() {
    assert!(looks_like_oauth_callback(
        &Url::parse("http://127.0.0.1:11451/?code=abc&state=xyz").unwrap()
    ));
    assert!(looks_like_oauth_callback(
        &Url::parse("http://127.0.0.1:1455/auth/callback?error=access_denied").unwrap()
    ));
    assert!(looks_like_oauth_callback(
        &Url::parse("http://localhost:1455/auth/callback?code=abc&state=xyz").unwrap()
    ));
    assert!(looks_like_oauth_callback(
        &Url::parse("http://localhost:53692/callback?code=abc&state=xyz").unwrap()
    ));
    assert!(looks_like_oauth_callback(
        &Url::parse("http://[::1]:11451/?code=abc&state=xyz").unwrap()
    ));
    assert!(looks_like_oauth_callback(
        &Url::parse("http://[::1]:1455/auth/callback?error=access_denied").unwrap()
    ));
    assert!(!looks_like_oauth_callback(
        &Url::parse("https://accounts.google.com/o/oauth2/auth?code=abc").unwrap()
    ));
    assert!(!looks_like_oauth_callback(
        &Url::parse("http://127.0.0.1:11451/").unwrap()
    ));
    let query =
        callback_query_from_url(&Url::parse("http://127.0.0.1:11451/?code=abc&state=xyz").unwrap());
    assert_eq!(query.code.as_deref(), Some("abc"));
    assert_eq!(query.state.as_deref(), Some("xyz"));
}

#[test]
fn openai_authorize_url_identifies_this_app() {
    let url = build_authorization_url(
        &Provider::Openai,
        "http://localhost:1455/auth/callback",
        "challenge",
        "state",
        None,
    )
    .unwrap();
    let parsed = Url::parse(&url).unwrap();
    let pairs: Vec<(String, String)> = parsed
        .query_pairs()
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect();
    assert_eq!(
        pairs
            .iter()
            .find(|(key, _)| key == "response_type")
            .map(|(_, value)| value.as_str()),
        Some("code")
    );
    assert_eq!(
        pairs
            .iter()
            .find(|(key, _)| key == "client_id")
            .map(|(_, value)| value.as_str()),
        Some(OPENAI_CLIENT_ID)
    );
    assert_eq!(
        pairs
            .iter()
            .find(|(key, _)| key == "redirect_uri")
            .map(|(_, value)| value.as_str()),
        Some("http://localhost:1455/auth/callback")
    );
    assert_eq!(
        pairs
            .iter()
            .find(|(key, _)| key == "scope")
            .map(|(_, value)| value.as_str()),
        Some("openid profile email offline_access")
    );
    assert_eq!(
        pairs
            .iter()
            .find(|(key, _)| key == "code_challenge_method")
            .map(|(_, value)| value.as_str()),
        Some("S256")
    );
    assert!(pairs
        .iter()
        .any(|(key, value)| key == "id_token_add_organizations" && value == "true"));
    assert!(pairs
        .iter()
        .any(|(key, value)| key == "codex_cli_simplified_flow" && value == "true"));
    assert!(pairs
        .iter()
        .any(|(key, value)| key == "originator" && value == OPENAI_ORIGINATOR));
    assert!(!pairs.iter().any(|(key, _)| key == "audience"));
    // `prompt=login` makes Auth0 show the login page even when an SSO
    // session exists, so a different address can be entered for a second
    // account instead of silently reusing the first.
    assert!(pairs
        .iter()
        .any(|(key, value)| key == "prompt" && value == "login"));
}

#[test]
fn authorize_urls_carry_login_hint_for_the_intended_account() {
    for provider in [Provider::Openai, Provider::Anthropic, Provider::Antigravity] {
        let without = build_authorization_url(
            &provider,
            "http://localhost:1455/auth/callback",
            "challenge",
            "state",
            None,
        )
        .unwrap();
        assert!(
            !Url::parse(&without)
                .unwrap()
                .query_pairs()
                .any(|(key, _)| key == "login_hint"),
            "{provider:?} must omit login_hint without an email"
        );
        // Blank or whitespace-only hints are dropped, never sent empty.
        let blank = build_authorization_url(
            &provider,
            "http://localhost:1455/auth/callback",
            "challenge",
            "state",
            Some("   "),
        )
        .unwrap();
        assert!(
            !Url::parse(&blank)
                .unwrap()
                .query_pairs()
                .any(|(key, _)| key == "login_hint"),
            "{provider:?} must drop a blank login_hint"
        );
        let with = build_authorization_url(
            &provider,
            "http://localhost:1455/auth/callback",
            "challenge",
            "state",
            Some("  second@example.com  "),
        )
        .unwrap();
        assert_eq!(
            Url::parse(&with)
                .unwrap()
                .query_pairs()
                .find(|(key, _)| key == "login_hint")
                .map(|(_, value)| value.into_owned())
                .as_deref(),
            Some("second@example.com"),
            "{provider:?} must hint the intended account, trimmed"
        );
    }
}

#[test]
fn back_button_stays_out_of_sign_in_popups() {
    // Popups share the sign-in window's scripts; only the window itself gets Back.
    assert!(LOGIN_BACK_BUTTON_SCRIPT.contains("if (window.opener) return;"));
    assert!(PROVIDER_LOGIN_POPUP_PREFIX.starts_with(PROVIDER_LOGIN_WINDOW));
    assert_ne!(PROVIDER_LOGIN_POPUP_PREFIX, PROVIDER_LOGIN_WINDOW);
}

#[test]
fn provider_login_window_stays_on_sign_in_pages() {
    for url in [
        "https://accounts.google.com/o/oauth2/auth",
        "https://claude.ai/oauth/authorize",
        "https://auth.openai.com/oauth/authorize",
        "https://appleid.apple.com/auth/authorize",
        "https://login.microsoftonline.com/common/oauth2",
        "about:blank",
        "http://127.0.0.1:1455/auth/callback?code=abc&state=xyz",
        "http://localhost:53692/callback?code=abc",
        "http://[::1]:11451/?code=abc",
    ] {
        assert!(
            is_allowed_provider_login_navigation(&Url::parse(url).unwrap()),
            "{url}"
        );
    }
    for url in [
        "https://evil.example/login",
        "https://claude.ai.evil.example/",
        "https://notgoogle.com/",
        "http://claude.ai/oauth/authorize",
        "https://accounts.google.com:8443/",
        "https://user@accounts.google.com/",
        "javascript:alert(1)",
        "file:///tmp/secret",
        "http://127.0.0.1:1455/",
        "https://accounts.google.com/o/oauth2/auth?ai-usage-tracker-back=1",
        "https://accounts.google.com/o/oauth2/auth?ai-usage-tracker-popup-close=1",
    ] {
        assert!(
            !is_allowed_provider_login_navigation(&Url::parse(url).unwrap()),
            "{url}"
        );
    }
}

#[test]
fn popup_close_request_is_detected_and_blocks_navigation() {
    let close_url =
        Url::parse("https://accounts.google.com/o/oauth2/auth?ai-usage-tracker-popup-close=1")
            .unwrap();
    let other_url = Url::parse("https://accounts.google.com/o/oauth2/auth").unwrap();
    assert!(is_provider_login_popup_close_request(&close_url));
    assert!(!is_provider_login_popup_close_request(&other_url));
    assert!(!is_allowed_provider_login_navigation(&close_url));
    assert!(POPUP_AUTO_CLOSE_SCRIPT.contains("window.close = closeHandler"));
    assert!(POPUP_AUTO_CLOSE_SCRIPT.contains(POPUP_CLOSE_QUERY_FLAG));
    assert!(!POPUP_AUTO_CLOSE_SCRIPT.contains("postMessage"));
}

#[test]
fn provider_login_window_only_starts_on_provider_authorize_hosts() {
    for url in [
        "https://accounts.google.com/o/oauth2/auth",
        "https://claude.ai/oauth/authorize",
        "https://auth.openai.com/oauth/authorize",
    ] {
        assert!(
            is_allowed_provider_login_start(&Url::parse(url).unwrap()),
            "{url}"
        );
    }
    // SSO hosts may appear later in the flow. They are not a start URL,
    // and neither is an arbitrary site or a Back request.
    for url in [
        "https://appleid.apple.com/auth/authorize",
        "https://evil.example/",
        "http://accounts.google.com/o/oauth2/auth",
        "https://accounts.google.com/o/oauth2/auth?ai-usage-tracker-back=1",
    ] {
        assert!(
            !is_allowed_provider_login_start(&Url::parse(url).unwrap()),
            "{url}"
        );
    }
}

#[test]
fn anthropic_identity_prefers_nested_account_email() {
    let profile = serde_json::json!({
        "account": { "uuid": "acct-22", "email": "claude.user@example.com" },
        "organization": { "uuid": "org-1", "name": "Personal" }
    });
    let token = serde_json::json!({
        "access_token": "tok",
        "account": { "email_address": "from-token@example.com" }
    });
    let identity = anthropic_identity(&profile, &token);
    assert_eq!(identity.email.as_deref(), Some("claude.user@example.com"));
    assert_eq!(identity.account_id.as_deref(), Some("acct-22"));
    let from_token = anthropic_identity(&Value::Null, &token);
    assert_eq!(from_token.email.as_deref(), Some("from-token@example.com"));
}

#[test]
fn unverified_id_token_claims_are_informational_only() {
    let payload = serde_json::json!({
        "email": "injected@example.com",
        "sub": "attacker-sub"
    });
    let token = format!("x.{}.y", URL_SAFE_NO_PAD.encode(payload.to_string()));
    let claims = decode_jwt_payload(&token).unwrap();
    assert_eq!(
        claims.get("email").and_then(Value::as_str),
        Some("injected@example.com")
    );
    assert_eq!(
        claims.get("sub").and_then(Value::as_str),
        Some("attacker-sub")
    );
    let empty = identity_from_google_userinfo(&Value::Null);
    assert!(empty.email.is_none());
    assert!(empty.account_id.is_none());
    let identity = identity_from_google_userinfo(&serde_json::json!({
        "email": "real@example.com",
        "id": "google-user-id"
    }));
    assert_eq!(identity.email.as_deref(), Some("real@example.com"));
    assert_eq!(identity.account_id.as_deref(), Some("google-user-id"));
}

#[tokio::test]
async fn login_status_does_not_restore_authorization_code_after_poll() {
    let temp = tempfile::tempdir().unwrap();
    let app = Arc::new(AppState::new(temp.path().to_path_buf(), "test-token".into()).unwrap());
    *app.pending_login.write() = Some(LoginStatus {
        attempt_id: "attempt".into(),
        status: LoginState::Waiting,
        message: None,
        account: None,
        projects: None,
        selected_project_id: None,
    });
    *app.pending_auth_exchange.lock() = Some(crate::state::PendingAuthExchange {
        attempt_id: "attempt".into(),
        provider: Provider::GoogleAiStudio,
        label: "Test".into(),
        reconnect_account_id: None,
        code: "single-use-code".into(),
        verifier: "verifier".into(),
        expected_state: "state".into(),
        redirect_uri: "http://127.0.0.1:1".into(),
    });

    let status = login_status(&app, "attempt").await.unwrap();
    assert_eq!(status.status, LoginState::Failed);
    assert!(app.pending_auth_exchange.lock().is_none());
}

#[tokio::test]
async fn abort_login_resources_stops_server_and_drops_queued_code() {
    let temp = tempfile::tempdir().unwrap();
    let app = Arc::new(AppState::new(temp.path().to_path_buf(), "test-token".into()).unwrap());
    let (tx, rx) = oneshot::channel();
    app.register_login_shutdown("attempt".into(), tx);
    *app.pending_auth_exchange.lock() = Some(crate::state::PendingAuthExchange {
        attempt_id: "attempt".into(),
        provider: Provider::Openai,
        label: "Test".into(),
        reconnect_account_id: None,
        code: "single-use-code".into(),
        verifier: "verifier".into(),
        expected_state: "state".into(),
        redirect_uri: "http://localhost:1455/auth/callback".into(),
    });

    app.abort_login_resources("attempt");
    assert!(app.pending_auth_exchange.lock().is_none());
    assert!(rx.await.is_ok());
}

#[tokio::test]
async fn rejects_start_login_when_another_login_in_progress() {
    let temp = tempfile::tempdir().unwrap();
    let app = Arc::new(AppState::new(temp.path().to_path_buf(), "test-token".into()).unwrap());

    for status in [
        LoginState::Waiting,
        LoginState::ChooseProject,
        LoginState::MonitoringDisabled,
    ] {
        *app.pending_login.write() = Some(LoginStatus {
            attempt_id: "active-attempt".into(),
            status,
            message: None,
            account: None,
            projects: None,
            selected_project_id: None,
        });

        let result = start_login(app.clone(), "Test".into(), Provider::Openai, None, None).await;
        assert!(result.is_err());
        assert_eq!(
            result.unwrap_err(),
            crate::oauth_common::LOGIN_IN_PROGRESS_MESSAGE
        );
    }
}

#[test]
fn only_timeouts_among_http_statuses_are_worth_retrying() {
    use reqwest::StatusCode;
    for status in [StatusCode::REQUEST_TIMEOUT, StatusCode::GATEWAY_TIMEOUT] {
        let error = ExchangeError::from_status("late".into(), status);
        assert!(error.is_retryable(), "{status}");
    }
    for status in [
        StatusCode::BAD_REQUEST,
        StatusCode::UNAUTHORIZED,
        StatusCode::TOO_MANY_REQUESTS,
        StatusCode::INTERNAL_SERVER_ERROR,
        StatusCode::BAD_GATEWAY,
        StatusCode::SERVICE_UNAVAILABLE,
    ] {
        let error = ExchangeError::from_status("no".into(), status);
        assert_eq!(error, ExchangeError::Failed("no".into()), "{status}");
    }
}

#[test]
fn plain_messages_are_failures_that_are_not_retried() {
    let error: ExchangeError = "Invalid OpenAI token response".into();
    assert!(!error.is_retryable());
    assert_eq!(error.message(), "Invalid OpenAI token response");
    assert_eq!(ExchangeError::from("x".to_string()).into_message(), "x");
}

#[test]
fn wording_that_means_the_network_got_in_the_way_is_recognized() {
    for text in [
        "error sending request: dns error: failed to lookup address",
        "No address associated with hostname",
        "tcp connect error: Connection refused (os error 111)",
        "connection reset by peer while connecting",
        "Network is unreachable",
        "operation timed out",
        "request timeout",
    ] {
        assert!(looks_unreachable(text), "{text}");
    }
    for text in [
        "invalid_grant",
        "Invalid OpenAI token response: expected value",
        "Account label is required.",
    ] {
        assert!(!looks_unreachable(text), "{text}");
    }
}

#[tokio::test]
async fn a_refused_connection_is_unreachable_and_a_malformed_request_is_not() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/token", listener.local_addr().unwrap());
    drop(listener);
    let refused = reqwest::Client::new().post(&url).send().await.unwrap_err();
    let error = ExchangeError::from_send("Acme token exchange failed", &refused);
    assert!(error.is_retryable());
    assert!(error.message().starts_with("Acme token exchange failed: "));

    let malformed = reqwest::Client::new()
        .post("not a url")
        .send()
        .await
        .unwrap_err();
    assert!(!ExchangeError::from_send("Acme token exchange failed", &malformed).is_retryable());
}

#[tokio::test]
async fn a_request_that_times_out_is_unreachable() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/token", listener.local_addr().unwrap());
    // Accepts the connection but never answers.
    let _hold = tokio::spawn(async move {
        let _socket = listener.accept().await;
        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
    });
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(100))
        .build()
        .unwrap();
    let timed_out = client.post(&url).send().await.unwrap_err();
    assert!(ExchangeError::from_send("Acme token exchange failed", &timed_out).is_retryable());
}

/// Sign-in failure messages are shown to the user, so a provider reply that
/// fails to parse must not be echoed into them: serde's error text can quote
/// the reply. The refresh path already uses fixed sentences; this keeps the
/// login paths the same.
#[test]
fn login_response_parse_errors_do_not_echo_the_reply() {
    for (file, source) in [
        ("oauth/exchange.rs", include_str!("exchange.rs")),
        ("oauth/identity.rs", include_str!("identity.rs")),
        (
            "oauth/callback_server.rs",
            include_str!("callback_server.rs"),
        ),
        ("oauth/desktop_window.rs", include_str!("desktop_window.rs")),
        ("oauth/mobile.rs", include_str!("mobile.rs")),
        ("oauth/mod.rs", include_str!("mod.rs")),
        (
            "google_ai_studio_oauth.rs",
            include_str!("../google_ai_studio_oauth.rs"),
        ),
    ] {
        for (number, line) in source.lines().enumerate() {
            let parse_message =
                line.contains("format!(\"Invalid ") || line.contains("format!(\"Google returned");
            assert!(
                !(parse_message && line.contains("{error}")),
                "{file}:{}: {}",
                number + 1,
                line.trim()
            );
        }
    }
}

#[tokio::test]
async fn a_callback_without_this_attempts_state_changes_nothing() {
    let temp = tempfile::tempdir().unwrap();
    let app = Arc::new(AppState::new(temp.path().to_path_buf(), "test-token".into()).unwrap());
    *app.pending_login.write() = Some(LoginStatus {
        attempt_id: "attempt".into(),
        status: LoginState::Waiting,
        message: None,
        account: None,
        projects: None,
        selected_project_id: None,
    });
    let context = Arc::new(reconnect_context(app.clone(), None)); // state "s"
    let query = |state: Option<&str>| CallbackQuery {
        code: None,
        state: state.map(str::to_string),
        error: Some("access_denied".into()),
        error_description: Some("Your session expired, sign in at evil.example".into()),
    };

    // Requests without the attempt's state: no claim, no failure, no text.
    for state in [None, Some("wrong")] {
        let _ = handle_callback(context.clone(), query(state)).await;
        assert!(!context
            .callback_claimed
            .load(std::sync::atomic::Ordering::SeqCst));
        assert!(app.login_is_waiting("attempt"));
    }

    // The provider's own error redirect still ends the attempt.
    let _ = handle_callback(context.clone(), query(Some("s"))).await;
    assert!(context
        .callback_claimed
        .load(std::sync::atomic::Ordering::SeqCst));
    let status = app.pending_login.read().clone().unwrap();
    assert_eq!(status.status, LoginState::Failed);
    assert_eq!(
        status.message.as_deref(),
        Some("Your session expired, sign in at evil.example"),
        "only the provider's own redirect may set the message"
    );
}

#[test]
fn a_token_response_does_not_print_its_tokens() {
    let response: OAuthTokenResponse = serde_json::from_str(
        r#"{"access_token":"SECRET_ACCESS","refresh_token":"SECRET_REFRESH","id_token":"SECRET_ID","expires_in":3600}"#,
    )
    .unwrap();
    let text = format!("{response:?}");
    assert!(!text.contains("SECRET"), "{text}");
    assert!(text.contains("3600"), "{text}");
}

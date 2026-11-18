use super::*;
use crate::model::{GoogleAiStudioSecret, GrokSecret, OpenCodeGoSecret, UsageFreshness};

const ACCESS: &str =
    "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJlY2hvLXRlc3QtYWNjZXNzIn0.c2lnbmF0dXJlLWFjY2Vzcy10b2tlbg";
const REFRESH: &str = "rt_refresh-token-for-echo-tests-0123456789abcdef";
const ID_TOKEN: &str =
    "eyJhbGciOiJSUzI1NiJ9.eyJlbWFpbCI6ImlkLXRva2VuLWVjaG8ifQ.aWQtdG9rZW4tc2lnbmF0dXJl";

type UsageEdit = fn(&mut ProviderUsage, &str);
type AccountEdit = fn(&mut Account);

fn oauth() -> OAuthSecret {
    OAuthSecret {
        access_token: ACCESS.into(),
        refresh_token: REFRESH.into(),
        id_token: Some(ID_TOKEN.into()),
        expires_at: i64::MAX,
    }
}

fn usage() -> ProviderUsage {
    ProviderUsage {
        plan: Some("Plus".into()),
        email: Some("person@example.com".into()),
        provider_account_id: Some("acct-3f1c2b8e-1d4a-4c55-9a77-0f6c2e1b9d10".into()),
        windows: vec![UsageWindow {
            id: "primary".into(),
            label: "5 hour".into(),
            used_percent: Some(10.0),
            remaining_percent: Some(90.0),
            resets_at: Some("2026-11-18T12:00:00Z".into()),
            window_seconds: Some(18_000),
            kind: None,
        }],
        credits_usd: None,
        unlimited_credits: false,
        source: "wham".into(),
        limit_resets: vec![LimitReset {
            id: "grant-1".into(),
            label: "Limit reset".into(),
            detail: "Resets your weekly limit once.".into(),
            expires_at: None,
            usable: true,
        }],
    }
}

#[test]
fn ordinary_usage_is_not_an_echo() {
    for secret in [
        ProviderSecret::Openai(oauth()),
        ProviderSecret::Anthropic(oauth()),
        ProviderSecret::Antigravity(oauth()),
    ] {
        assert!(!SecretEcho::new(&[&secret]).usage_echoes(&usage()));
    }
}

#[test]
fn every_usage_field_is_checked() {
    let echo = SecretEcho::new(&[&ProviderSecret::Openai(oauth())]);
    let edits: Vec<(&str, UsageEdit)> = vec![
        ("plan", |usage, text| usage.plan = Some(text.into())),
        ("email", |usage, text| usage.email = Some(text.into())),
        ("provider_account_id", |usage, text| {
            usage.provider_account_id = Some(text.into())
        }),
        ("source", |usage, text| usage.source = text.into()),
        ("window id", |usage, text| usage.windows[0].id = text.into()),
        ("window label", |usage, text| {
            usage.windows[0].label = text.into()
        }),
        ("window resets_at", |usage, text| {
            usage.windows[0].resets_at = Some(text.into())
        }),
        ("grant id", |usage, text| {
            usage.limit_resets[0].id = text.into()
        }),
        ("grant label", |usage, text| {
            usage.limit_resets[0].label = text.into()
        }),
        ("grant detail", |usage, text| {
            usage.limit_resets[0].detail = text.into()
        }),
        ("grant expires_at", |usage, text| {
            usage.limit_resets[0].expires_at = Some(text.into())
        }),
    ];
    for (field, edit) in edits {
        let mut echoed = usage();
        edit(&mut echoed, ACCESS);
        assert!(echo.usage_echoes(&echoed), "{field} was not checked");
    }
}

#[test]
fn a_fragment_of_any_oauth_token_is_an_echo() {
    let echo = SecretEcho::new(&[&ProviderSecret::Anthropic(oauth())]);
    // One JWT segment, a cut-off token inside other text, and each token kind.
    let access_payload = ACCESS.split('.').nth(1).unwrap();
    assert!(echo.matches(access_payload));
    assert!(echo.matches(&format!("plan {}", &ACCESS[20..40])));
    assert!(echo.matches(&format!("{}@example.com", &REFRESH[3..22])));
    assert!(echo.matches(ID_TOKEN.split('.').nth(2).unwrap()));
}

#[test]
fn short_text_and_short_credentials_are_not_compared() {
    let echo = SecretEcho::new(&[&ProviderSecret::Openai(oauth())]);
    // Fifteen characters of the token: under the window, so not an echo.
    assert!(!echo.matches(&ACCESS[0..ECHO_WINDOW_BYTES - 1]));

    let tiny = ProviderSecret::Openai(OAuthSecret {
        access_token: "access".into(),
        refresh_token: "refresh".into(),
        id_token: None,
        expires_at: i64::MAX,
    });
    let echo = SecretEcho::new(&[&tiny]);
    assert!(!echo.matches("access refresh access refresh"));
}

#[test]
fn cookie_and_api_key_credentials_are_checked() {
    let grok = ProviderSecret::Grok(GrokSecret {
        cookie_header: Some(
            "sso=grok-session-cookie-value-0123456789; sso-rw=rw-cookie-value-abcdefghijklmnop"
                .into(),
        ),
    });
    let echo = SecretEcho::new(&[&grok]);
    assert!(echo.matches("grok-session-cookie-value-0123456789"));
    assert!(echo.matches("rw-cookie-value-abcdefghijklmnop"));
    assert!(!echo.matches("SuperGrok Heavy"));

    let opencode = ProviderSecret::OpencodeGo(OpenCodeGoSecret {
        workspace_id: "wrk_0123456789abcdefghij".into(),
        auth_cookie: "Fe26.2**opencode-auth-cookie-value-0123456789".into(),
    });
    let echo = SecretEcho::new(&[&opencode]);
    assert!(echo.matches("opencode-auth-cookie-value"));
    // The workspace id is stored as metadata on purpose, so it is not a credential.
    assert!(!echo.matches("wrk_0123456789abcdefghij"));

    let google = ProviderSecret::GoogleAiStudio(GoogleAiStudioSecret {
        api_key: "AIzaSyEchoTestApiKey-0123456789abcdef".into(),
        selected_models: vec!["gemini-2.5-pro-preview-models".into()],
        cloud_project_id: Some("my-cloud-project-1234567".into()),
        cloud_oauth: Some(oauth()),
    });
    let echo = SecretEcho::new(&[&google]);
    assert!(echo.matches("AIzaSyEchoTestApiKey-0123456789abcdef"));
    assert!(echo.matches(ACCESS));
    assert!(!echo.matches("gemini-2.5-pro-preview-models"));
    assert!(!echo.matches("my-cloud-project-1234567"));
}

#[test]
fn every_account_field_is_checked() {
    let echo = SecretEcho::new(&[&ProviderSecret::Openai(oauth())]);
    let base = Account {
        id: "3f1c2b8e-1d4a-4c55-9a77-0f6c2e1b9d10".into(),
        label: "Work".into(),
        provider: crate::model::Provider::Openai,
        email: Some("person@example.com".into()),
        provider_account_id: Some("acct-123".into()),
        chatgpt_account_id: Some("acct-123".into()),
        plan: Some("Plus".into()),
        created_at: "2026-11-18T00:00:00Z".into(),
        updated_at: "2026-11-18T00:00:00Z".into(),
        last_usage: Some(UsageSnapshot {
            plan: Some("Plus".into()),
            email: Some("person@example.com".into()),
            windows: usage().windows,
            credits_usd: None,
            unlimited_credits: false,
            fetched_at: "2026-11-18T00:00:00Z".into(),
            freshness: UsageFreshness::Live,
            source: "wham".into(),
            limit_resets: usage().limit_resets,
        }),
        last_error: None,
        auth_required: false,
    };
    assert!(!echo.account_echoes(&base));

    let edits: Vec<(&str, AccountEdit)> = vec![
        ("label", |account| account.label = ACCESS.into()),
        ("email", |account| account.email = Some(ACCESS.into())),
        ("provider_account_id", |account| {
            account.provider_account_id = Some(ACCESS.into())
        }),
        ("chatgpt_account_id", |account| {
            account.chatgpt_account_id = Some(ACCESS.into())
        }),
        ("plan", |account| account.plan = Some(ACCESS.into())),
        ("last_error", |account| {
            account.last_error = Some(ACCESS.into())
        }),
        ("snapshot plan", |account| {
            account.last_usage.as_mut().unwrap().plan = Some(ACCESS.into())
        }),
        ("snapshot email", |account| {
            account.last_usage.as_mut().unwrap().email = Some(ACCESS.into())
        }),
        ("snapshot window label", |account| {
            account.last_usage.as_mut().unwrap().windows[0].label = ACCESS.into()
        }),
        ("snapshot grant detail", |account| {
            account.last_usage.as_mut().unwrap().limit_resets[0].detail = ACCESS.into()
        }),
    ];
    for (field, edit) in edits {
        let mut echoed = base.clone();
        edit(&mut echoed);
        assert!(echo.account_echoes(&echoed), "{field} was not checked");
    }
}

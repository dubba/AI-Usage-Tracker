use super::*;
use tempfile::tempdir;

#[test]
fn bearer_tokens_and_authorization_headers_are_removed() {
    let out = redact("request failed: Authorization: Bearer abc123def456ghi789 (status 401)");
    assert!(!out.contains("abc123"), "{out}");
    assert!(out.contains(REDACTED));

    let out = redact("sent bearer sk-ant-oat01-secretsecretsecret and retried");
    assert!(!out.contains("secretsecret"), "{out}");
    assert!(out.ends_with("and retried"));
}

#[test]
fn secret_fields_are_removed_in_query_string_and_json_forms() {
    let out = redact(
        "POST /token?grant_type=refresh_token&refresh_token=rt_ABC.def-123&client_id=public",
    );
    assert!(!out.contains("rt_ABC"), "{out}");
    assert!(out.contains("client_id=public"), "{out}");

    let out = redact(r#"{"access_token":"at_secret_value","expires_in":3600}"#);
    assert!(!out.contains("at_secret_value"), "{out}");
    assert!(out.contains("3600"), "{out}");

    let out = redact("password=hunter2 next=ok");
    assert!(!out.contains("hunter2"), "{out}");
    assert!(out.contains("next=ok"));
}

#[test]
fn command_errors_hide_home_folders_and_are_capped() {
    let out = command_error(
        "failed to write /Users/alice/Library/Application Support/x/app-settings.json: Permission denied (os error 13)",
    );
    assert!(!out.contains("alice"), "{out}");
    assert!(out.contains("Permission denied"), "{out}");
    let out = command_error(r"C:\Users\bob\AppData\Roaming\x: access is denied");
    assert!(!out.contains("bob"), "{out}");
    let out = command_error("token rejected: access_token=at_SECRET");
    assert!(!out.contains("at_SECRET"), "{out}");

    let long = command_error("é".repeat(1000));
    assert_eq!(long.chars().count(), 301, "300 characters and an ellipsis");
    assert!(long.ends_with('…'));
    assert_eq!(command_error("Account not found."), "Account not found.");
}

#[test]
fn oauth_callback_code_and_state_are_removed_from_urls() {
    let out = redact(
        "GET http://localhost:1455/auth/callback?code=ac_SECRET123&state=st_ABC456&scope=openid",
    );
    assert!(
        !out.contains("ac_SECRET123") && !out.contains("st_ABC456"),
        "{out}"
    );
    assert!(out.contains("scope=openid"), "{out}");
    let out = redact("callback?state=s1x&code=c2y done");
    assert!(!out.contains("s1x") && !out.contains("c2y"), "{out}");
    assert!(out.contains("done"), "{out}");

    // Outside a query string these words are ordinary text.
    for kept in [
        "Profile request returned status code: 404",
        "login state: waiting",
        "error_code=E1 zipcode=12345",
        "settings?mode=dark&codename=x",
    ] {
        assert_eq!(redact(kept), kept);
    }
}

#[test]
fn cookie_headers_are_removed_to_the_end_of_the_line() {
    let out = redact("Cookie: session=abc; theme=dark; sso=xyz\nnext line kept");
    assert!(!out.contains("abc") && !out.contains("xyz"), "{out}");
    assert!(out.contains("next line kept"), "{out}");
    assert!(!redact("Set-Cookie: a=b; Path=/").contains("Path=/"));
}

#[test]
fn jwts_and_long_opaque_strings_are_removed() {
    let jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    assert!(!redact(&format!("id token was {jwt} here")).contains("eyJhbGci"));

    let key = "AIzaSyD-9tSrke72PouQMnMX-a7eZSW0jkFMBWY";
    let out = redact(&format!("key {key} rejected"));
    assert!(!out.contains("AIzaSy"), "{out}");
    assert!(out.contains("rejected"));
}

#[test]
fn useful_identifiers_survive() {
    let id = "4f0e8a3c-2b7d-4c1e-9a55-0d3f6b1e7c22";
    let text = format!(
        "account {id} at https://api.anthropic.com/api/oauth/usage returned 429 Retry after 30"
    );
    assert_eq!(redact(&text), text);
    // Long file paths are not secrets.
    let path = "/data/user/0/com.dubba.ai.usage.tracker/files/credentials/accounts.json";
    assert_eq!(redact(path), path);
    assert_eq!(
        redact("OpenAI rate-limited the usage request."),
        "OpenAI rate-limited the usage request."
    );
}

#[test]
fn emails_are_masked_not_dropped() {
    assert_eq!(
        redact("signed in as someone.private@example.com."),
        "signed in as s***@example.com."
    );
    // Idempotent: a masked address stays masked.
    let once = redact("a@b.co");
    assert_eq!(redact(&once), once);
}

#[test]
fn home_folder_names_are_removed() {
    assert_eq!(
        redact("/Users/momo/Library/Application Support/app/accounts.json"),
        "~/Library/Application Support/app/accounts.json"
    );
    assert_eq!(
        redact("read /home/alice/.config/x failed"),
        "read ~/.config/x failed"
    );
    assert_eq!(
        redact(r"C:\Users\Bob\AppData\Roaming\app"),
        r"C:~\AppData\Roaming\app"
    );
    assert_eq!(redact("no user folder here"), "no user folder here");
    assert_eq!(redact("/Users/ alone"), "/Users/ alone");
}

#[test]
fn redaction_handles_multibyte_text_and_is_repeatable() {
    let text = "错误 token=abc界 完成 — done";
    let once = redact(text);
    assert!(!once.contains("abc界"), "{once}");
    assert!(once.contains("完成"));
    assert_eq!(redact(&once), once);
}

#[test]
fn log_lines_are_single_line_redacted_and_bounded() {
    let line = format_line(
        "WARN",
        "refresh failed\nrefresh_token=abcdef\r\n and more",
        "2026-09-30T00:00:00Z",
    );
    assert!(line.starts_with("2026-09-30T00:00:00Z WARN "));
    assert!(!line.contains('\n') && !line.contains('\r'));
    assert!(!line.contains("abcdef"));

    let long = format_line("INFO", &"x ".repeat(2000), "t");
    assert!(long.chars().count() < MAX_LINE_CHARS + 20);
    assert!(long.ends_with('…'));
}

#[test]
fn the_log_rotates_and_recent_lines_span_both_files() {
    let dir = tempdir().unwrap();
    for index in 0..10 {
        append_line(dir.path(), &format!("line {index}"), 30);
    }
    assert!(dir.path().join(ROTATED_LOG_FILE).exists());
    let lines = recent_lines(dir.path(), 4);
    assert_eq!(lines, ["line 6", "line 7", "line 8", "line 9"]);
    // Asking for more than exists returns what there is, in order.
    let all = recent_lines(dir.path(), 1000);
    assert_eq!(all.first().unwrap(), "line 0");
    assert_eq!(all.last().unwrap(), "line 9");
    assert_eq!(all.len(), 10);
}

#[test]
fn the_report_lists_status_without_identity_or_secrets() {
    use crate::model::{now_rfc3339, Account, OAuthSecret, Provider, ProviderSecret};

    let dir = tempdir().unwrap();
    let state = AppState::new(dir.path().to_path_buf(), "test-token".into()).unwrap();
    let now = now_rfc3339();
    state
        .store
        .persist_account(
            Account {
                id: "report-account-1".into(),
                label: "Private Label".into(),
                provider: Provider::Anthropic,
                email: Some("someone@example.com".into()),
                provider_account_id: None,
                chatgpt_account_id: None,
                plan: Some("Pro".into()),
                created_at: now.clone(),
                updated_at: now,
                last_usage: None,
                last_error: Some("Anthropic returned 429 for someone@example.com".into()),
                auth_required: false,
            },
            &ProviderSecret::Anthropic(OAuthSecret {
                access_token: "secret-access".into(),
                refresh_token: "secret-refresh".into(),
                id_token: None,
                expires_at: 1,
            }),
        )
        .unwrap();

    let report = build_report("9.9.9", Some(&state), None);
    assert!(report.contains("Version: 9.9.9"));
    assert!(report.contains("Accounts: 1"));
    assert!(report.contains("anthropic report-account-1"));
    assert!(report.contains("plan: Pro"));
    assert!(report.contains("s***@example.com"));
    for leaked in [
        "Private Label",
        "someone@example.com",
        "secret-access",
        "secret-refresh",
    ] {
        assert!(!report.contains(leaked), "report leaked {leaked}");
    }

    let windows = describe_windows(&[
        crate::model::UsageWindow {
            id: "five_hour".into(),
            label: "5 hour".into(),
            used_percent: Some(0.0),
            remaining_percent: Some(100.0),
            resets_at: None,
            window_seconds: Some(18_000),
            kind: None,
        },
        crate::model::UsageWindow {
            id: "weekly".into(),
            label: "Weekly".into(),
            used_percent: Some(40.0),
            remaining_percent: Some(60.0),
            resets_at: Some("2026-10-04T12:00:00Z".into()),
            window_seconds: Some(604_800),
            kind: None,
        },
    ]);
    assert_eq!(windows, "five_hour 100% reset=no, weekly 60% reset=yes");
    assert_eq!(describe_windows(&[]), "none");

    let failed = build_report("9.9.9", None, Some("Couldn't load saved data: disk full"));
    assert!(failed.contains("Startup: Couldn't load saved data: disk full"));
    assert!(failed.contains("The app state is not available."));
}

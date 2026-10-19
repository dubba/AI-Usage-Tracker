//! JSON samples of the backend values the frontend declares types for (`src/types.ts`).
//!
//! The samples are committed in `src/shared/lib/backend-samples.fixture.json`. This test builds
//! them from the real Rust types and fails when the file is out of date, and
//! `src/shared/lib/types-contract.test.ts` checks that every sample satisfies the matching
//! TypeScript type. A field added, renamed or made nullable on one side then fails a test instead
//! of showing up as `undefined` at run time.
//!
//! After an intended change, rewrite the file with
//! `UPDATE_FIXTURES=1 cargo test --manifest-path src-tauri/Cargo.toml --lib type_contract`.

use crate::{
    model::{
        Account, AccountBucket, AppUpdateStatus, BridgeStatus, CloudProjectOption,
        DashboardSnapshot, LoginStatus, Provider, UsageFreshness, UsageSnapshot, UsageWindow,
        WindowKind,
    },
    pairing::{payload::SyncSummary, PairingHostInit, PairingStatus},
    store::settings::AppSettings,
};
use serde_json::{json, Value};

const FIXTURE: &str = "../src/shared/lib/backend-samples.fixture.json";

fn window(id: &str, kind: Option<WindowKind>) -> UsageWindow {
    UsageWindow {
        id: id.into(),
        label: "5 hour".into(),
        used_percent: Some(18.0),
        remaining_percent: Some(82.0),
        resets_at: Some("2026-09-03T17:00:00Z".into()),
        window_seconds: Some(18_000),
        kind,
    }
}

fn account(with_usage: bool) -> Account {
    Account {
        id: "account-1".into(),
        label: "Personal".into(),
        provider: Provider::GoogleAiStudio,
        email: with_usage.then(|| "person@example.com".into()),
        provider_account_id: with_usage.then(|| "provider-id".into()),
        chatgpt_account_id: None,
        plan: with_usage.then(|| "pro".into()),
        created_at: "2026-09-01T00:00:00Z".into(),
        updated_at: "2026-09-03T12:00:00Z".into(),
        last_usage: with_usage.then(|| UsageSnapshot {
            plan: Some("pro".into()),
            email: None,
            windows: vec![
                window("five_hour", Some(WindowKind::FiveHour)),
                window("gemini-pro", None),
            ],
            credits_usd: Some(1.5),
            unlimited_credits: false,
            fetched_at: "2026-09-03T12:00:00Z".into(),
            freshness: UsageFreshness::AuthRequired,
            source: "test".into(),
        }),
        last_error: (!with_usage).then(|| "Sign in again".into()),
        auth_required: !with_usage,
    }
}

fn bridge(error: Option<&str>) -> BridgeStatus {
    BridgeStatus {
        endpoint: "http://127.0.0.1:47831/v1/paseo-usage".into(),
        enabled: true,
        running: error.is_none(),
        error: error.map(str::to_string),
    }
}

fn bucket(provider: Option<Provider>) -> AccountBucket {
    AccountBucket {
        id: "bucket-1".into(),
        name: "Work".into(),
        provider,
        account_ids: vec!["account-1".into()],
        created_at: "2026-09-01T00:00:00Z".into(),
        updated_at: "2026-09-02T00:00:00Z".into(),
    }
}

fn pairing_statuses() -> Vec<PairingStatus> {
    let session = || "session-1".to_string();
    vec![
        PairingStatus::Idle,
        PairingStatus::HostWaiting {
            session_id: session(),
            qr_svg: "<svg/>".into(),
            qr_uri: "aiut-pair://x".into(),
            fingerprint: "AB:CD".into(),
            join_code: "123456".into(),
            expires_at: 1_790_000_000,
        },
        PairingStatus::ClientConnecting {
            session_id: session(),
        },
        PairingStatus::PeerConnected {
            session_id: session(),
            fingerprint: "AB:CD".into(),
            sas_code: "1234".into(),
        },
        PairingStatus::RoleSelection {
            session_id: session(),
            fingerprint: "AB:CD".into(),
            sas_code: "1234".into(),
        },
        PairingStatus::SasVerification {
            session_id: session(),
            sas_code: "1234".into(),
            fingerprint: "AB:CD".into(),
            role: "sender".into(),
            account_count: None,
        },
        PairingStatus::SasVerification {
            session_id: session(),
            sas_code: "1234".into(),
            fingerprint: "AB:CD".into(),
            role: "receiver".into(),
            account_count: Some(3),
        },
        PairingStatus::Transferring {
            session_id: session(),
        },
        PairingStatus::Completed {
            summary: SyncSummary {
                added: 1,
                updated: 2,
                skipped: 3,
                warnings: vec!["Settings could not be saved.".into()],
            },
        },
        PairingStatus::Failed {
            error: "Timed out".into(),
        },
    ]
}

fn to_json<T: serde::Serialize>(values: &[T]) -> Value {
    Value::Array(
        values
            .iter()
            .map(|value| serde_json::to_value(value).unwrap())
            .collect(),
    )
}

/// Type name in `src/types.ts` -> samples of what the backend sends for it.
fn samples() -> Value {
    let settings = |autostart: bool| AppSettings {
        account_refresh_minutes: 15,
        paseo_bridge_enabled: autostart,
        automatic_updates_enabled: true,
        include_beta_updates: false,
        autostart_enabled: autostart,
    };
    let mut login = vec![
        LoginStatus::waiting("attempt-1", Some("Waiting for sign-in".into())),
        LoginStatus::complete("attempt-1", account(true)),
        LoginStatus::failed("attempt-1", "Sign-in failed".into()),
    ];
    let mut choose = LoginStatus::waiting("attempt-1", None);
    choose.status = crate::model::LoginState::ChooseProject;
    choose.projects = Some(vec![CloudProjectOption {
        project_id: "project".into(),
        project_number: "1".into(),
        display_name: "Project".into(),
    }]);
    choose.selected_project_id = Some("project".into());
    login.push(choose);
    json!({
        "Account": to_json(&[account(true), account(false)]),
        "DashboardSnapshot": to_json(&[
            DashboardSnapshot {
                accounts: vec![account(true), account(false)],
                buckets: vec![bucket(Some(Provider::Anthropic)), bucket(None)],
                bridge: bridge(None),
                unprotected_credentials: 1,
                unprotected_account_ids: vec!["account-1".into()],
            },
            DashboardSnapshot {
                accounts: vec![],
                buckets: vec![],
                bridge: bridge(Some("Port in use")),
                unprotected_credentials: 0,
                unprotected_account_ids: vec![],
            },
        ]),
        "PairingStatus": to_json(&pairing_statuses()),
        "PairingHostInit": to_json(&[PairingHostInit {
            session_id: "session-1".into(),
            qr_svg: "<svg/>".into(),
            qr_uri: "aiut-pair://x".into(),
            fingerprint: "AB:CD".into(),
            join_code: "123456".into(),
            expires_at: 1_790_000_000,
        }]),
        "AppSettings": to_json(&[settings(true), settings(false)]),
        "LoginStatus": to_json(&login),
        "AppUpdateStatus": to_json(&[
            AppUpdateStatus {
                current_version: "0.4.8".into(),
                available: true,
                available_version: Some("0.5.0".into()),
                date: Some("2026-10-01".into()),
                body: Some("Notes".into()),
                error: None,
            },
            AppUpdateStatus::failed("0.4.8".into(), "Offline"),
        ]),
    })
}

#[test]
fn backend_samples_fixture_is_current() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(FIXTURE);
    let current = format!("{}\n", serde_json::to_string_pretty(&samples()).unwrap());
    if std::env::var_os("UPDATE_FIXTURES").is_some() {
        std::fs::write(&path, &current).unwrap();
        return;
    }
    let committed = std::fs::read_to_string(&path).unwrap_or_default();
    assert!(
        committed == current,
        "{} is out of date. Rewrite it with `UPDATE_FIXTURES=1 cargo test --lib type_contract` and run `npx vitest run src/shared/lib/types-contract.test.ts` to see what the TypeScript types need.",
        path.display()
    );
}

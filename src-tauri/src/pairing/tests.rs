use super::{
    crypto::{
        build_transcript, compute_confirmation_tag, decrypt_payload, encrypt_payload,
        verify_confirmation_tag, PakeExchange, CONFIRM_RECEIVER_INFO, CONFIRM_SENDER_INFO,
        KEY_CONFIRM_HOST_INFO, KEY_CONFIRM_JOINER_INFO,
    },
    payload::{create_export_payload, import_sync_payload},
    protocol::{
        read_frame, read_frame_limited, write_frame, AbortReason, DiscoveredHost,
        HANDSHAKE_INIT_LEN, MAX_FRAME_SIZE, MAX_PREAUTH_FRAME_SIZE, MSG_ABORT,
        MSG_ENCRYPTED_PAYLOAD, MSG_HANDSHAKE_INIT, MSG_HANDSHAKE_RESP, MSG_KEY_CONFIRM,
        MSG_ROLE_SELECT, MSG_ROLE_SELECT_RESP, MSG_TRANSFER_CONFIRM, PAKE_MESSAGE_LEN,
        ROLE_JOINER_SENDS, TRANSFER_ACCEPTED,
    },
    transport::{
        run_client_connector, run_host_listener, ClientEvent, HostEvent, HostSession, RoleChannels,
        SessionChannels, MAX_CODE_ATTEMPTS, MAX_HOSTS_TRIED, MORE_ACCOUNTS_THAN_SHOWN,
        TOO_MANY_WRONG_CODES, WRONG_CODE,
    },
};
use crate::{
    model::{Account, Provider, ProviderSecret, ResetTarget},
    state::AppState,
};
use chrono::Utc;
use std::{sync::Arc, time::Duration};
use tokio::{
    net::{TcpListener, TcpStream},
    sync::{mpsc, oneshot},
    time::timeout,
};
use uuid::Uuid;

#[test]
fn air_gap_qr_codes_are_a_square_grid_of_modules() {
    let uri = "aiut-airgap://1/abcd1234/1/1/00000000?d=AAAA";
    let qr = crate::pairing::transport::qr_matrix(uri).unwrap();
    assert_eq!(qr.modules.len(), qr.size * qr.size);
    assert!(qr
        .modules
        .chars()
        .all(|module| module == '0' || module == '1'));
    // Every QR code starts with a finder pattern: a full dark row of seven modules.
    assert_eq!(&qr.modules[..7], "1111111");
    // A full-size air-gap frame (its longest URI) still fits a QR code.
    let longest = format!(
        "aiut-airgap://1/abcd1234/999/999/0a1b2c3d?d={}",
        "A".repeat(crate::pairing::airgap::CHUNK_BINARY_SIZE.div_ceil(3) * 4)
    );
    assert!(crate::pairing::transport::qr_matrix(&longest).is_ok());
}

#[test]
fn test_payload_encryption_and_tamper_detection() {
    let key = [42u8; 32];
    let transcript = b"transcript-test-aad";
    let plaintext = b"sensitive-credentials-and-tokens-here";

    let ciphertext = encrypt_payload(&key, transcript, plaintext).unwrap();
    assert_ne!(ciphertext, plaintext);

    // Decrypt with correct key & transcript
    let decrypted = decrypt_payload(&key, transcript, &ciphertext).unwrap();
    assert_eq!(decrypted, plaintext);

    // Tampered ciphertext fails Poly1305 MAC
    let mut tampered_cipher = ciphertext.clone();
    tampered_cipher[30] ^= 0x01;
    assert!(decrypt_payload(&key, transcript, &tampered_cipher).is_err());

    // Tampered transcript (AAD mismatch) fails Poly1305 MAC
    let tampered_transcript = b"transcript-test-aad-tampered";
    assert!(decrypt_payload(&key, tampered_transcript, &ciphertext).is_err());

    // Wrong key fails
    let wrong_key = [99u8; 32];
    assert!(decrypt_payload(&wrong_key, transcript, &ciphertext).is_err());
}

#[tokio::test]
async fn test_framing_read_write() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();

    let server_task = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let (msg_type, payload) = read_frame(&mut socket).await.unwrap();
        assert_eq!(msg_type, MSG_HANDSHAKE_INIT);
        assert_eq!(payload, b"hello-frame");

        write_frame(&mut socket, MSG_HANDSHAKE_RESP, b"ack-frame")
            .await
            .unwrap();
    });

    let mut client = TcpStream::connect(addr).await.unwrap();
    write_frame(&mut client, MSG_HANDSHAKE_INIT, b"hello-frame")
        .await
        .unwrap();

    let (resp_type, resp_payload) = read_frame(&mut client).await.unwrap();
    assert_eq!(resp_type, MSG_HANDSHAKE_RESP);
    assert_eq!(resp_payload, b"ack-frame");

    server_task.await.unwrap();
}

#[tokio::test]
async fn preauth_frame_cap_rejects_oversized_frames() {
    use std::io::Cursor;

    // Frame of exactly MAX_PREAUTH_FRAME_SIZE (1024 bytes: 1 type byte + 1023 payload bytes)
    let mut valid_bytes = Vec::new();
    let frame_len = MAX_PREAUTH_FRAME_SIZE as u32;
    valid_bytes.extend_from_slice(&frame_len.to_be_bytes());
    valid_bytes.push(MSG_HANDSHAKE_INIT);
    valid_bytes.resize(4 + MAX_PREAUTH_FRAME_SIZE, 0x42);

    let mut cursor = Cursor::new(&valid_bytes);
    let (msg_type, payload) = read_frame_limited(&mut cursor, MAX_PREAUTH_FRAME_SIZE)
        .await
        .expect("1024-byte frame must be accepted under MAX_PREAUTH_FRAME_SIZE");
    assert_eq!(msg_type, MSG_HANDSHAKE_INIT);
    assert_eq!(payload.len(), 1023);

    // Frame of MAX_PREAUTH_FRAME_SIZE + 1 (1025 bytes): rejected before reading payload
    let mut oversized_bytes = Vec::new();
    let over_len = (MAX_PREAUTH_FRAME_SIZE + 1) as u32;
    oversized_bytes.extend_from_slice(&over_len.to_be_bytes());
    oversized_bytes.push(MSG_HANDSHAKE_INIT);

    let mut cursor = Cursor::new(&oversized_bytes);
    let err = read_frame_limited(&mut cursor, MAX_PREAUTH_FRAME_SIZE)
        .await
        .expect_err("frame > 1024 bytes must be rejected under MAX_PREAUTH_FRAME_SIZE");
    assert!(
        err.contains("exceeds maximum allowed size 1024"),
        "error message must cite the limit: {err}"
    );

    // The same 1025-byte frame succeeds under the authenticated MAX_FRAME_SIZE budget
    let mut full_oversized = Vec::new();
    full_oversized.extend_from_slice(&over_len.to_be_bytes());
    full_oversized.push(MSG_HANDSHAKE_INIT);
    full_oversized.resize(4 + 1025, 0x42);

    let mut cursor = Cursor::new(&full_oversized);
    let (msg_type, payload) = read_frame_limited(&mut cursor, MAX_FRAME_SIZE)
        .await
        .expect("1025-byte frame is allowed under MAX_FRAME_SIZE");
    assert_eq!(msg_type, MSG_HANDSHAKE_INIT);
    assert_eq!(payload.len(), 1024);
}

#[tokio::test]
async fn test_export_and_import_payload() {
    let dir_sender = tempfile::tempdir().unwrap();
    let state_sender =
        Arc::new(AppState::new(dir_sender.path().to_path_buf(), "tok1".into()).unwrap());

    // Populate sender state with an account and bucket
    let account = Account {
        id: "acc-1".into(),
        label: "Claude Primary".into(),
        provider: Provider::Anthropic,
        email: Some("user@example.com".into()),
        plan: Some("Pro".into()),
        created_at: Utc::now().to_rfc3339(),
        updated_at: Utc::now().to_rfc3339(),
        ..Account::for_test()
    };
    let secret = ProviderSecret::Anthropic(crate::model::OAuthSecret {
        access_token: "sk-ant-access-123".into(),
        refresh_token: "sk-ant-refresh-123".into(),
        id_token: None,
        expires_at: 0,
    });
    state_sender
        .persist_connected_account(account, &secret)
        .await
        .unwrap();

    state_sender
        .buckets
        .save(
            None,
            "Work Accounts".into(),
            Some(Provider::Anthropic),
            vec!["acc-1".into()],
        )
        .unwrap();

    // Export payload
    let export_bytes = create_export_payload(&state_sender).unwrap();
    assert!(!export_bytes.is_empty());

    // Import into fresh receiver state
    let dir_receiver = tempfile::tempdir().unwrap();
    let state_receiver =
        Arc::new(AppState::new(dir_receiver.path().to_path_buf(), "tok2".into()).unwrap());

    let summary = import_sync_payload(&state_receiver, &export_bytes, true)
        .await
        .unwrap();
    assert_eq!(summary.added, 1);
    assert_eq!(summary.updated, 0);
    assert_eq!(summary.skipped, 0);

    let accounts = state_receiver.store.list();
    assert_eq!(accounts.len(), 1);
    assert_eq!(accounts[0].label, "Claude Primary");
    assert_eq!(accounts[0].provider, Provider::Anthropic);

    let buckets = state_receiver.buckets.list();
    assert_eq!(buckets.len(), 1);
    assert_eq!(buckets[0].name, "Work Accounts");

    assert_eq!(buckets[0].account_ids, vec!["acc-1".to_string()]);

    // Importing again never replaces what is already here: the account is skipped.
    let summary2 = import_sync_payload(&state_receiver, &export_bytes, true)
        .await
        .unwrap();
    assert_eq!(summary2.added, 0);
    assert_eq!(summary2.updated, 0);
    assert_eq!(summary2.skipped, 1);
}

#[tokio::test]
async fn import_replaces_unsafe_peer_account_ids_with_local_ids() {
    let dir_sender = tempfile::tempdir().unwrap();
    let state_sender =
        Arc::new(AppState::new(dir_sender.path().to_path_buf(), "tok1".into()).unwrap());
    let account = Account {
        id: "acc-evil".into(),
        label: "Peer Account".into(),
        provider: Provider::Anthropic,
        email: Some("peer@example.com".into()),
        created_at: Utc::now().to_rfc3339(),
        updated_at: Utc::now().to_rfc3339(),
        ..Account::for_test()
    };
    let secret = ProviderSecret::Anthropic(crate::model::OAuthSecret {
        access_token: "sk-ant-access-evil".into(),
        refresh_token: "sk-ant-refresh-evil".into(),
        id_token: None,
        expires_at: 0,
    });
    state_sender
        .persist_connected_account(account, &secret)
        .await
        .unwrap();
    state_sender
        .buckets
        .save(None, "Peer".into(), None, vec!["acc-evil".into()])
        .unwrap();

    // A hostile peer rewrites the account id (and the bucket reference) to a
    // path traversal string before the payload is encrypted and sent.
    let mut payload: serde_json::Value =
        serde_json::from_slice(&create_export_payload(&state_sender).unwrap()).unwrap();
    payload["accounts"][0]["account"]["id"] = "../accounts".into();
    payload["buckets"][0]["accountIds"] = serde_json::json!(["../accounts"]);
    let tampered = serde_json::to_vec(&payload).unwrap();

    let dir_receiver = tempfile::tempdir().unwrap();
    let state_receiver =
        Arc::new(AppState::new(dir_receiver.path().to_path_buf(), "tok2".into()).unwrap());
    let summary = import_sync_payload(&state_receiver, &tampered, true)
        .await
        .unwrap();
    assert_eq!(summary.added, 1);
    assert_eq!(summary.skipped, 0);

    let accounts = state_receiver.store.list();
    assert_eq!(accounts.len(), 1);
    let local_id = accounts[0].id.clone();
    assert_ne!(local_id, "../accounts");
    assert!(Uuid::parse_str(&local_id).is_ok());
    assert!(crate::store::load_provider_secret(&local_id).is_ok());

    // Buckets follow the remapped id instead of the hostile one.
    let buckets = state_receiver.buckets.list();
    assert_eq!(buckets.len(), 1);
    assert_eq!(buckets[0].account_ids, vec![local_id]);
}

/// A sender on an older version may still hold a legacy default label and sign-in error, which
/// this version rewrote at its own start; the receiver rewrites them too.
#[tokio::test]
async fn import_rewrites_legacy_labels_and_errors_from_an_older_sender() {
    let dir_sender = tempfile::tempdir().unwrap();
    let state_sender =
        Arc::new(AppState::new(dir_sender.path().to_path_buf(), "tok1".into()).unwrap());
    let account = Account {
        id: "acc-old".into(),
        label: "Anthropic Claude 2".into(),
        provider: Provider::Anthropic,
        email: Some("old@example.com".into()),
        created_at: Utc::now().to_rfc3339(),
        updated_at: Utc::now().to_rfc3339(),
        last_error: Some("authentication is required".into()),
        auth_required: true,
        ..Account::for_test()
    };
    let secret = ProviderSecret::Anthropic(crate::model::OAuthSecret {
        access_token: "sk-ant-access-old".into(),
        refresh_token: "sk-ant-refresh-old".into(),
        id_token: None,
        expires_at: 0,
    });
    state_sender
        .persist_connected_account(account, &secret)
        .await
        .unwrap();
    let export_bytes = create_export_payload(&state_sender).unwrap();

    let dir_receiver = tempfile::tempdir().unwrap();
    let state_receiver =
        Arc::new(AppState::new(dir_receiver.path().to_path_buf(), "tok2".into()).unwrap());
    import_sync_payload(&state_receiver, &export_bytes, true)
        .await
        .unwrap();
    let imported = state_receiver.store.list().remove(0);
    assert_eq!(imported.label, "Claude 2");
    assert_eq!(
        imported.last_error.as_deref(),
        Some("Re-authentication required")
    );
}

#[tokio::test]
async fn import_bounds_peer_supplied_fields() {
    use crate::limits::{MAX_BUCKETS, MAX_EMAIL_CHARS, MAX_LABEL_CHARS};

    let dir_sender = tempfile::tempdir().unwrap();
    let state_sender =
        Arc::new(AppState::new(dir_sender.path().to_path_buf(), "tok1".into()).unwrap());
    let account = Account {
        id: "acc-big".into(),
        label: "Peer".into(),
        provider: Provider::Anthropic,
        email: Some("peer@example.com".into()),
        created_at: Utc::now().to_rfc3339(),
        updated_at: Utc::now().to_rfc3339(),
        ..Account::for_test()
    };
    let secret = ProviderSecret::Anthropic(crate::model::OAuthSecret {
        access_token: "a".into(),
        refresh_token: "r".into(),
        id_token: None,
        expires_at: 0,
    });
    state_sender
        .persist_connected_account(account, &secret)
        .await
        .unwrap();

    let mut payload: serde_json::Value =
        serde_json::from_slice(&create_export_payload(&state_sender).unwrap()).unwrap();
    payload["accounts"][0]["account"]["label"] = "L".repeat(10_000).into();
    payload["accounts"][0]["account"]["email"] = "e".repeat(10_000).into();
    payload["accounts"][0]["account"]["lastError"] = "!".repeat(10_000).into();
    let now = Utc::now().to_rfc3339();
    payload["buckets"] = (0..200)
        .map(|index| {
            serde_json::json!({
                "id": if index == 0 { "../weird id".to_string() } else { format!("bucket_{index}") },
                "name": format!("Group {index}"),
                "provider": null,
                "accountIds": vec!["acc-big"; 500],
                "createdAt": now,
                "updatedAt": now,
            })
        })
        .collect::<Vec<_>>()
        .into();
    payload["ui_state"] = serde_json::json!({
        "collapsedAccountIds": vec!["x".repeat(1000); 5000],
        "sidebarWidth": 4_000_000,
    });

    let dir_receiver = tempfile::tempdir().unwrap();
    let state_receiver =
        Arc::new(AppState::new(dir_receiver.path().to_path_buf(), "tok2".into()).unwrap());
    let summary = import_sync_payload(
        &state_receiver,
        &serde_json::to_vec(&payload).unwrap(),
        true,
    )
    .await
    .unwrap();
    assert_eq!(summary.added, 1);

    let accounts = state_receiver.store.list();
    assert_eq!(accounts[0].label.chars().count(), MAX_LABEL_CHARS);
    assert_eq!(
        accounts[0].email.as_ref().unwrap().chars().count(),
        MAX_EMAIL_CHARS
    );
    assert!(accounts[0].last_error.as_ref().unwrap().chars().count() <= 500);

    let buckets = state_receiver.buckets.list();
    assert_eq!(buckets.len(), MAX_BUCKETS);
    assert!(buckets
        .iter()
        .all(|bucket| crate::store::is_valid_account_id(&bucket.id)));
    // 500 repeated references collapse to the one real account.
    assert!(buckets
        .iter()
        .all(|bucket| bucket.account_ids == vec![accounts[0].id.clone()]));
}

#[test]
fn ui_state_clamp_bounds_lists_pages_and_text() {
    use super::payload::UiStateSyncPayload;
    use crate::limits::{MAX_SIDEBAR_WIDTH, MAX_UI_LIST_ENTRIES, MAX_UI_PAGES, MAX_UI_TEXT_CHARS};

    let mut ui = UiStateSyncPayload {
        sidebar_group_order: Some(vec!["g".repeat(1000); 1000]),
        provider_order: Some(vec!["openai".into()]),
        sidebar_window: Some("w".repeat(1000)),
        collapsed_account_ids: Some(vec!["a".into(); 1000]),
        collapsed_cards: Some(
            (0..1000)
                .map(|index| (format!("page-{index}"), vec!["c".repeat(1000); 1000]))
                .collect(),
        ),
        page_account_order: None,
        sidebar_width: Some(u32::MAX),
        theme: Some("light".into()),
        accent_color: Some("#2563EB".into()),
        usage_display_mode: Some("used".into()),
        bottom_nav_labels: Some("off".into()),
    };
    ui.clamp();

    let order = ui.sidebar_group_order.unwrap();
    assert_eq!(order.len(), MAX_UI_LIST_ENTRIES);
    assert!(order
        .iter()
        .all(|entry| entry.chars().count() == MAX_UI_TEXT_CHARS));
    assert_eq!(ui.provider_order.unwrap(), vec!["openai".to_string()]);
    assert_eq!(
        ui.sidebar_window.unwrap().chars().count(),
        MAX_UI_TEXT_CHARS
    );
    assert_eq!(ui.collapsed_account_ids.unwrap().len(), MAX_UI_LIST_ENTRIES);
    let cards = ui.collapsed_cards.unwrap();
    assert_eq!(cards.len(), MAX_UI_PAGES);
    assert!(cards.values().all(|ids| ids.len() == MAX_UI_LIST_ENTRIES));
    assert_eq!(ui.sidebar_width, Some(MAX_SIDEBAR_WIDTH));
    assert_eq!(ui.theme, Some("light".to_string()));
    assert_eq!(ui.accent_color, Some("#2563eb".to_string()));
    assert_eq!(ui.usage_display_mode, Some("used".to_string()));
    assert_eq!(ui.bottom_nav_labels, Some("off".to_string()));

    // Theme, accent color, usage display mode and menu bar labels are allowlists: anything else is dropped.
    let mut evil = UiStateSyncPayload {
        theme: Some("sepia'; DROP TABLE".into()),
        accent_color: Some("red; background:url(x)".into()),
        usage_display_mode: Some("remaining<script>".into()),
        bottom_nav_labels: Some("maybe<script>".into()),
        ..Default::default()
    };
    evil.clamp();
    assert_eq!(evil.theme, None);
    assert_eq!(evil.accent_color, None);
    assert_eq!(evil.usage_display_mode, None);
    assert_eq!(evil.bottom_nav_labels, None);

    let mut oled = UiStateSyncPayload {
        theme: Some("oled".into()),
        ..Default::default()
    };
    oled.clamp();
    assert_eq!(oled.theme, Some("oled".to_string()));

    let mut labels_on = UiStateSyncPayload {
        bottom_nav_labels: Some("on".into()),
        ..Default::default()
    };
    labels_on.clamp();
    assert_eq!(labels_on.bottom_nav_labels, Some("on".to_string()));

    // Ordinary state passes through unchanged.
    let mut small = UiStateSyncPayload {
        sidebar_width: Some(320),
        provider_order: Some(vec!["openai".into(), "anthropic".into()]),
        ..Default::default()
    };
    small.clamp();
    assert_eq!(small.sidebar_width, Some(320));
    assert_eq!(small.provider_order.unwrap().len(), 2);
    // A transfer that never mentions the labels leaves them unset.
    assert_eq!(small.bottom_nav_labels, None);
}

#[tokio::test]
async fn test_settings_transfer_includes_beta_flag() {
    let dir_sender = tempfile::tempdir().unwrap();
    let state_sender =
        Arc::new(AppState::new(dir_sender.path().to_path_buf(), "tok-beta-s".into()).unwrap());
    state_sender
        .settings
        .set_account_refresh_minutes(30)
        .unwrap();
    state_sender
        .settings
        .set_automatic_updates_enabled(false)
        .unwrap();
    state_sender
        .settings
        .set_include_beta_updates(true)
        .unwrap();
    state_sender.pairing_options.write().include_settings = true;

    let export_bytes = create_export_payload(&state_sender).unwrap();
    let payload: super::payload::SyncPayload = serde_json::from_slice(&export_bytes).unwrap();
    let settings = payload
        .settings
        .expect("settings must be included when opted in");
    assert!(settings.include_beta_updates);
    assert!(!settings.automatic_updates_enabled);
    assert_eq!(settings.account_refresh_minutes, 30);

    let dir_receiver = tempfile::tempdir().unwrap();
    let state_receiver =
        Arc::new(AppState::new(dir_receiver.path().to_path_buf(), "tok-beta-r".into()).unwrap());
    assert!(!state_receiver.settings.get().include_beta_updates);
    import_sync_payload(&state_receiver, &export_bytes, true)
        .await
        .unwrap();
    assert!(state_receiver.settings.get().include_beta_updates);
    assert!(!state_receiver.settings.get().automatic_updates_enabled);
    assert_eq!(state_receiver.settings.get().account_refresh_minutes, 30);
}

#[test]
fn old_settings_payload_without_beta_flag_still_parses() {
    // Payloads from older peers lack `include_beta_updates`; the default (off) applies.
    let raw = serde_json::json!({
        "account_refresh_minutes": 15,
        "automatic_updates_enabled": true,
        "autostart_enabled": false,
        "paseo_bridge_enabled": false
    });
    let parsed: super::payload::AppSettingsSyncPayload = serde_json::from_value(raw).unwrap();
    assert!(!parsed.include_beta_updates);
}

fn antigravity_account(id: &str, label: &str, email: &str, project_id: Option<&str>) -> Account {
    Account {
        id: id.into(),
        label: label.into(),
        provider: Provider::Antigravity,
        email: Some(email.into()),
        provider_account_id: project_id.map(str::to_string),
        plan: Some("Antigravity".into()),
        created_at: Utc::now().to_rfc3339(),
        updated_at: Utc::now().to_rfc3339(),
        ..Account::for_test()
    }
}

fn antigravity_secret(tag: &str) -> ProviderSecret {
    ProviderSecret::Antigravity(crate::model::OAuthSecret {
        access_token: format!("ya29-access-{tag}"),
        refresh_token: format!("refresh-{tag}"),
        id_token: None,
        expires_at: 0,
    })
}

// Regression test for the project-id collision: three Antigravity accounts whose
// usage polling resolved the SAME cloud project id must NOT collapse on import.
// Different emails prove they are different accounts even when the provider id
// (project id, cached by older builds) matches.
#[tokio::test]
async fn test_import_keeps_accounts_sharing_project_id() {
    let dir_sender = tempfile::tempdir().unwrap();
    let state_sender =
        Arc::new(AppState::new(dir_sender.path().to_path_buf(), "tok-as".into()).unwrap());

    for (id, email) in [
        ("sender-ag-1", "alice@example.com"),
        ("sender-ag-2", "bob@example.com"),
        ("sender-ag-3", "carol@example.com"),
    ] {
        state_sender
            .persist_connected_account(
                antigravity_account(id, id, email, Some("shared-project-123")),
                &antigravity_secret(id),
            )
            .await
            .unwrap();
    }
    state_sender
        .buckets
        .save(
            None,
            "Antigravity Team".into(),
            Some(Provider::Antigravity),
            vec!["sender-ag-1".into(), "sender-ag-2".into()],
        )
        .unwrap();

    let export_bytes = create_export_payload(&state_sender).unwrap();

    let dir_receiver = tempfile::tempdir().unwrap();
    let state_receiver =
        Arc::new(AppState::new(dir_receiver.path().to_path_buf(), "tok-ar".into()).unwrap());

    let summary = import_sync_payload(&state_receiver, &export_bytes, true)
        .await
        .unwrap();
    let accounts = state_receiver.store.list();
    assert_eq!(summary.added, 3, "all three distinct accounts must survive");
    assert_eq!(summary.updated, 0);
    assert_eq!(accounts.len(), 3);

    // The group keeps both grouped accounts after id remapping.
    let buckets = state_receiver.buckets.list();
    assert_eq!(buckets.len(), 1);
    assert_eq!(buckets[0].account_ids.len(), 2);

    // A second import of the same payload keeps all three accounts as they are.
    let summary2 = import_sync_payload(&state_receiver, &export_bytes, true)
        .await
        .unwrap();
    assert_eq!(summary2.added, 0);
    assert_eq!(summary2.updated, 0);
    assert_eq!(summary2.skipped, 3);
    assert_eq!(state_receiver.store.list().len(), 3);
}

// Control: distinct identity fields import independently.
#[tokio::test]
async fn test_import_keeps_distinct_antigravity_accounts() {
    let dir_sender = tempfile::tempdir().unwrap();
    let state_sender =
        Arc::new(AppState::new(dir_sender.path().to_path_buf(), "tok-bs".into()).unwrap());

    for (id, email, project) in [
        ("sender-bg-1", "alice@example.com", Some("proj-a")),
        ("sender-bg-2", "bob@example.com", Some("proj-b")),
        ("sender-bg-3", "carol@example.com", None),
    ] {
        state_sender
            .persist_connected_account(
                antigravity_account(id, id, email, project),
                &antigravity_secret(id),
            )
            .await
            .unwrap();
    }

    let dir_receiver = tempfile::tempdir().unwrap();
    let state_receiver =
        Arc::new(AppState::new(dir_receiver.path().to_path_buf(), "tok-br".into()).unwrap());

    let export_bytes = create_export_payload(&state_sender).unwrap();
    let summary = import_sync_payload(&state_receiver, &export_bytes, true)
        .await
        .unwrap();
    assert_eq!(summary.added, 3);
    assert_eq!(state_receiver.store.list().len(), 3);
}

// Duplicate email (case-insensitive) also collapses two different accounts that
// have no provider_account_id yet (e.g. before first successful refresh).
#[tokio::test]
async fn test_import_collapses_accounts_with_duplicate_email() {
    let dir_sender = tempfile::tempdir().unwrap();
    let state_sender =
        Arc::new(AppState::new(dir_sender.path().to_path_buf(), "tok-cs".into()).unwrap());

    let mut first = antigravity_account("sender-ce-1", "Main", "User@Example.com", None);
    let mut second = antigravity_account("sender-ce-2", "Re-added", "user@example.com", None);
    first.plan = Some("Antigravity".into());
    second.plan = Some("Antigravity".into());
    state_sender
        .persist_connected_account(first, &antigravity_secret("ce1"))
        .await
        .unwrap();
    state_sender
        .persist_connected_account(second, &antigravity_secret("ce2"))
        .await
        .unwrap();

    let dir_receiver = tempfile::tempdir().unwrap();
    let state_receiver =
        Arc::new(AppState::new(dir_receiver.path().to_path_buf(), "tok-cr".into()).unwrap());

    let export_bytes = create_export_payload(&state_sender).unwrap();
    let summary = import_sync_payload(&state_receiver, &export_bytes, true)
        .await
        .unwrap();
    assert_eq!(summary.added, 1);
    assert_eq!(summary.updated, 0);
    assert_eq!(summary.skipped, 1);
    assert_eq!(state_receiver.store.list().len(), 1);
}

// Deleting an account on the receiving device must not permanently block it.
// A later transfer of the same live account from another device restores it.
#[tokio::test]
async fn test_live_retransfer_restores_locally_deleted_account() {
    let dir_a = tempfile::tempdir().unwrap();
    let state_a = Arc::new(AppState::new(dir_a.path().to_path_buf(), "tok-da".into()).unwrap());
    state_a
        .persist_connected_account(
            antigravity_account("ghost-1", "Ghost", "ghost@example.com", Some("proj-g")),
            &antigravity_secret("ghost"),
        )
        .await
        .unwrap();

    let export_ab = create_export_payload(&state_a).unwrap();

    let dir_b = tempfile::tempdir().unwrap();
    let state_b = Arc::new(AppState::new(dir_b.path().to_path_buf(), "tok-db".into()).unwrap());
    let summary = import_sync_payload(&state_b, &export_ab, true)
        .await
        .unwrap();
    assert_eq!(summary.added, 1);
    assert!(state_b.store.get("ghost-1").is_some());

    state_b.store.remove("ghost-1").unwrap();
    assert!(state_b.store.list().is_empty());
    assert_eq!(state_b.store.tombstones(), vec!["ghost-1".to_string()]);

    crate::store::save_provider_secret("ghost-1", &antigravity_secret("ghost")).unwrap();

    let export_ab2 = create_export_payload(&state_a).unwrap();
    let summary = import_sync_payload(&state_b, &export_ab2, true)
        .await
        .unwrap();
    assert_eq!(
        summary.added, 1,
        "live re-transfer must restore a locally deleted account"
    );
    assert_eq!(summary.skipped, 0);
    assert!(state_b.store.get("ghost-1").is_some());
    assert!(state_b.store.tombstones().is_empty());
}

// Deleting an account on the sender must not remove it from the receiver.
#[tokio::test]
async fn test_sender_deletion_does_not_remove_receiver_account() {
    let dir_a = tempfile::tempdir().unwrap();
    let state_a = Arc::new(AppState::new(dir_a.path().to_path_buf(), "tok-da2".into()).unwrap());
    state_a
        .persist_connected_account(
            antigravity_account("ghost-2", "Ghost", "ghost2@example.com", Some("proj-g2")),
            &antigravity_secret("ghost2"),
        )
        .await
        .unwrap();

    let export_ab = create_export_payload(&state_a).unwrap();

    let dir_b = tempfile::tempdir().unwrap();
    let state_b = Arc::new(AppState::new(dir_b.path().to_path_buf(), "tok-db2".into()).unwrap());
    let summary = import_sync_payload(&state_b, &export_ab, true)
        .await
        .unwrap();
    assert_eq!(summary.added, 1);

    state_a.store.remove("ghost-2").unwrap();
    crate::store::save_provider_secret("ghost-2", &antigravity_secret("ghost2")).unwrap();

    let export_a2 = create_export_payload(&state_a).unwrap();
    let summary = import_sync_payload(&state_b, &export_a2, true)
        .await
        .unwrap();
    assert_eq!(summary.added, 0);
    assert!(
        state_b.store.get("ghost-2").is_some(),
        "receiver accounts must not be deleted by a transfer"
    );
}

#[tokio::test]
async fn test_select_role_rejects_invalid_role_string() {
    let manager = crate::pairing::PairingSessionManager::new();
    let err = manager.select_role("nonsense").await.unwrap_err();
    assert!(err.contains("Invalid role"), "unexpected error: {err}");
    assert!(
        !err.contains("nonsense"),
        "the rejected value must not be echoed: {err}"
    );
    let long = "x".repeat(10_000);
    let err = manager.select_role(&long).await.unwrap_err();
    assert!(err.len() < 100, "error must not grow with the input");
}

#[tokio::test]
async fn test_bucket_account_remapping_on_import() {
    let dir_receiver = tempfile::tempdir().unwrap();
    let state_receiver =
        Arc::new(AppState::new(dir_receiver.path().to_path_buf(), "tok-r".into()).unwrap());

    // Receiver already has the Anthropic account, but with a different local ID ("receiver-acc-99")
    let local_account = Account {
        id: "receiver-acc-99".into(),
        label: "Claude Local".into(),
        provider: Provider::Anthropic,
        email: Some("claude@example.com".into()),
        created_at: Utc::now().to_rfc3339(),
        updated_at: Utc::now().to_rfc3339(),
        ..Account::for_test()
    };
    let secret = ProviderSecret::Anthropic(crate::model::OAuthSecret {
        access_token: "sk-ant-local".into(),
        refresh_token: "sk-ant-refresh-local".into(),
        id_token: None,
        expires_at: 0,
    });
    state_receiver
        .persist_connected_account(local_account, &secret)
        .await
        .unwrap();

    // Sender has that same account with sender-side ID ("sender-acc-1") and a bucket containing it
    let dir_sender = tempfile::tempdir().unwrap();
    let state_sender =
        Arc::new(AppState::new(dir_sender.path().to_path_buf(), "tok-s".into()).unwrap());
    let sender_account = Account {
        id: "sender-acc-1".into(),
        label: "Claude Sender".into(),
        provider: Provider::Anthropic,
        email: Some("claude@example.com".into()),
        created_at: Utc::now().to_rfc3339(),
        updated_at: Utc::now().to_rfc3339(),
        ..Account::for_test()
    };
    let sender_secret = ProviderSecret::Anthropic(crate::model::OAuthSecret {
        access_token: "sk-ant-sender".into(),
        refresh_token: "sk-ant-refresh-sender".into(),
        id_token: None,
        expires_at: 0,
    });
    state_sender
        .persist_connected_account(sender_account, &sender_secret)
        .await
        .unwrap();
    state_sender
        .buckets
        .save(
            None,
            "Shared Project".into(),
            Some(Provider::Anthropic),
            vec!["sender-acc-1".into()],
        )
        .unwrap();

    let export_bytes = create_export_payload(&state_sender).unwrap();
    let summary = import_sync_payload(&state_receiver, &export_bytes, true)
        .await
        .unwrap();
    assert_eq!(summary.added, 0);
    assert_eq!(summary.updated, 0);
    assert_eq!(summary.skipped, 1);

    // Verify the bucket was imported and its account ID remapped to the receiver's local ID
    let receiver_buckets = state_receiver.buckets.list();
    assert_eq!(receiver_buckets.len(), 1);
    assert_eq!(receiver_buckets[0].name, "Shared Project");
    assert_eq!(
        receiver_buckets[0].account_ids,
        vec!["receiver-acc-99".to_string()]
    );

    // Default (preserve) path still remaps buckets while skipping credentials.
    let dir_receiver2 = tempfile::tempdir().unwrap();
    let state_receiver2 =
        Arc::new(AppState::new(dir_receiver2.path().to_path_buf(), "tok-r2".into()).unwrap());
    state_receiver2
        .persist_connected_account(
            Account {
                id: "receiver-acc-99".into(),
                label: "Claude Local".into(),
                provider: Provider::Anthropic,
                email: Some("claude@example.com".into()),
                created_at: Utc::now().to_rfc3339(),
                updated_at: Utc::now().to_rfc3339(),
                ..Account::for_test()
            },
            &ProviderSecret::Anthropic(crate::model::OAuthSecret {
                access_token: "sk-ant-local".into(),
                refresh_token: "sk-ant-refresh-local".into(),
                id_token: None,
                expires_at: 0,
            }),
        )
        .await
        .unwrap();
    let preserve = import_sync_payload(&state_receiver2, &export_bytes, true)
        .await
        .unwrap();
    assert_eq!(preserve.added, 0);
    assert_eq!(preserve.updated, 0);
    assert_eq!(preserve.skipped, 1);
    assert_eq!(state_receiver2.buckets.list().len(), 1);
}

#[tokio::test]
async fn host_listener_binds_only_the_advertised_address() {
    let listener = super::bind_pairing_listener("127.0.0.1").await.unwrap();
    assert_eq!(
        listener.local_addr().unwrap().ip(),
        std::net::IpAddr::from([127, 0, 0, 1])
    );

    // No fallback to all interfaces: anything that is not a local-network
    // address this machine can bind refuses host mode instead.
    for address in [
        "not-an-ip",
        "0.0.0.0",
        "8.8.8.8",        // public
        "192.0.2.10",     // public (documentation range)
        "10.254.254.253", // private, but not an address of this machine
    ] {
        assert!(
            super::bind_pairing_listener(address).await.is_err(),
            "{address} must not produce a listener"
        );
    }
}

#[tokio::test]
async fn without_a_network_address_the_host_listens_only_on_loopback() {
    let loopback = std::net::IpAddr::from([127, 0, 0, 1]);
    // No local-network address (a public one, none at all, or one this machine no longer has):
    // the session is file-only, unreachable from other devices and not announced.
    for address in ["8.8.8.8", "", "not-an-ip", "10.254.254.253"] {
        let (ip, listener, on_network) = super::bind_host_listener(address.to_string())
            .await
            .unwrap();
        assert!(!on_network, "{address}");
        assert_eq!(ip, "127.0.0.1");
        assert_eq!(listener.local_addr().unwrap().ip(), loopback);
    }
    // A local-network address is used as before, and announced.
    let (_, listener, on_network) = super::bind_host_listener("127.0.0.1".to_string())
        .await
        .unwrap();
    assert!(on_network);
    assert_eq!(listener.local_addr().unwrap().ip(), loopback);
}

#[test]
fn host_address_prefers_wifi_over_cellular_and_vpn() {
    use super::transport::lan::select_lan_ipv4;
    use std::net::Ipv4Addr;
    let candidates = |list: &[(&str, [u8; 4])]| -> Vec<(String, Ipv4Addr)> {
        list.iter()
            .map(|(name, ip)| (name.to_string(), Ipv4Addr::from(*ip)))
            .collect()
    };

    // iPhone: cellular pdp_ip0 (carrier 10.x) is listed before Wi-Fi en0.
    let iphone = candidates(&[
        ("lo0", [127, 0, 0, 1]),
        ("pdp_ip0", [10, 47, 3, 9]),
        ("en0", [192, 168, 1, 23]),
    ]);
    assert_eq!(
        select_lan_ipv4(&iphone),
        Some(Ipv4Addr::new(192, 168, 1, 23))
    );

    // Android with "mobile data always active" and a VPN-based ad blocker.
    let android = candidates(&[
        ("rmnet_data0", [10, 120, 4, 2]),
        ("tun0", [10, 111, 222, 1]),
        ("wlan0", [192, 168, 1, 40]),
    ]);
    assert_eq!(
        select_lan_ipv4(&android),
        Some(Ipv4Addr::new(192, 168, 1, 40))
    );

    // Desktop names that match no list keep their system order.
    let windows = candidates(&[("Ethernet", [10, 0, 0, 5]), ("Wi-Fi", [192, 168, 0, 9])]);
    assert_eq!(select_lan_ipv4(&windows), Some(Ipv4Addr::new(10, 0, 0, 5)));

    // With only a cellular private address it is still used rather than none.
    let cellular_only = candidates(&[("pdp_ip0", [10, 47, 3, 9])]);
    assert_eq!(
        select_lan_ipv4(&cellular_only),
        Some(Ipv4Addr::new(10, 47, 3, 9))
    );

    // Loopback, link-local, and CGNAT alone are not hosting addresses.
    let none = candidates(&[
        ("lo0", [127, 0, 0, 1]),
        ("en0", [169, 254, 3, 4]),
        ("utun3", [100, 101, 1, 2]),
    ]);
    assert_eq!(select_lan_ipv4(&none), None);
}

/// A phone sharing its hotspot while it is also on a Wi-Fi network: a joiner on the hotspot is
/// found on the hotspot interface, not the Wi-Fi the app ties pairing to.
#[test]
fn a_peer_is_matched_to_the_interface_on_its_subnet() {
    use super::transport::lan::interface_on_peer_subnet;
    use std::net::Ipv4Addr;
    let interfaces: Vec<(String, Ipv4Addr, u8)> = [
        ("lo", [127, 0, 0, 1], 8),
        ("rmnet_data0", [10, 120, 4, 2], 30),
        ("tun0", [10, 111, 222, 1], 32),
        ("wlan0", [192, 168, 1, 40], 24),
        ("swlan0", [10, 46, 172, 1], 24),
    ]
    .iter()
    .map(|(name, ip, prefix)| (name.to_string(), Ipv4Addr::from(*ip), *prefix))
    .collect();
    let on = |peer: [u8; 4]| interface_on_peer_subnet(&interfaces, Ipv4Addr::from(peer));

    assert_eq!(on([10, 46, 172, 88]), Some("swlan0"));
    assert_eq!(on([192, 168, 1, 7]), Some("wlan0"));
    // Behind a router, or loopback: no interface holds it.
    assert_eq!(on([192, 168, 2, 7]), None);
    assert_eq!(on([127, 0, 0, 1]), None);

    // The most specific subnet wins when two overlap.
    let overlapping: Vec<(String, Ipv4Addr, u8)> = vec![
        ("wide".into(), Ipv4Addr::new(10, 0, 0, 1), 8),
        ("narrow".into(), Ipv4Addr::new(10, 46, 172, 1), 24),
    ];
    assert_eq!(
        interface_on_peer_subnet(&overlapping, Ipv4Addr::new(10, 46, 172, 9)),
        Some("narrow")
    );
    assert_eq!(
        interface_on_peer_subnet(&overlapping, Ipv4Addr::new(10, 9, 9, 9)),
        Some("wide")
    );
}

/// A sender with an account plus everything an opted-in transfer carries: a group, non-default
/// settings, an account order and an alert.
async fn export_everything() -> (tempfile::TempDir, Vec<u8>) {
    let dir_sender = tempfile::tempdir().unwrap();
    let state_sender =
        Arc::new(AppState::new(dir_sender.path().to_path_buf(), "tok-w-s".into()).unwrap());
    let account = Account {
        id: "acc-w".into(),
        label: "Claude Work".into(),
        provider: Provider::Anthropic,
        email: Some("work@example.com".into()),
        plan: Some("Pro".into()),
        created_at: Utc::now().to_rfc3339(),
        updated_at: Utc::now().to_rfc3339(),
        ..Account::for_test()
    };
    let secret = ProviderSecret::Anthropic(crate::model::OAuthSecret {
        access_token: "sk-ant-access-w".into(),
        refresh_token: "sk-ant-refresh-w".into(),
        id_token: None,
        expires_at: 0,
    });
    state_sender
        .persist_connected_account(account, &secret)
        .await
        .unwrap();
    state_sender
        .buckets
        .save(
            None,
            "Work".into(),
            Some(Provider::Anthropic),
            vec!["acc-w".into()],
        )
        .unwrap();
    state_sender
        .settings
        .set_automatic_updates_enabled(false)
        .unwrap();
    state_sender
        .account_order
        .save(vec!["acc-w".into()], state_sender.store.list())
        .unwrap();
    state_sender
        .alerts
        .save(
            "acc-w",
            vec![crate::store::alerts::UsageAlertSetting {
                window_id: "weekly".into(),
                enabled: true,
                threshold_percent: 20,
            }],
        )
        .unwrap();
    state_sender.pairing_options.write().include_settings = true;
    let bytes = create_export_payload(&state_sender).unwrap();
    (dir_sender, bytes)
}

#[tokio::test]
async fn import_reports_no_warnings_when_everything_is_saved() {
    let (_sender_dir, export_bytes) = export_everything().await;
    let dir_receiver = tempfile::tempdir().unwrap();
    let state_receiver =
        Arc::new(AppState::new(dir_receiver.path().to_path_buf(), "tok-w-r".into()).unwrap());

    let summary = import_sync_payload(&state_receiver, &export_bytes, true)
        .await
        .unwrap();

    assert_eq!(summary.added, 1);
    assert!(summary.warnings.is_empty(), "{:?}", summary.warnings);
    assert_eq!(state_receiver.buckets.list().len(), 1);
    assert!(!state_receiver.settings.get().automatic_updates_enabled);
    assert_eq!(state_receiver.account_order.snapshot_ids(), vec!["acc-w"]);
    assert_eq!(state_receiver.alerts.get("acc-w").len(), 1);
}

#[tokio::test]
async fn import_reports_each_part_it_could_not_save_without_failing_the_transfer() {
    let (_sender_dir, export_bytes) = export_everything().await;
    let dir_receiver = tempfile::tempdir().unwrap();
    let state_receiver =
        Arc::new(AppState::new(dir_receiver.path().to_path_buf(), "tok-w-r2".into()).unwrap());
    // A directory where a store writes its file makes that one save fail.
    for file in [
        "account-buckets.json",
        "app-settings.json",
        "account-order.json",
        "usage-alerts.json",
    ] {
        std::fs::create_dir(dir_receiver.path().join(file)).unwrap();
    }

    let summary = import_sync_payload(&state_receiver, &export_bytes, true)
        .await
        .unwrap();

    // The account itself still arrived.
    assert_eq!(summary.added, 1);
    assert_eq!(state_receiver.store.list().len(), 1);
    let mut warnings = summary.warnings.clone();
    warnings.sort();
    assert_eq!(
        warnings,
        vec![
            "Some account groups couldn't be saved.",
            "Some settings couldn't be applied.",
            "Some usage alerts couldn't be saved.",
            "The account order couldn't be saved.",
        ]
    );
    // Warnings are fixed sentences, never what the peer sent.
    let text = warnings.join(" ");
    for secret in ["Claude Work", "work@example.com", "sk-ant", "acc-w"] {
        assert!(!text.contains(secret), "warning leaks {secret}");
    }
}

#[test]
fn sync_summary_without_warnings_still_parses() {
    // An older peer's summary has no `warnings` field.
    let parsed: super::payload::SyncSummary =
        serde_json::from_str(r#"{"added":1,"updated":2,"skipped":3}"#).unwrap();
    assert_eq!((parsed.added, parsed.updated, parsed.skipped), (1, 2, 3));
    assert!(parsed.warnings.is_empty());
}

#[test]
fn transfer_options_default_to_nothing_extra_and_reset_clears_every_choice() {
    use super::PairingTransferOptions;
    let fresh = PairingTransferOptions::default();
    assert!(!fresh.include_settings);
    assert!(fresh.pending_ui_state.is_none());

    let mut options = PairingTransferOptions {
        include_settings: true,
        accept_incoming_settings: true,
        pending_ui_state: Some(serde_json::json!({"theme": "dark"})),
        frozen: None,
    };
    options.freeze();
    options.reset();
    assert!(!options.include_settings);
    assert!(!options.accept_incoming_settings);
    assert!(options.pending_ui_state.is_none());
    // A confirm-time snapshot must not survive into the next transfer.
    assert!(!options.exported_extras().0);
}

#[tokio::test]
async fn starting_a_host_session_resets_the_transfer_options() {
    let dir = tempfile::tempdir().unwrap();
    let state = Arc::new(AppState::new(dir.path().to_path_buf(), "tok-opt".into()).unwrap());
    {
        let mut options = state.pairing_options.write();
        options.include_settings = true;
        options.pending_ui_state = Some(serde_json::json!({}));
    }
    // A host session needs a local network address; where there is none it fails after the
    // reset, which is the part under test.
    let _ = state.pairing.start_host(state.clone(), false, false).await;
    state.pairing.cancel().await;
    let options = state.pairing_options.read();
    assert!(!options.include_settings);
    assert!(options.pending_ui_state.is_none());
}

fn claude_account(id: &str, label: &str, email: &str) -> Account {
    Account {
        id: id.into(),
        label: label.into(),
        provider: Provider::Anthropic,
        email: Some(email.into()),
        plan: Some("Pro".into()),
        created_at: Utc::now().to_rfc3339(),
        updated_at: Utc::now().to_rfc3339(),
        ..Account::for_test()
    }
}

fn claude_secret(tag: &str) -> ProviderSecret {
    ProviderSecret::Anthropic(crate::model::OAuthSecret {
        access_token: format!("sk-ant-access-{tag}"),
        refresh_token: format!("sk-ant-refresh-{tag}"),
        id_token: None,
        expires_at: 0,
    })
}

/// Pairing never replaces credentials: an account this device already has keeps its own secret,
/// label and plan, whatever the other device sends for it.
#[tokio::test]
async fn import_never_overwrites_an_existing_accounts_local_credentials() {
    let dir_receiver = tempfile::tempdir().unwrap();
    let state_receiver =
        Arc::new(AppState::new(dir_receiver.path().to_path_buf(), "tok-keep-r".into()).unwrap());
    state_receiver
        .persist_connected_account(
            claude_account("local-1", "Local name", "me@example.com"),
            &claude_secret("local"),
        )
        .await
        .unwrap();

    let dir_sender = tempfile::tempdir().unwrap();
    let state_sender =
        Arc::new(AppState::new(dir_sender.path().to_path_buf(), "tok-keep-s".into()).unwrap());
    let mut sent = claude_account("sender-1", "Sender name", "ME@example.com");
    sent.plan = Some("Max".into());
    state_sender
        .persist_connected_account(sent, &claude_secret("sender"))
        .await
        .unwrap();
    let export_bytes = create_export_payload(&state_sender).unwrap();

    let summary = import_sync_payload(&state_receiver, &export_bytes, true)
        .await
        .unwrap();

    assert_eq!((summary.added, summary.updated, summary.skipped), (0, 0, 1));
    let accounts = state_receiver.store.list();
    assert_eq!(accounts.len(), 1);
    assert_eq!(accounts[0].id, "local-1");
    assert_eq!(accounts[0].label, "Local name");
    assert_eq!(accounts[0].plan.as_deref(), Some("Pro"));
    match crate::store::load_provider_secret("local-1").unwrap() {
        ProviderSecret::Anthropic(secret) => {
            assert_eq!(secret.access_token, "sk-ant-access-local");
            assert_eq!(secret.refresh_token, "sk-ant-refresh-local");
        }
        _ => panic!("the local secret changed provider"),
    }
    // Nothing was stored under the sender's id either.
    assert!(state_receiver.store.get("sender-1").is_none());
}

/// An account that matches only by the sender's own id still keeps its credentials.
#[tokio::test]
async fn import_keeps_credentials_when_only_the_account_id_matches() {
    // Credentials live in one store per process, keyed by account id, so the sender's payload is
    // exported before the receiver stores its own secret under the same id.
    let dir_sender = tempfile::tempdir().unwrap();
    let state_sender =
        Arc::new(AppState::new(dir_sender.path().to_path_buf(), "tok-id-s".into()).unwrap());
    state_sender
        .persist_connected_account(
            claude_account("shared-id", "Theirs", "theirs@example.com"),
            &claude_secret("theirs"),
        )
        .await
        .unwrap();
    let export_bytes = create_export_payload(&state_sender).unwrap();

    let dir_receiver = tempfile::tempdir().unwrap();
    let state_receiver =
        Arc::new(AppState::new(dir_receiver.path().to_path_buf(), "tok-id-r".into()).unwrap());
    state_receiver
        .persist_connected_account(
            claude_account("shared-id", "Mine", "mine@example.com"),
            &claude_secret("mine"),
        )
        .await
        .unwrap();

    let summary = import_sync_payload(&state_receiver, &export_bytes, true)
        .await
        .unwrap();
    assert_eq!(summary.skipped, 1);
    assert_eq!(state_receiver.store.list().len(), 1);
    assert_eq!(state_receiver.store.list()[0].label, "Mine");
    match crate::store::load_provider_secret("shared-id").unwrap() {
        ProviderSecret::Anthropic(secret) => assert_eq!(secret.access_token, "sk-ant-access-mine"),
        _ => panic!("the local secret changed provider"),
    }
}

fn exported_payload(state: &AppState) -> super::payload::SyncPayload {
    let bytes = create_export_payload(state).unwrap();
    serde_json::from_slice(&bytes).unwrap()
}

#[tokio::test]
async fn answers_are_refused_until_that_phase_and_a_confirm_freezes_the_extras() {
    let dir = tempfile::tempdir().unwrap();
    let state = Arc::new(AppState::new(dir.path().to_path_buf(), "tok-phase".into()).unwrap());
    let session_id = "session-phase";
    state.pairing.testing_open_session(session_id).await;

    let role_err = state.pairing.select_role("send").await.unwrap_err();
    assert!(role_err.contains("not in role selection"));
    let confirm_err = state
        .pairing
        .confirm_transfer(session_id, true, &state.pairing_options)
        .await
        .unwrap_err();
    assert!(confirm_err.contains("not waiting for confirmation"));

    // An offer for a different session is dropped, and this session stays closed.
    let (bogus_role_tx, mut bogus_role_rx) = oneshot::channel();
    state
        .pairing
        .offer_role_select("other-session", bogus_role_tx)
        .await;
    assert!(matches!(
        bogus_role_rx.try_recv(),
        Err(oneshot::error::TryRecvError::Closed)
    ));
    assert!(state.pairing.select_role("send").await.is_err());

    let (role_tx, mut role_rx) = oneshot::channel();
    state.pairing.offer_role_select(session_id, role_tx).await;
    state.pairing.select_role("send").await.unwrap();
    assert_eq!(role_rx.try_recv().unwrap(), "send");
    assert!(state.pairing.select_role("send").await.is_err());

    {
        let mut options = state.pairing_options.write();
        options.include_settings = true;
        options.pending_ui_state = Some(serde_json::json!({"theme": "dark"}));
    }
    let (confirm_tx, mut confirm_rx) = oneshot::channel();
    state
        .pairing
        .offer_transfer_confirm(session_id, confirm_tx)
        .await;
    state
        .pairing
        .confirm_transfer(session_id, true, &state.pairing_options)
        .await
        .unwrap();
    assert!(confirm_rx.try_recv().unwrap());
    assert!(state
        .pairing
        .confirm_transfer(session_id, true, &state.pairing_options)
        .await
        .is_err());

    // A later write must not take the settings back out of this transfer.
    {
        let mut options = state.pairing_options.write();
        options.include_settings = false;
        options.pending_ui_state = None;
    }
    let payload = exported_payload(&state);
    assert!(payload.settings.is_some());
    assert_eq!(
        payload.ui_state.and_then(|ui| ui.theme),
        Some("dark".to_string())
    );
}

#[tokio::test]
async fn a_confirm_while_settings_are_off_keeps_them_out_of_the_export() {
    let dir = tempfile::tempdir().unwrap();
    let state = Arc::new(AppState::new(dir.path().to_path_buf(), "tok-phase-off".into()).unwrap());
    let session_id = "session-off";
    state.pairing.testing_open_session(session_id).await;

    let (confirm_tx, mut confirm_rx) = oneshot::channel();
    state
        .pairing
        .offer_transfer_confirm(session_id, confirm_tx)
        .await;
    state
        .pairing
        .confirm_transfer(session_id, true, &state.pairing_options)
        .await
        .unwrap();
    assert!(confirm_rx.try_recv().unwrap());

    state.pairing_options.write().include_settings = true;
    state.pairing_options.write().pending_ui_state = Some(serde_json::json!({"theme": "light"}));
    let payload = exported_payload(&state);
    assert!(payload.settings.is_none());
    assert!(payload.ui_state.is_none());
}

#[tokio::test]
async fn declining_the_transfer_does_not_freeze_the_extras() {
    let dir = tempfile::tempdir().unwrap();
    let state = Arc::new(AppState::new(dir.path().to_path_buf(), "tok-phase-no".into()).unwrap());
    let session_id = "session-reject";
    state.pairing.testing_open_session(session_id).await;
    state.pairing_options.write().include_settings = true;

    let (confirm_tx, mut confirm_rx) = oneshot::channel();
    state
        .pairing
        .offer_transfer_confirm(session_id, confirm_tx)
        .await;
    state
        .pairing
        .confirm_transfer(session_id, false, &state.pairing_options)
        .await
        .unwrap();
    assert!(!confirm_rx.try_recv().unwrap());

    state.pairing_options.write().include_settings = false;
    assert!(exported_payload(&state).settings.is_none());
}

#[tokio::test]
async fn unfreeze_lets_the_next_export_read_the_live_choice() {
    let dir = tempfile::tempdir().unwrap();
    let state = Arc::new(AppState::new(dir.path().to_path_buf(), "tok-unfreeze".into()).unwrap());
    {
        let mut options = state.pairing_options.write();
        options.include_settings = true;
        options.freeze();
        options.include_settings = false;
        options.unfreeze();
    }
    assert!(exported_payload(&state).settings.is_none());
    state.pairing_options.write().include_settings = true;
    assert!(exported_payload(&state).settings.is_some());
}

#[test]
fn airgap_export_clears_a_confirm_freeze_before_using_the_live_choice() {
    // The air-gap command sets the live flags itself, after its own dialog.
    // A leftover LAN confirm must be dropped first, or the export would send
    // the earlier choice instead of the one this dialog just confirmed.
    let source = include_str!("../commands/pairing.rs").replace("\r\n", "\n");
    let start = source
        .find("fn pairing_prepare_airgap_export(")
        .expect("airgap export command");
    let body = &source[start..];
    let body = &body[..body.find("\n}\n").expect("end of function")];
    let unfreeze = body
        .find(".unfreeze()")
        .expect("airgap must drop a leftover freeze");
    let write = body
        .find("include_settings = include_settings")
        .expect("airgap writes the live choice");
    let export = body
        .find("airgap::prepare_airgap_export(")
        .expect("airgap builds the payload");
    assert!(unfreeze < write && write < export);
}

// ---------------------------------------------------------------------------
// Link-code key exchange and the pairing flow it gates
// ---------------------------------------------------------------------------

#[test]
fn the_same_code_gives_both_sides_the_same_key_and_another_code_does_not() {
    let salt = [3u8; 16];
    let (joiner, joiner_message) = PakeExchange::start_joiner("482019");
    let (host, host_message) = PakeExchange::start_host("482019");
    assert_eq!(joiner_message.len(), PAKE_MESSAGE_LEN);
    assert_eq!(host_message.len(), PAKE_MESSAGE_LEN);
    let joiner_key = joiner.finish(&host_message, &salt).unwrap();
    let host_key = host.finish(&joiner_message, &salt).unwrap();
    assert_eq!(joiner_key, host_key);

    // A wrong code is not an error: it is a key the other side does not have.
    let (guesser, guess_message) = PakeExchange::start_joiner("482018");
    let (host, host_message) = PakeExchange::start_host("482019");
    let guess_key = guesser.finish(&host_message, &salt).unwrap();
    let host_key = host.finish(&guess_message, &salt).unwrap();
    assert_ne!(guess_key, host_key);

    // The session nonce is part of the key.
    let (joiner, joiner_message) = PakeExchange::start_joiner("482019");
    let (host, host_message) = PakeExchange::start_host("482019");
    assert_ne!(
        joiner.finish(&host_message, &[1u8; 16]).unwrap(),
        host.finish(&joiner_message, &[2u8; 16]).unwrap()
    );
}

#[test]
fn malformed_and_reflected_key_exchange_messages_are_rejected() {
    let (host, host_message) = PakeExchange::start_host("482019");
    assert!(host.finish(&[0u8; 5], &[0u8; 16]).is_err());
    // A message sent back to the side that made it must not be accepted.
    let (host, _) = PakeExchange::start_host("482019");
    assert!(host.finish(&host_message, &[0u8; 16]).is_err());
}

#[test]
fn confirmation_tags_are_bound_to_the_key_the_session_and_the_role() {
    let key = [7u8; 32];
    let transcript = build_transcript(&[1u8; 16], &[2u8; 16], &[3u8; 33], &[4u8; 33]);
    let tag = compute_confirmation_tag(&key, &transcript, KEY_CONFIRM_JOINER_INFO);
    assert!(verify_confirmation_tag(
        &key,
        &transcript,
        KEY_CONFIRM_JOINER_INFO,
        &tag
    ));
    // Not replayable as the other side's proof, or as a transfer confirmation.
    for other in [
        KEY_CONFIRM_HOST_INFO,
        CONFIRM_SENDER_INFO,
        CONFIRM_RECEIVER_INFO,
    ] {
        assert!(!verify_confirmation_tag(&key, &transcript, other, &tag));
    }
    assert!(!verify_confirmation_tag(
        &[8u8; 32],
        &transcript,
        KEY_CONFIRM_JOINER_INFO,
        &tag
    ));
    let other_session = build_transcript(&[9u8; 16], &[2u8; 16], &[3u8; 33], &[4u8; 33]);
    assert!(!verify_confirmation_tag(
        &key,
        &other_session,
        KEY_CONFIRM_JOINER_INFO,
        &tag
    ));
}

/// Every frame read before the transfer is confirmed must use a small budget,
/// so a device on the network cannot make this one allocate 16 MB.
#[test]
fn only_the_encrypted_payload_is_read_with_the_large_frame_budget() {
    let source = [
        include_str!("transport/mod.rs"),
        include_str!("transport/host.rs"),
        include_str!("transport/client.rs"),
        include_str!("transport/transfer.rs"),
        include_str!("transport/events.rs"),
        include_str!("transport/lan.rs"),
        include_str!("transport/qr.rs"),
    ]
    .concat()
    .replace("\r\n", "\n");
    let mut large = 0;
    for (index, _) in source.match_indices("read_frame_limited(") {
        let call = &source[index..];
        let call = &call[..call.find(')').expect("end of call")];
        if call.contains("MAX_PREAUTH_FRAME_SIZE") || call.contains("MAX_CONTROL_FRAME_SIZE") {
            continue;
        }
        assert!(call.contains("MAX_FRAME_SIZE"), "unbounded read: {call}");
        large += 1;
    }
    assert_eq!(large, 1, "only the encrypted payload may be a large frame");
    let receive = &source[source.find("async fn receive_accounts(").unwrap()..];
    assert!(receive.contains("read_frame_limited(&mut stream, MAX_FRAME_SIZE)"));
}

#[test]
fn abort_reasons_keep_their_wire_numbers() {
    use crate::pairing::protocol::AbortReason::*;
    let expected: [(AbortReason, u8); 13] = [
        (BadHandshake, 0x01),
        (RoleSelectFailed, 0x04),
        (RoleSelectTimedOut, 0x05),
        (CanceledBeforeRole, 0x06),
        (RoleChoiceDropped, 0x07),
        (CanceledBeforeConfirm, 0x08),
        (TransferDeclined, 0x09),
        (PayloadInvalid, 0x0A),
        (PayloadTimedOut, 0x0B),
        (ImportFailed, 0x0C),
        (InvalidPeerKey, 0x0D),
        (WrongCode, 0x0E),
        (InvalidRole, 0x10),
    ];
    for (reason, number) in expected {
        assert_eq!(reason.payload(), [number], "{reason:?}");
    }
}

const TEST_CODE: &str = "482019";

async fn state_in(dir: &tempfile::TempDir, token: &str) -> Arc<AppState> {
    Arc::new(AppState::new(dir.path().to_path_buf(), token.into()).unwrap())
}

async fn state_with_account(dir: &tempfile::TempDir, token: &str) -> Arc<AppState> {
    let state = state_in(dir, token).await;
    state
        .persist_connected_account(
            claude_account("acc-pair", "Claude Pair", "pair@example.com"),
            &claude_secret("pair"),
        )
        .await
        .unwrap();
    state
}

/// A host session listening on loopback.
struct TestHost {
    found: DiscoveredHost,
    events: mpsc::Receiver<HostEvent>,
    confirm: oneshot::Sender<bool>,
    cancel: oneshot::Sender<()>,
}

async fn spawn_host(state: &Arc<AppState>, code: &str) -> TestHost {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let session_id = Uuid::new_v4();
    let nonce = vec![11u8; 16];
    let (status_tx, events) = mpsc::channel(16);
    let (confirm, confirm_rx) = oneshot::channel();
    let (cancel, cancel_rx) = oneshot::channel();
    tokio::spawn(run_host_listener(
        state.clone(),
        HostSession {
            session_id,
            listener,
            code: code.to_string(),
            session_nonce: nonce.clone(),
        },
        SessionChannels {
            status_tx,
            confirm_offer: None,
            confirm_rx,
            cancel_rx,
        },
    ));
    TestHost {
        found: DiscoveredHost {
            host: "127.0.0.1".into(),
            port,
            session_id,
            session_nonce: nonce,
        },
        events,
        confirm,
        cancel,
    }
}

/// A joining device.
struct TestClient {
    events: mpsc::Receiver<ClientEvent>,
    role: oneshot::Sender<String>,
    confirm: oneshot::Sender<bool>,
    cancel: oneshot::Sender<()>,
}

fn spawn_client(state: &Arc<AppState>, hosts: Vec<DiscoveredHost>, code: &str) -> TestClient {
    let (status_tx, events) = mpsc::channel(16);
    let (role, role_rx) = oneshot::channel();
    let (confirm, confirm_rx) = oneshot::channel();
    let (cancel, cancel_rx) = oneshot::channel();
    tokio::spawn(run_client_connector(
        state.clone(),
        "client-session".into(),
        hosts,
        code.to_string(),
        SessionChannels {
            status_tx,
            confirm_offer: None,
            confirm_rx,
            cancel_rx,
        },
        RoleChannels {
            role_offer: None,
            role_select_rx: role_rx,
        },
    ));
    TestClient {
        events,
        role,
        confirm,
        cancel,
    }
}

async fn next<E>(events: &mut mpsc::Receiver<E>) -> E {
    timeout(Duration::from_secs(10), events.recv())
        .await
        .expect("an event in time")
        .expect("the session is still running")
}

async fn host_completed(events: &mut mpsc::Receiver<HostEvent>) -> super::payload::SyncSummary {
    loop {
        match next(events).await {
            HostEvent::Completed(summary) => return summary,
            HostEvent::Failed(error) => panic!("host failed: {error}"),
            _ => {}
        }
    }
}

async fn client_completed(events: &mut mpsc::Receiver<ClientEvent>) -> super::payload::SyncSummary {
    loop {
        match next(events).await {
            ClientEvent::Completed(summary) => return summary,
            ClientEvent::Failed(error) => panic!("client failed: {error}"),
            _ => {}
        }
    }
}

async fn host_failure(events: &mut mpsc::Receiver<HostEvent>) -> String {
    loop {
        if let HostEvent::Failed(error) = next(events).await {
            return error;
        }
    }
}

async fn client_failure(events: &mut mpsc::Receiver<ClientEvent>) -> String {
    loop {
        if let ClientEvent::Failed(error) = next(events).await {
            return error;
        }
    }
}

#[tokio::test]
async fn both_sides_must_confirm_before_accounts_transfer() {
    let (dir_host, dir_client) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let host_state = state_in(&dir_host, "tok-h").await;
    let client_state = state_with_account(&dir_client, "tok-c").await;

    let mut host = spawn_host(&host_state, TEST_CODE).await;
    let mut client = spawn_client(&client_state, vec![host.found.clone()], TEST_CODE);

    assert!(matches!(
        next(&mut host.events).await,
        HostEvent::PeerConnected
    ));
    assert!(matches!(
        next(&mut client.events).await,
        ClientEvent::RoleSelection
    ));
    client.role.send("send".into()).unwrap();

    match next(&mut client.events).await {
        ClientEvent::ConfirmTransfer {
            role,
            account_count,
        } => {
            assert_eq!(role, "sender");
            assert_eq!(account_count, 1);
        }
        other => panic!("unexpected client event: {other:?}"),
    }
    match next(&mut host.events).await {
        HostEvent::ConfirmTransfer {
            role,
            account_count,
        } => {
            assert_eq!(role, "receiver");
            assert_eq!(account_count, 1);
        }
        other => panic!("unexpected host event: {other:?}"),
    }

    // Nothing moves until the sending user confirms.
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert!(host_state.store.list().is_empty());

    // Nothing moves after only the sender confirms: the receiver must agree before importing.
    client.confirm.send(true).unwrap();
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert!(host_state.store.list().is_empty());

    host.confirm.send(true).unwrap();
    assert_eq!(host_completed(&mut host.events).await.added, 1);
    assert_eq!(client_completed(&mut client.events).await.added, 1);
    assert_eq!(host_state.store.list()[0].label, "Claude Pair");
}

#[tokio::test]
async fn the_receiver_declining_sends_nothing() {
    let (dir_host, dir_client) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let host_state = state_in(&dir_host, "tok-h-dec").await;
    let client_state = state_with_account(&dir_client, "tok-c-dec").await;

    let mut host = spawn_host(&host_state, TEST_CODE).await;
    let mut client = spawn_client(&client_state, vec![host.found.clone()], TEST_CODE);
    next(&mut host.events).await;
    next(&mut client.events).await;
    client.role.send("send".into()).unwrap();
    next(&mut client.events).await;
    next(&mut host.events).await;

    client.confirm.send(true).unwrap();
    host.confirm.send(false).unwrap();
    assert!(host_failure(&mut host.events).await.contains("declined"));
    assert!(client_failure(&mut client.events)
        .await
        .contains("declined"));
    assert!(host_state.store.list().is_empty());
}

/// A peer that finished the link-code exchange still cannot deliver more
/// accounts than the number the role frame put on the confirm screen.
#[tokio::test]
async fn a_sender_cannot_deliver_more_accounts_than_it_showed() {
    let (dir_host, dir_sender) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let host_state = state_in(&dir_host, "tok-lie-h").await;
    let sender_state = state_with_account(&dir_sender, "tok-lie-s").await;
    let mut host = spawn_host(&host_state, TEST_CODE).await;
    let found = host.found.clone();
    let sender = sender_state.clone();
    let join = tokio::spawn(async move {
        lie_about_the_account_count(&found, TEST_CODE, &sender).await;
    });

    assert!(matches!(
        next(&mut host.events).await,
        HostEvent::PeerConnected
    ));
    match next(&mut host.events).await {
        HostEvent::ConfirmTransfer {
            role,
            account_count,
        } => {
            assert_eq!(role, "receiver");
            assert_eq!(account_count, 0);
        }
        other => panic!("unexpected host event: {other:?}"),
    }
    host.confirm.send(true).unwrap();
    assert!(matches!(
        next(&mut host.events).await,
        HostEvent::Transferring
    ));
    assert_eq!(
        host_failure(&mut host.events).await,
        MORE_ACCOUNTS_THAN_SHOWN
    );
    assert!(
        host_state.store.list().is_empty(),
        "a payload larger than the shown count must not be imported"
    );
    join.await.unwrap();
}

/// Joins `host` with the real link code, tells it this device has no accounts,
/// then sends one. The host must refuse.
async fn lie_about_the_account_count(host: &DiscoveredHost, code: &str, sender: &AppState) {
    let mut stream = TcpStream::connect((host.host.as_str(), host.port))
        .await
        .unwrap();
    let (exchange, joiner_message) = PakeExchange::start_joiner(code);
    let mut init = Vec::with_capacity(HANDSHAKE_INIT_LEN);
    init.extend_from_slice(&joiner_message);
    init.extend_from_slice(host.session_id.as_bytes());
    write_frame(&mut stream, MSG_HANDSHAKE_INIT, &init)
        .await
        .unwrap();

    let (msg_type, host_message) = timeout(
        Duration::from_secs(5),
        read_frame_limited(&mut stream, MAX_PREAUTH_FRAME_SIZE),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(msg_type, MSG_HANDSHAKE_RESP);
    assert_eq!(host_message.len(), PAKE_MESSAGE_LEN);
    let key = exchange.finish(&host_message, &host.session_nonce).unwrap();
    let transcript = build_transcript(
        host.session_id.as_bytes(),
        &host.session_nonce,
        &joiner_message,
        &host_message,
    );
    let proof = compute_confirmation_tag(&key, &transcript, KEY_CONFIRM_JOINER_INFO);
    write_frame(&mut stream, MSG_KEY_CONFIRM, &proof)
        .await
        .unwrap();

    let (msg_type, payload) = timeout(
        Duration::from_secs(5),
        read_frame_limited(&mut stream, MAX_PREAUTH_FRAME_SIZE),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(msg_type, MSG_KEY_CONFIRM);
    let tag: [u8; 32] = payload.as_slice().try_into().unwrap();
    assert!(verify_confirmation_tag(
        &key,
        &transcript,
        KEY_CONFIRM_HOST_INFO,
        &tag
    ));

    write_frame(
        &mut stream,
        MSG_ROLE_SELECT,
        &[ROLE_JOINER_SENDS, 0x00, 0x00],
    )
    .await
    .unwrap();
    let (msg_type, _) = timeout(
        Duration::from_secs(5),
        read_frame_limited(&mut stream, MAX_PREAUTH_FRAME_SIZE),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(msg_type, MSG_ROLE_SELECT_RESP);

    let confirm = compute_confirmation_tag(&key, &transcript, CONFIRM_SENDER_INFO);
    let mut body = Vec::with_capacity(1 + confirm.len());
    body.push(TRANSFER_ACCEPTED);
    body.extend_from_slice(&confirm);
    write_frame(&mut stream, MSG_TRANSFER_CONFIRM, &body)
        .await
        .unwrap();
    // Read the host's own confirmation before sending the payload. Closing
    // with that frame still unread makes the kernel reset the connection,
    // and the host then never sees the payload.
    let (msg_type, _) = timeout(
        Duration::from_secs(5),
        read_frame_limited(&mut stream, MAX_PREAUTH_FRAME_SIZE),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(msg_type, MSG_TRANSFER_CONFIRM);

    let export = create_export_payload(sender).unwrap();
    let encrypted = encrypt_payload(&key, &transcript, &export).unwrap();
    write_frame(&mut stream, MSG_ENCRYPTED_PAYLOAD, &encrypted)
        .await
        .unwrap();
    // Drain the refusal too, so dropping the socket does not reset it.
    let _ = timeout(
        Duration::from_secs(5),
        read_frame_limited(&mut stream, MAX_PREAUTH_FRAME_SIZE),
    )
    .await;
}

#[tokio::test]
async fn the_host_sends_when_the_joiner_chooses_to_receive() {
    let (dir_host, dir_client) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let host_state = state_with_account(&dir_host, "tok-h2").await;
    let client_state = state_in(&dir_client, "tok-c2").await;
    // The sender includes its settings, but the receiving user did not ask for them.
    host_state
        .settings
        .set_automatic_updates_enabled(false)
        .unwrap();
    host_state.pairing_options.write().include_settings = true;
    assert!(client_state.settings.get().automatic_updates_enabled);

    let mut host = spawn_host(&host_state, TEST_CODE).await;
    let mut client = spawn_client(&client_state, vec![host.found.clone()], TEST_CODE);
    next(&mut host.events).await;
    next(&mut client.events).await;
    client.role.send("receive".into()).unwrap();

    match next(&mut host.events).await {
        HostEvent::ConfirmTransfer { role, .. } => assert_eq!(role, "sender"),
        other => panic!("unexpected host event: {other:?}"),
    }
    match next(&mut client.events).await {
        ClientEvent::ConfirmTransfer { role, .. } => assert_eq!(role, "receiver"),
        other => panic!("unexpected client event: {other:?}"),
    }
    host.confirm.send(true).unwrap();
    client.confirm.send(true).unwrap();
    assert_eq!(client_completed(&mut client.events).await.added, 1);
    assert_eq!(host_completed(&mut host.events).await.added, 1);
    assert_eq!(client_state.store.list().len(), 1);
    assert!(
        client_state.settings.get().automatic_updates_enabled,
        "a sender must not change the receiver's settings unasked"
    );
}

#[tokio::test]
async fn a_declined_transfer_sends_nothing() {
    let (dir_host, dir_client) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let host_state = state_in(&dir_host, "tok-h3").await;
    let client_state = state_with_account(&dir_client, "tok-c3").await;

    let mut host = spawn_host(&host_state, TEST_CODE).await;
    let mut client = spawn_client(&client_state, vec![host.found.clone()], TEST_CODE);
    next(&mut host.events).await;
    next(&mut client.events).await;
    client.role.send("send".into()).unwrap();
    next(&mut client.events).await;

    client.confirm.send(false).unwrap();
    assert!(client_failure(&mut client.events)
        .await
        .contains("declined"));
    host_failure(&mut host.events).await;
    assert!(host_state.store.list().is_empty());
}

#[tokio::test]
async fn the_receiver_can_cancel_while_waiting_for_the_sender() {
    let (dir_host, dir_client) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let host_state = state_in(&dir_host, "tok-h4").await;
    let client_state = state_with_account(&dir_client, "tok-c4").await;

    let mut host = spawn_host(&host_state, TEST_CODE).await;
    let mut client = spawn_client(&client_state, vec![host.found.clone()], TEST_CODE);
    next(&mut host.events).await;
    next(&mut client.events).await;
    client.role.send("send".into()).unwrap();
    next(&mut client.events).await;
    assert!(matches!(
        next(&mut host.events).await,
        HostEvent::ConfirmTransfer { .. }
    ));

    // The receiving host cancels before the sender presses Send.
    host.cancel.send(()).unwrap();
    assert!(host_failure(&mut host.events).await.contains("Canceled"));
    // A Send pressed afterwards must not transfer anything.
    let _ = client.confirm.send(true);
    client_failure(&mut client.events).await;
    assert!(host_state.store.list().is_empty());
}

#[tokio::test]
async fn a_wrong_code_shows_nothing_on_the_host_and_three_end_the_session() {
    let (dir_host, dir_client) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let host_state = state_with_account(&dir_host, "tok-h5").await;
    let client_state = state_in(&dir_client, "tok-c5").await;
    let mut host = spawn_host(&host_state, TEST_CODE).await;

    for attempt in 1..MAX_CODE_ATTEMPTS {
        let mut wrong = spawn_client(&client_state, vec![host.found.clone()], "482018");
        assert_eq!(client_failure(&mut wrong.events).await, WRONG_CODE);
        // A device that does not know the code never reaches the host's user.
        assert!(
            host.events.try_recv().is_err(),
            "attempt {attempt} must not produce a host event"
        );
    }

    let mut last = spawn_client(&client_state, vec![host.found.clone()], "482017");
    assert_eq!(client_failure(&mut last.events).await, WRONG_CODE);
    assert_eq!(host_failure(&mut host.events).await, TOO_MANY_WRONG_CODES);

    // The session is over: even the right code no longer connects.
    let mut late = spawn_client(&client_state, vec![host.found.clone()], TEST_CODE);
    client_failure(&mut late.events).await;
    assert!(client_state.store.list().is_empty());
}

#[tokio::test]
async fn a_typo_does_not_end_the_session() {
    let (dir_host, dir_client) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let host_state = state_with_account(&dir_host, "tok-h6").await;
    let client_state = state_in(&dir_client, "tok-c6").await;
    let mut host = spawn_host(&host_state, TEST_CODE).await;

    let mut wrong = spawn_client(&client_state, vec![host.found.clone()], "482010");
    assert_eq!(client_failure(&mut wrong.events).await, WRONG_CODE);

    let mut client = spawn_client(&client_state, vec![host.found.clone()], TEST_CODE);
    assert!(matches!(
        next(&mut host.events).await,
        HostEvent::PeerConnected
    ));
    next(&mut client.events).await;
    client.role.send("receive".into()).unwrap();
    next(&mut host.events).await;
    host.confirm.send(true).unwrap();
    client.confirm.send(true).unwrap();
    assert_eq!(client_completed(&mut client.events).await.added, 1);
}

/// A device on the network knows the session id (it is announced) but not the
/// code. Whatever it sends, the host shows nothing and stays usable.
#[tokio::test]
async fn garbage_and_strangers_do_not_reach_the_user_or_use_up_attempts() {
    let (dir_host, dir_client) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let host_state = state_with_account(&dir_host, "tok-h7").await;
    let client_state = state_in(&dir_client, "tok-c7").await;
    let mut host = spawn_host(&host_state, TEST_CODE).await;
    let address = ("127.0.0.1", host.found.port);

    // More than MAX_CODE_ATTEMPTS malformed connections: none is a guess.
    for _ in 0..(MAX_CODE_ATTEMPTS + 2) {
        // Not a handshake at all.
        let mut socket = TcpStream::connect(address).await.unwrap();
        write_frame(&mut socket, MSG_HANDSHAKE_RESP, b"nonsense")
            .await
            .unwrap();
        let (kind, _) = read_frame(&mut socket).await.unwrap();
        assert_eq!(kind, MSG_ABORT);

        // The right session id with an invalid key exchange message.
        let mut socket = TcpStream::connect(address).await.unwrap();
        let mut init = vec![0xEEu8; PAKE_MESSAGE_LEN];
        init.extend_from_slice(host.found.session_id.as_bytes());
        assert_eq!(init.len(), HANDSHAKE_INIT_LEN);
        write_frame(&mut socket, MSG_HANDSHAKE_INIT, &init)
            .await
            .unwrap();
        let (kind, _) = read_frame(&mut socket).await.unwrap();
        assert_eq!(kind, MSG_ABORT);
    }

    // A well-formed exchange that stops before proving anything: the host
    // answers with its message only, never with its own proof.
    let mut socket = TcpStream::connect(address).await.unwrap();
    let (_exchange, message) = PakeExchange::start_joiner("000042");
    let mut init = message.clone();
    init.extend_from_slice(host.found.session_id.as_bytes());
    write_frame(&mut socket, MSG_HANDSHAKE_INIT, &init)
        .await
        .unwrap();
    let (kind, payload) = read_frame(&mut socket).await.unwrap();
    assert_eq!(kind, MSG_HANDSHAKE_RESP);
    assert_eq!(payload.len(), PAKE_MESSAGE_LEN);
    // A made-up proof is one wrong guess and gets an abort, not the host's proof.
    write_frame(&mut socket, MSG_KEY_CONFIRM, &[0u8; 32])
        .await
        .unwrap();
    let (kind, payload) = read_frame(&mut socket).await.unwrap();
    assert_eq!(kind, MSG_ABORT);
    assert_eq!(payload, AbortReason::WrongCode.payload());

    assert!(host.events.try_recv().is_err(), "nothing reached the user");

    // The real device still pairs.
    let mut client = spawn_client(&client_state, vec![host.found.clone()], TEST_CODE);
    assert!(matches!(
        next(&mut host.events).await,
        HostEvent::PeerConnected
    ));
    next(&mut client.events).await;
    client.role.send("receive".into()).unwrap();
    next(&mut host.events).await;
    host.confirm.send(true).unwrap();
    client.confirm.send(true).unwrap();
    assert_eq!(client_completed(&mut client.events).await.added, 1);
}

#[tokio::test]
async fn a_joiner_skips_hosts_that_do_not_share_the_code_but_only_a_few() {
    let dir_real = tempfile::tempdir().unwrap();
    let real_state = state_with_account(&dir_real, "tok-real").await;
    let dir_client = tempfile::tempdir().unwrap();
    let client_state = state_in(&dir_client, "tok-c8").await;

    // Other pairing hosts on the network, showing other codes.
    let mut others = Vec::new();
    let mut other_dirs = Vec::new();
    for index in 0..MAX_HOSTS_TRIED {
        let dir = tempfile::tempdir().unwrap();
        let state = state_in(&dir, &format!("tok-other-{index}")).await;
        others.push(spawn_host(&state, "135790").await);
        other_dirs.push(dir);
    }

    // One other host first: the joiner moves on to the real one.
    let mut real = spawn_host(&real_state, TEST_CODE).await;
    let mut client = spawn_client(
        &client_state,
        vec![others[0].found.clone(), real.found.clone()],
        TEST_CODE,
    );
    assert!(matches!(
        next(&mut real.events).await,
        HostEvent::PeerConnected
    ));
    assert!(matches!(
        next(&mut client.events).await,
        ClientEvent::RoleSelection
    ));
    drop(client.cancel);

    // More hosts than the limit ahead of the real one: the joiner stops
    // before reaching it, so a crowd of fake hosts gets few guesses.
    let mut hosts: Vec<DiscoveredHost> = others.iter().map(|host| host.found.clone()).collect();
    let mut second_real = spawn_host(&real_state, TEST_CODE).await;
    hosts.push(second_real.found.clone());
    let mut crowded = spawn_client(&client_state, hosts, TEST_CODE);
    assert_eq!(client_failure(&mut crowded.events).await, WRONG_CODE);
    assert!(second_real.events.try_recv().is_err());
}

#[tokio::test]
async fn settings_are_imported_only_when_the_receiving_user_asked_for_them() {
    let (_sender_dir, export_bytes) = export_everything().await;
    let dir_receiver = tempfile::tempdir().unwrap();
    let receiver = state_in(&dir_receiver, "tok-opt-in").await;

    let summary = import_sync_payload(&receiver, &export_bytes, false)
        .await
        .unwrap();
    assert_eq!(summary.added, 1, "accounts always come over");
    assert!(receiver.settings.get().automatic_updates_enabled);
    assert!(receiver.alerts.get("acc-w").is_empty());
    // Groups are part of the accounts, not of the settings.
    assert_eq!(receiver.buckets.list().len(), 1);
}

#[tokio::test]
async fn starting_a_session_records_whether_this_device_accepts_settings() {
    let dir = tempfile::tempdir().unwrap();
    let state = state_in(&dir, "tok-accept").await;
    // Hosting needs a local network address; without one it fails after the
    // options are set, which is the part under test.
    let _ = state.pairing.start_host(state.clone(), true, false).await;
    assert!(state.pairing_options.read().accept_incoming_settings);
    state.pairing.cancel().await;
    let _ = state.pairing.start_host(state.clone(), false, false).await;
    assert!(!state.pairing_options.read().accept_incoming_settings);
    state.pairing.cancel().await;
}

#[tokio::test]
async fn joining_with_a_malformed_code_says_what_a_code_looks_like() {
    let dir = tempfile::tempdir().unwrap();
    let state = state_in(&dir, "tok-nohost").await;
    let error = state
        .pairing
        .start_client_by_code(state.clone(), "12345".into(), false)
        .await
        .unwrap_err();
    assert_eq!(error, super::discovery::INVALID_CODE);
}

// Discovery between Bonjour (iOS) and mdns-sd (every other platform), in
// both directions. Needs a real network interface, so these are run by hand.
#[cfg(target_os = "macos")]
mod link_code_interop {
    use super::super::{discovery, dnssd, transport};
    use std::time::Duration;
    use tokio::net::TcpStream;
    use uuid::Uuid;

    #[derive(Clone, Copy, Debug)]
    enum Side {
        DnsSd,
        MdnsSd,
    }

    async fn check(advertiser: Side, browser: Side) {
        let ip = transport::get_local_lan_ip();
        let listener = super::super::bind_pairing_listener(&ip)
            .await
            .expect("this test needs a Wi-Fi or Ethernet address");
        let port = listener.local_addr().unwrap().port();
        let session_id = Uuid::new_v4();
        let nonce = [9u8; 16];
        let instance = discovery::generate_instance_name();

        let _dnssd_ad;
        let _mdns_ad;
        match advertiser {
            Side::DnsSd => {
                _dnssd_ad = Some(
                    dnssd::register(
                        &instance,
                        discovery::DNSSD_REGTYPE,
                        port,
                        transport::lan::interface_index_for_ip(&ip).unwrap_or(0),
                        &discovery::advertised_properties(session_id, &nonce),
                    )
                    .unwrap(),
                );
            }
            Side::MdnsSd => {
                _mdns_ad = Some(
                    discovery::advertise_mdns_sd(
                        &instance,
                        &ip,
                        port,
                        &discovery::advertised_properties(session_id, &nonce),
                    )
                    .unwrap(),
                );
            }
        }

        let timeout = Duration::from_secs(15);
        let found = match browser {
            Side::DnsSd => discovery::discover_dnssd(timeout).await,
            Side::MdnsSd => discovery::discover_mdns_sd(timeout).await,
        }
        .unwrap_or_else(|e| panic!("{advertiser:?} -> {browser:?}: {e}"));
        let host = found
            .hosts
            .into_iter()
            .find(|host| host.session_id == session_id)
            .unwrap_or_else(|| panic!("{advertiser:?} -> {browser:?}: host not found"));

        assert_eq!(host.host, ip, "{advertiser:?} -> {browser:?}");
        assert_eq!(host.port, port);
        assert_eq!(host.session_nonce, nonce);

        // The address the joiner found reaches the bound listener.
        let (accepted, connected) = tokio::join!(
            tokio::time::timeout(Duration::from_secs(5), listener.accept()),
            TcpStream::connect((host.host.as_str(), host.port)),
        );
        connected.expect("joiner connects to the found address");
        accepted.expect("host accepts in time").unwrap();
    }

    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "needs a LAN address and mDNSResponder"]
    async fn link_code_ios_host_android_joiner() {
        check(Side::DnsSd, Side::MdnsSd).await;
    }

    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "needs a LAN address and mDNSResponder"]
    async fn link_code_android_host_ios_joiner() {
        check(Side::MdnsSd, Side::DnsSd).await;
    }

    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "needs a LAN address and mDNSResponder"]
    async fn link_code_android_host_android_joiner() {
        check(Side::MdnsSd, Side::MdnsSd).await;
    }

    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "needs a LAN address and mDNSResponder"]
    async fn link_code_ios_host_ios_joiner() {
        check(Side::DnsSd, Side::DnsSd).await;
    }
}

/// A cancel while a join is still finding hosts must stop that join: it may
/// not install a session or report "connecting" afterwards (L-105).
#[tokio::test]
async fn a_join_cancelled_during_discovery_does_not_start_afterwards() {
    let dir = tempfile::tempdir().unwrap();
    let state = state_in(&dir, "tok-cancel-join").await;
    let epoch = state.pairing.testing_begin_start();
    // The user cancels while discovery is still running.
    state.pairing.cancel().await;
    let result = state
        .pairing
        .start_client(state.clone(), Vec::new(), "482019".into(), epoch)
        .await;
    assert!(result.unwrap_err().contains("interrupted"));
    assert!(matches!(
        state.pairing.get_status().await,
        super::PairingStatus::Idle
    ));
    assert!(
        state.pairing.select_role("send").await.is_err(),
        "no session was installed"
    );
}

async fn export_with_secret(id: &str, refresh_token: &str) -> Vec<u8> {
    let dir = tempfile::tempdir().unwrap();
    let sender = Arc::new(AppState::new(dir.path().to_path_buf(), "tok-send".into()).unwrap());
    let account = Account {
        id: id.into(),
        label: "Claude".into(),
        provider: Provider::Anthropic,
        email: Some("l106@example.com".into()),
        created_at: Utc::now().to_rfc3339(),
        updated_at: Utc::now().to_rfc3339(),
        ..Account::for_test()
    };
    let secret = ProviderSecret::Anthropic(crate::model::OAuthSecret {
        access_token: format!("access-{refresh_token}"),
        refresh_token: refresh_token.into(),
        id_token: None,
        expires_at: 0,
    });
    sender
        .persist_connected_account(account, &secret)
        .await
        .unwrap();
    create_export_payload(&sender).unwrap()
}

/// Two imports of the same account with different sign-ins, at the same
/// time: the first adds it, the second finds it and skips, and the first
/// sign-in is the one kept (L-106).
#[tokio::test]
async fn concurrent_imports_of_one_account_add_it_once_and_keep_the_first_sign_in() {
    let id = "acc-l106-concurrent";
    let first = export_with_secret(id, "refresh-first").await;
    let second = export_with_secret(id, "refresh-second").await;
    let dir = tempfile::tempdir().unwrap();
    let receiver = Arc::new(AppState::new(dir.path().to_path_buf(), "tok-recv".into()).unwrap());

    // Hold the account's lock, as a refresh would, so both imports are in
    // flight before either can save.
    let lock = receiver.account_lock(id);
    let guard = lock.lock().await;
    let import = |payload: Vec<u8>| {
        let receiver = receiver.clone();
        tokio::spawn(async move {
            import_sync_payload(&receiver, &payload, false)
                .await
                .unwrap()
        })
    };
    let first_import = import(first);
    tokio::time::sleep(Duration::from_millis(50)).await;
    let second_import = import(second);
    tokio::time::sleep(Duration::from_millis(50)).await;
    drop(guard);
    let first_summary = first_import.await.unwrap();
    let second_summary = second_import.await.unwrap();

    assert_eq!((first_summary.added, first_summary.skipped), (1, 0));
    assert_eq!((second_summary.added, second_summary.skipped), (0, 1));
    assert_eq!(receiver.store.list().len(), 1);
    match crate::store::load_provider_secret(id).unwrap() {
        ProviderSecret::Anthropic(secret) => assert_eq!(secret.refresh_token, "refresh-first"),
        other => panic!("unexpected secret {other:?}"),
    }
}

/// A payload with every optional part filled in, as a newer or older peer might send it.
fn full_sync_payload() -> super::payload::SyncPayload {
    use super::payload::{
        AccountOrderSyncPayload, AlertSyncEntry, AppSettingsSyncPayload, SyncAccountEntry,
        SyncPayload, UiStateSyncPayload, PAYLOAD_FORMAT,
    };
    use crate::model::{
        AccountBucket, LimitReset, OAuthSecret, UsageSnapshot, UsageWindow, WindowKind,
    };
    let pages = || std::collections::BTreeMap::from([("all".to_string(), vec!["acc-1".into()])]);
    SyncPayload {
        format: PAYLOAD_FORMAT.into(),
        exported_at: "2026-11-19T00:00:00Z".into(),
        accounts: vec![SyncAccountEntry {
            account: Account {
                id: "acc-1".into(),
                label: "Work".into(),
                provider: Provider::Anthropic,
                email: Some("user@example.com".into()),
                provider_account_id: Some("org-1".into()),
                plan: Some("max".into()),
                created_at: "2026-11-01T00:00:00Z".into(),
                updated_at: "2026-11-19T00:00:00Z".into(),
                last_usage: Some(UsageSnapshot {
                    plan: Some("max".into()),
                    windows: vec![UsageWindow {
                        id: "five_hour".into(),
                        label: "5 hour".into(),
                        used_percent: Some(40.0),
                        remaining_percent: Some(60.0),
                        resets_at: Some("2026-11-19T05:00:00Z".into()),
                        window_seconds: Some(18_000),
                        kind: Some(WindowKind::FiveHour),
                    }],
                    credits_usd: Some(2.5),
                    fetched_at: "2026-11-19T00:00:00Z".into(),
                    limit_resets: vec![LimitReset {
                        id: "grant-1".into(),
                        label: "Full reset".into(),
                        detail: "Clears the 5-hour limit".into(),
                        expires_at: None,
                        usable: true,
                        clears: vec![ResetTarget::FiveHour],
                    }],
                    ..UsageSnapshot::for_test()
                }),
                ..Account::for_test()
            },
            secret: ProviderSecret::Anthropic(OAuthSecret {
                access_token: "access".into(),
                refresh_token: "refresh".into(),
                id_token: Some("id".into()),
                expires_at: 1_790_000_000,
            }),
        }],
        buckets: vec![AccountBucket {
            id: "bucket-1".into(),
            name: "Work".into(),
            provider: Some(Provider::Anthropic),
            account_ids: vec!["acc-1".into()],
            created_at: "2026-11-01T00:00:00Z".into(),
            updated_at: "2026-11-01T00:00:00Z".into(),
        }],
        deleted_account_ids: vec!["acc-0".into()],
        settings: Some(AppSettingsSyncPayload {
            account_refresh_minutes: 15,
            automatic_updates_enabled: true,
            include_beta_updates: false,
            autostart_enabled: false,
            paseo_bridge_enabled: false,
        }),
        account_order: Some(AccountOrderSyncPayload {
            account_ids: vec!["acc-1".into()],
        }),
        alerts: Some(vec![AlertSyncEntry {
            account_id: "acc-1".into(),
            settings: vec![crate::store::alerts::UsageAlertSetting {
                window_id: "five_hour".into(),
                enabled: true,
                threshold_percent: 20,
            }],
        }]),
        ui_state: Some(UiStateSyncPayload {
            sidebar_group_order: Some(vec!["anthropic".into()]),
            provider_order: Some(vec!["anthropic".into()]),
            sidebar_window: Some("five_hour".into()),
            collapsed_account_ids: Some(vec!["acc-1".into()]),
            collapsed_cards: Some(pages()),
            page_account_order: Some(pages()),
            sidebar_width: Some(300),
            theme: Some("dark".into()),
            accent_color: Some("#2563eb".into()),
            usage_display_mode: Some("left".into()),
            bottom_nav_labels: Some("on".into()),
        }),
    }
}

/// Adds a field this version does not know to every JSON object in `value`, except the maps whose
/// keys are page names (any key there is a page, not a field).
fn add_unknown_fields(value: &mut serde_json::Value) -> usize {
    const PAGE_MAPS: [&str; 2] = ["collapsed_cards", "page_account_order"];
    match value {
        serde_json::Value::Object(object) => {
            let mut added = 0;
            for (key, child) in object.iter_mut() {
                if !PAGE_MAPS.contains(&key.as_str()) {
                    added += add_unknown_fields(child);
                }
            }
            object.insert(
                "fieldFromANewerVersion".into(),
                serde_json::json!({ "nested": [1, "two", null] }),
            );
            added + 1
        }
        serde_json::Value::Array(items) => items.iter_mut().map(add_unknown_fields).sum(),
        _ => 0,
    }
}

/// New optional fields can be added to anything a peer sends (accounts, snapshots, windows, limit
/// resets, groups, settings, alerts, layout, secrets) without breaking older receivers: a field a
/// device does not know is ignored, and everything it does know still arrives. Nothing in the
/// payload may use `#[serde(deny_unknown_fields)]`.
#[test]
fn payload_fields_from_a_newer_peer_are_ignored() {
    let expected = serde_json::to_value(full_sync_payload()).unwrap();
    let mut from_newer_peer = expected.clone();
    let added = add_unknown_fields(&mut from_newer_peer);
    // Every struct in the payload got one, from the top level down to the secret's credentials.
    assert!(added >= 14, "only {added} objects were extended");

    let bytes = serde_json::to_vec(&from_newer_peer).unwrap();
    let parsed = super::payload::validate_payload(&bytes).unwrap();
    assert_eq!(serde_json::to_value(parsed).unwrap(), expected);
}

/// Fields a newer peer leaves out entirely parse too, so an older peer's payload is accepted. This
/// lists the fields that may be missing; a new one belongs here with `#[serde(default)]`.
#[test]
fn payload_from_an_older_peer_without_newer_fields_parses() {
    let mut payload = serde_json::to_value(full_sync_payload()).unwrap();
    let object = payload.as_object_mut().unwrap();
    for key in [
        "deleted_account_ids",
        "settings",
        "account_order",
        "alerts",
        "ui_state",
    ] {
        object.remove(key);
    }
    let account = &mut payload["accounts"][0]["account"];
    for key in ["provider", "providerAccountId", "chatgptAccountId"] {
        account.as_object_mut().unwrap().remove(key);
    }
    let usage = &mut account["lastUsage"];
    usage["windows"][0].as_object_mut().unwrap().remove("kind");
    let reset = usage["limitResets"][0].as_object_mut().unwrap();
    reset.remove("usable");
    reset.remove("clears");
    let mut without_resets = payload.clone();
    without_resets["accounts"][0]["account"]["lastUsage"]
        .as_object_mut()
        .unwrap()
        .remove("limitResets");

    let bytes = serde_json::to_vec(&payload).unwrap();
    let parsed = super::payload::validate_payload(&bytes).unwrap();
    assert!(parsed.settings.is_none() && parsed.ui_state.is_none());
    let reset = &parsed.accounts[0]
        .account
        .last_usage
        .as_ref()
        .unwrap()
        .limit_resets[0];
    assert!(reset.usable && reset.clears.is_empty());

    let bytes = serde_json::to_vec(&without_resets).unwrap();
    let parsed = super::payload::validate_payload(&bytes).unwrap();
    assert!(parsed.accounts[0]
        .account
        .last_usage
        .as_ref()
        .unwrap()
        .limit_resets
        .is_empty());
}

/// `ResetTarget` shipped with its fallback, so a target a newer peer adds is read as `Other`
/// instead of refusing the payload (docs/DATA_COMPATIBILITY.md, rule 4).
#[test]
fn a_reset_target_from_a_newer_peer_is_read_as_other() {
    let mut payload = serde_json::to_value(full_sync_payload()).unwrap();
    *payload
        .pointer_mut("/accounts/0/account/lastUsage/limitResets/0/clears/0")
        .unwrap() = "monthly".into();
    let bytes = serde_json::to_vec(&payload).unwrap();
    let parsed = super::payload::validate_payload(&bytes).unwrap();
    let reset = &parsed.accounts[0]
        .account
        .last_usage
        .as_ref()
        .unwrap()
        .limit_resets[0];
    assert_eq!(reset.clears, [ResetTarget::Other]);
}

/// The limit of the rule above: a value this version does not know for an existing enum (a new
/// provider, window kind or freshness) is not ignored, and the whole payload is refused. New values
/// for those enums therefore need a fallback (`#[serde(other)]`) first, or must stay out of what
/// peers send. If this starts passing payloads through, update the additive-fields rule in
/// `docs/DATA_COMPATIBILITY.md`.
#[test]
fn an_unknown_enum_value_from_a_newer_peer_refuses_the_payload() {
    let expected = serde_json::to_value(full_sync_payload()).unwrap();
    let cases = [
        ("provider", "/accounts/0/account/provider", "new_provider"),
        (
            "window kind",
            "/accounts/0/account/lastUsage/windows/0/kind",
            "daily",
        ),
        (
            "freshness",
            "/accounts/0/account/lastUsage/freshness",
            "partial",
        ),
        (
            "secret provider",
            "/accounts/0/secret/provider",
            "new_provider",
        ),
    ];
    for (name, pointer, value) in cases {
        let mut payload = expected.clone();
        *payload.pointer_mut(pointer).unwrap() = value.into();
        let bytes = serde_json::to_vec(&payload).unwrap();
        assert!(
            super::payload::validate_payload(&bytes).is_err(),
            "an unknown {name} was accepted"
        );
    }
}

/// The page shows a pairing failure's message as it is: the sentences the pairing code writes
/// for people keep their text and get a code, and protocol detail never reaches the page.
#[test]
fn pairing_failures_are_sentences_with_codes() {
    use super::transport::{
        CANCELED_BY_USER, MORE_ACCOUNTS_THAN_SHOWN, NO_DEVICE, OTHER_DEVICE_DECLINED,
        ROLES_DISAGREE, TOO_MANY_WRONG_CODES, WRONG_CODE,
    };
    use crate::commands::error::ErrorCode;
    let cases = [
        (WRONG_CODE, ErrorCode::Invalid),
        (TOO_MANY_WRONG_CODES, ErrorCode::Invalid),
        (OTHER_DEVICE_DECLINED, ErrorCode::Cancelled),
        (CANCELED_BY_USER, ErrorCode::Cancelled),
        (NO_DEVICE, ErrorCode::NotFound),
        (ROLES_DISAGREE, ErrorCode::Pairing),
        (MORE_ACCOUNTS_THAN_SHOWN, ErrorCode::Pairing),
    ];
    for (sentence, code) in cases {
        let error = super::failure(sentence.to_string());
        assert_eq!((error.code, error.message.as_str()), (code, sentence));
    }
    for detail in [
        "Expected MSG_ACK",
        "Invalid handshake length: 12",
        "Socket accept error: Bearer abcdefghijklmnopqrstuvwxyz0123456789",
        "Timed out waiting for host account count",
    ] {
        let error = super::failure(detail.to_string());
        assert_eq!(error.code, ErrorCode::Pairing);
        assert_eq!(error.message, super::LINK_BROKE);
    }
}

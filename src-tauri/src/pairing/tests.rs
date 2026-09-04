use super::{
    crypto::{
        build_transcript, compute_confirmation_tag, compute_sas_code, decrypt_payload,
        encrypt_payload, verify_confirmation_tag, EphemeralKeyPair, CONFIRM_RECEIVER_INFO,
        CONFIRM_SENDER_INFO,
    },
    payload::{create_export_payload, import_sync_payload},
    protocol::{
        generate_qr_uri, parse_qr_uri, read_frame, write_frame, MSG_HANDSHAKE_INIT,
        MSG_HANDSHAKE_RESP,
    },
    transport::{
        run_client_connector, run_host_listener, run_receiver_listener, run_sender_client,
        ClientEvent, HostEvent, ReceiverEvent, SenderEvent,
    },
};
use crate::{
    model::{Account, Provider, ProviderSecret},
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
fn test_qr_code_svg() {
    let uri = "aiusage-pair://192.168.1.100:9000?session=test&key=abc&nonce=123";
    let svg = crate::pairing::transport::generate_qr_svg(uri).unwrap();
    assert!(svg.contains("<svg"));
    assert!(svg.contains("fill=\"#000000\""));
    assert!(svg.contains("fill=\"#ffffff\""));
}

#[test]
fn test_ephemeral_diffie_hellman_and_hkdf() {
    let alice = EphemeralKeyPair::generate();
    let bob = EphemeralKeyPair::generate();

    let alice_pub = alice.public_bytes();
    let bob_pub = bob.public_bytes();

    let session_id = Uuid::new_v4();
    let session_nonce = [1u8; 16];

    // Alice is receiver, Bob is sender
    let alice_transcript = build_transcript(
        session_id.as_bytes(),
        &session_nonce,
        &alice_pub,
        &bob_pub,
    );
    let bob_transcript = build_transcript(
        session_id.as_bytes(),
        &session_nonce,
        &alice_pub,
        &bob_pub,
    );
    assert_eq!(alice_transcript, bob_transcript);

    let bob_point = x25519_dalek::PublicKey::from(bob_pub);
    let alice_derived = alice.diffie_hellman(&bob_point);
    let alice_key = alice_derived
        .derive_encryption_key(&session_nonce)
        .unwrap();

    let alice_point = x25519_dalek::PublicKey::from(alice_pub);
    let bob_derived = bob.diffie_hellman(&alice_point);
    let bob_key = bob_derived
        .derive_encryption_key(&session_nonce)
        .unwrap();

    assert_eq!(alice_key, bob_key);

    // SAS codes match
    let alice_sas = compute_sas_code(&alice_key, &alice_transcript);
    let bob_sas = compute_sas_code(&bob_key, &bob_transcript);
    assert_eq!(alice_sas, bob_sas);
    assert_eq!(alice_sas.len(), 9);
}

#[test]
fn test_confirmation_tags() {
    let alice = EphemeralKeyPair::generate();
    let bob = EphemeralKeyPair::generate();
    let session_id = Uuid::new_v4();
    let session_nonce = [10u8; 16];

    let transcript = build_transcript(
        session_id.as_bytes(),
        &session_nonce,
        &alice.public_bytes(),
        &bob.public_bytes(),
    );

    let bob_point = x25519_dalek::PublicKey::from(bob.public_bytes());
    let alice_derived = alice.diffie_hellman(&bob_point);
    let key = alice_derived
        .derive_encryption_key(&session_nonce)
        .unwrap();

    let sas_code = compute_sas_code(&key, &transcript);
    let tag_receiver = compute_confirmation_tag(&key, &sas_code, CONFIRM_RECEIVER_INFO);
    let tag_sender = compute_confirmation_tag(&key, &sas_code, CONFIRM_SENDER_INFO);

    assert_ne!(tag_receiver, tag_sender);
    assert!(verify_confirmation_tag(
        &key,
        &sas_code,
        CONFIRM_RECEIVER_INFO,
        &tag_receiver
    ));
    assert!(verify_confirmation_tag(
        &key,
        &sas_code,
        CONFIRM_SENDER_INFO,
        &tag_sender
    ));

    // Tampered tag must fail
    let mut tampered = tag_receiver;
    tampered[0] ^= 0xFF;
    assert!(!verify_confirmation_tag(
        &key,
        &sas_code,
        CONFIRM_RECEIVER_INFO,
        &tampered
    ));
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

#[test]
fn test_qr_uri_parsing_and_formatting() {
    let ip = "192.168.1.100";
    let port = 49200;
    let pubkey = [7u8; 32];
    let session_id = Uuid::new_v4();
    let nonce = [9u8; 16];

    let uri = generate_qr_uri(ip, port, &pubkey, session_id, &nonce);
    let parsed = parse_qr_uri(&uri).unwrap();

    assert_eq!(parsed.host, ip);
    assert_eq!(parsed.port, port);
    assert_eq!(parsed.receiver_public_key, pubkey);
    assert_eq!(parsed.session_id, session_id);
    assert_eq!(parsed.session_nonce, nonce);
    assert!(!parsed.fingerprint.is_empty());
    assert_eq!(parsed.fingerprint.len(), 9); // e.g. "XXXX-XXXX"

    // Bad scheme
    assert!(parse_qr_uri("http://example.com").is_err());
    // Missing host
    assert!(parse_qr_uri("aiusage-pair://:8080?pk=aa&sid=bb&n=cc").is_err());
    // Missing pk
    assert!(parse_qr_uri(&format!("aiusage-pair://{ip}:{port}?sid={session_id}&n=aa")).is_err());
    // Corrupt hex in pk
    assert!(parse_qr_uri(&format!("aiusage-pair://{ip}:{port}?pk=nothex&sid={session_id}&n=aa")).is_err());
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
async fn test_export_and_import_payload() {
    let dir_sender = tempfile::tempdir().unwrap();
    let state_sender = Arc::new(AppState::new(dir_sender.path().to_path_buf(), "tok1".into()).unwrap());

    // Populate sender state with an account and bucket
    let account = Account {
        id: "acc-1".into(),
        label: "Claude Primary".into(),
        provider: Provider::Anthropic,
        email: Some("user@example.com".into()),
        provider_account_id: None,
        chatgpt_account_id: None,
        plan: Some("Pro".into()),
        created_at: Utc::now().to_rfc3339(),
        updated_at: Utc::now().to_rfc3339(),
        last_usage: None,
        last_error: None,
        auth_required: false,
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

    let summary = import_sync_payload(&state_receiver, &export_bytes)
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

    // Importing again should update/skip duplicates
    let summary2 = import_sync_payload(&state_receiver, &export_bytes)
        .await
        .unwrap();
    assert_eq!(summary2.added, 0);
    assert_eq!(summary2.updated, 1);
    assert_eq!(buckets[0].account_ids, vec!["acc-1".to_string()]);
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
        provider_account_id: None,
        chatgpt_account_id: None,
        plan: None,
        created_at: Utc::now().to_rfc3339(),
        updated_at: Utc::now().to_rfc3339(),
        last_usage: None,
        last_error: None,
        auth_required: false,
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
        provider_account_id: None,
        chatgpt_account_id: None,
        plan: None,
        created_at: Utc::now().to_rfc3339(),
        updated_at: Utc::now().to_rfc3339(),
        last_usage: None,
        last_error: None,
        auth_required: false,
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
    let summary = import_sync_payload(&state_receiver, &export_bytes)
        .await
        .unwrap();
    assert_eq!(summary.added, 0);
    assert_eq!(summary.updated, 1);

    // Verify the bucket was imported and its account ID remapped to the receiver's local ID
    let receiver_buckets = state_receiver.buckets.list();
    assert_eq!(receiver_buckets.len(), 1);
    assert_eq!(receiver_buckets[0].name, "Shared Project");
    assert_eq!(
        receiver_buckets[0].account_ids,
        vec!["receiver-acc-99".to_string()]
    );
}

#[tokio::test]
async fn test_end_to_end_pairing_flow() {
    let dir_sender = tempfile::tempdir().unwrap();
    let state_sender =
        Arc::new(AppState::new(dir_sender.path().to_path_buf(), "tok-s".into()).unwrap());

    let account = Account {
        id: "sender-acc-1".into(),
        label: "OpenAI Main".into(),
        provider: Provider::Openai,
        email: Some("dev@example.com".into()),
        provider_account_id: None,
        chatgpt_account_id: None,
        plan: Some("Plus".into()),
        created_at: Utc::now().to_rfc3339(),
        updated_at: Utc::now().to_rfc3339(),
        last_usage: None,
        last_error: None,
        auth_required: false,
    };
    let secret = ProviderSecret::Openai(crate::model::OAuthSecret {
        access_token: "sk-openai-access-123".into(),
        refresh_token: "sk-openai-refresh-123".into(),
        id_token: None,
        expires_at: 0,
    });
    state_sender
        .persist_connected_account(account, &secret)
        .await
        .unwrap();

    let dir_receiver = tempfile::tempdir().unwrap();
    let state_receiver =
        Arc::new(AppState::new(dir_receiver.path().to_path_buf(), "tok-r".into()).unwrap());

    // Start receiver on 127.0.0.1
    let receiver_keypair = EphemeralKeyPair::generate();
    let session_id = Uuid::new_v4();
    let receiver_nonce = vec![11u8; 16];
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();

    let qr_uri = generate_qr_uri(
        "127.0.0.1",
        port,
        &receiver_keypair.public_bytes(),
        session_id,
        &receiver_nonce,
    );

    let (recv_status_tx, mut recv_status_rx) = mpsc::channel(16);
    let (recv_confirm_tx, recv_confirm_rx) = oneshot::channel();
    let (_recv_cancel_tx, recv_cancel_rx) = oneshot::channel();

    tokio::spawn(run_receiver_listener(
        state_receiver.clone(),
        session_id,
        listener,
        receiver_keypair,
        receiver_nonce,
        recv_status_tx,
        recv_confirm_rx,
        recv_cancel_rx,
    ));

    // Start sender
    let parsed_qr = parse_qr_uri(&qr_uri).unwrap();

    let (send_status_tx, mut send_status_rx) = mpsc::channel(16);
    let (send_confirm_tx, send_confirm_rx) = oneshot::channel();
    let (_send_cancel_tx, send_cancel_rx) = oneshot::channel();

    tokio::spawn(run_sender_client(
        state_sender.clone(),
        parsed_qr,
        send_status_tx,
        send_confirm_rx,
        send_cancel_rx,
    ));

    // Await Connected events from both sides
    let recv_sas = match timeout(Duration::from_secs(5), recv_status_rx.recv())
        .await
        .unwrap()
        .unwrap()
    {
        ReceiverEvent::Connected(sas) => sas,
        _other => panic!("Expected ReceiverEvent::Connected, got other event"),
    };

    let send_sas = match timeout(Duration::from_secs(5), send_status_rx.recv())
        .await
        .unwrap()
        .unwrap()
    {
        SenderEvent::Connected {
            sas_code,
            account_count,
            ..
        } => {
            assert_eq!(account_count, 1);
            sas_code
        }
        _other => panic!("Expected SenderEvent::Connected, got other event"),
    };

    // Verify SAS codes match
    assert_eq!(recv_sas, send_sas);

    // Confirm on both sides
    recv_confirm_tx.send(true).unwrap();
    send_confirm_tx.send(true).unwrap();

    // Await Transferring and Completed on receiver
    let mut recv_completed = false;
    while let Some(event) = recv_status_rx.recv().await {
        match event {
            ReceiverEvent::Transferring => {}
            ReceiverEvent::Completed(summary) => {
                assert_eq!(summary.added, 1);
                recv_completed = true;
                break;
            }
            ReceiverEvent::Failed(err) => panic!("Receiver failed: {err}"),
            _ => {}
        }
    }
    assert!(recv_completed);

    // Await Completed on sender
    let mut send_completed = false;
    while let Some(event) = send_status_rx.recv().await {
        match event {
            SenderEvent::Transferring => {}
            SenderEvent::Completed(summary) => {
                assert_eq!(summary.added, 1);
                send_completed = true;
                break;
            }
            SenderEvent::Failed(err) => panic!("Sender failed: {err}"),
            _ => {}
        }
    }
    assert!(send_completed);

    // Verify receiver now has the account
    let imported_accounts = state_receiver.store.list();
    assert_eq!(imported_accounts.len(), 1);
    assert_eq!(imported_accounts[0].label, "OpenAI Main");
}

#[tokio::test]
async fn test_end_to_end_role_selection_client_sends() {
    // Client has account, Host is empty. Client connects and chooses "send".
    let dir_client = tempfile::tempdir().unwrap();
    let state_client = Arc::new(AppState::new(dir_client.path().to_path_buf(), "tok-c".into()).unwrap());

    let account = Account {
        id: "client-acc-1".into(),
        label: "Client Grok Account".into(),
        provider: Provider::Grok,
        email: Some("grok@example.com".into()),
        provider_account_id: None,
        chatgpt_account_id: None,
        plan: Some("Premium".into()),
        created_at: Utc::now().to_rfc3339(),
        updated_at: Utc::now().to_rfc3339(),
        last_usage: None,
        last_error: None,
        auth_required: false,
    };
    let secret = ProviderSecret::Grok(crate::model::GrokSecret {
        cookie_header: Some("sso-cookie-secret".into()),
        auth_file: None,
    });
    state_client.persist_connected_account(account, &secret).await.unwrap();

    let dir_host = tempfile::tempdir().unwrap();
    let state_host = Arc::new(AppState::new(dir_host.path().to_path_buf(), "tok-h".into()).unwrap());

    let host_keypair = EphemeralKeyPair::generate();
    let session_id = Uuid::new_v4();
    let host_nonce = vec![22u8; 16];
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();

    let qr_uri = generate_qr_uri(
        "127.0.0.1",
        port,
        &host_keypair.public_bytes(),
        session_id,
        &host_nonce,
    );

    let (host_status_tx, mut host_status_rx) = mpsc::channel(16);
    let (host_confirm_tx, host_confirm_rx) = oneshot::channel();
    let (_host_cancel_tx, host_cancel_rx) = oneshot::channel();
    let parsed_qr = parse_qr_uri(&qr_uri).unwrap();
    let fp = parsed_qr.fingerprint.clone();

    tokio::spawn(run_host_listener(
        state_host.clone(),
        session_id,
        listener,
        host_keypair,
        host_nonce,
        fp,
        host_status_tx,
        host_confirm_rx,
        host_cancel_rx,
    ));

    let (client_status_tx, mut client_status_rx) = mpsc::channel(16);
    let (role_select_tx, role_select_rx) = oneshot::channel();
    let (client_confirm_tx, client_confirm_rx) = oneshot::channel();
    let (_client_cancel_tx, client_cancel_rx) = oneshot::channel();

    tokio::spawn(run_client_connector(
        state_client.clone(),
        parsed_qr,
        client_status_tx,
        role_select_rx,
        client_confirm_rx,
        client_cancel_rx,
    ));

    // Client selects "send"
    role_select_tx.send("send".to_string()).unwrap();

    // Verify host role resolves to receiver
    let mut host_sas = String::new();
    while let Some(ev) = host_status_rx.recv().await {
        if let HostEvent::SasVerification { sas_code, role, account_count, .. } = ev {
            assert_eq!(role, "receiver");
            assert_eq!(account_count, 1);
            host_sas = sas_code;
            break;
        }
    }

    // Verify client role resolves to sender
    let mut client_sas = String::new();
    while let Some(ev) = client_status_rx.recv().await {
        if let ClientEvent::SasVerification { sas_code, role, account_count, .. } = ev {
            assert_eq!(role, "sender");
            assert_eq!(account_count, 1);
            client_sas = sas_code;
            break;
        }
    }

    assert_eq!(host_sas, client_sas);

    // Both confirm
    host_confirm_tx.send(true).unwrap();
    client_confirm_tx.send(true).unwrap();

    // Verify host received and imported account
    while let Some(ev) = host_status_rx.recv().await {
        if let HostEvent::Completed(summary) = ev {
            assert_eq!(summary.added, 1);
            break;
        }
    }

    let host_accounts = state_host.store.list();
    assert_eq!(host_accounts.len(), 1);
    assert_eq!(host_accounts[0].label, "Client Grok Account");
}

#[tokio::test]
async fn test_end_to_end_role_selection_client_receives() {
    // Host has account, Client is empty. Client connects and chooses "receive".
    let dir_host = tempfile::tempdir().unwrap();
    let state_host = Arc::new(AppState::new(dir_host.path().to_path_buf(), "tok-h2".into()).unwrap());

    let account = Account {
        id: "host-acc-1".into(),
        label: "Host Claude Account".into(),
        provider: Provider::Anthropic,
        email: Some("claude@example.com".into()),
        provider_account_id: None,
        chatgpt_account_id: None,
        plan: Some("Pro".into()),
        created_at: Utc::now().to_rfc3339(),
        updated_at: Utc::now().to_rfc3339(),
        last_usage: None,
        last_error: None,
        auth_required: false,
    };
    let secret = ProviderSecret::Anthropic(crate::model::OAuthSecret {
        access_token: "sk-ant-123".into(),
        refresh_token: "sk-ant-ref".into(),
        id_token: None,
        expires_at: 0,
    });
    state_host.persist_connected_account(account, &secret).await.unwrap();

    let dir_client = tempfile::tempdir().unwrap();
    let state_client = Arc::new(AppState::new(dir_client.path().to_path_buf(), "tok-c2".into()).unwrap());

    let host_keypair = EphemeralKeyPair::generate();
    let session_id = Uuid::new_v4();
    let host_nonce = vec![33u8; 16];
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();

    let qr_uri = generate_qr_uri(
        "127.0.0.1",
        port,
        &host_keypair.public_bytes(),
        session_id,
        &host_nonce,
    );

    let (host_status_tx, mut host_status_rx) = mpsc::channel(16);
    let (host_confirm_tx, host_confirm_rx) = oneshot::channel();
    let (_host_cancel_tx, host_cancel_rx) = oneshot::channel();
    let parsed_qr = parse_qr_uri(&qr_uri).unwrap();
    let fp = parsed_qr.fingerprint.clone();

    tokio::spawn(run_host_listener(
        state_host.clone(),
        session_id,
        listener,
        host_keypair,
        host_nonce,
        fp,
        host_status_tx,
        host_confirm_rx,
        host_cancel_rx,
    ));

    let (client_status_tx, mut client_status_rx) = mpsc::channel(16);
    let (role_select_tx, role_select_rx) = oneshot::channel();
    let (client_confirm_tx, client_confirm_rx) = oneshot::channel();
    let (_client_cancel_tx, client_cancel_rx) = oneshot::channel();

    tokio::spawn(run_client_connector(
        state_client.clone(),
        parsed_qr,
        client_status_tx,
        role_select_rx,
        client_confirm_rx,
        client_cancel_rx,
    ));

    // Client selects "receive"
    role_select_tx.send("receive".to_string()).unwrap();

    // Verify host role resolves to sender
    let mut host_sas = String::new();
    while let Some(ev) = host_status_rx.recv().await {
        if let HostEvent::SasVerification { sas_code, role, account_count, .. } = ev {
            assert_eq!(role, "sender");
            assert_eq!(account_count, 1);
            host_sas = sas_code;
            break;
        }
    }

    // Verify client role resolves to receiver
    let mut client_sas = String::new();
    while let Some(ev) = client_status_rx.recv().await {
        if let ClientEvent::SasVerification { sas_code, role, account_count, .. } = ev {
            assert_eq!(role, "receiver");
            assert_eq!(account_count, 1);
            client_sas = sas_code;
            break;
        }
    }

    assert_eq!(host_sas, client_sas);

    // Both confirm
    host_confirm_tx.send(true).unwrap();
    client_confirm_tx.send(true).unwrap();

    // Verify client received and imported account
    while let Some(ev) = client_status_rx.recv().await {
        if let ClientEvent::Completed(summary) = ev {
            assert_eq!(summary.added, 1);
            break;
        }
    }

    let client_accounts = state_client.store.list();
    assert_eq!(client_accounts.len(), 1);
    assert_eq!(client_accounts[0].label, "Host Claude Account");
}

#[tokio::test]
async fn test_end_to_end_sas_rejection_aborts() {
    let dir_host = tempfile::tempdir().unwrap();
    let state_host = Arc::new(AppState::new(dir_host.path().to_path_buf(), "tok-h3".into()).unwrap());
    let dir_client = tempfile::tempdir().unwrap();
    let state_client = Arc::new(AppState::new(dir_client.path().to_path_buf(), "tok-c3".into()).unwrap());

    let host_keypair = EphemeralKeyPair::generate();
    let session_id = Uuid::new_v4();
    let host_nonce = vec![44u8; 16];
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();

    let qr_uri = generate_qr_uri(
        "127.0.0.1",
        port,
        &host_keypair.public_bytes(),
        session_id,
        &host_nonce,
    );

    let (host_status_tx, mut host_status_rx) = mpsc::channel(16);
    let (host_confirm_tx, host_confirm_rx) = oneshot::channel();
    let (_host_cancel_tx, host_cancel_rx) = oneshot::channel();
    let parsed_qr = parse_qr_uri(&qr_uri).unwrap();
    let fp = parsed_qr.fingerprint.clone();

    tokio::spawn(run_host_listener(
        state_host.clone(),
        session_id,
        listener,
        host_keypair,
        host_nonce,
        fp,
        host_status_tx,
        host_confirm_rx,
        host_cancel_rx,
    ));

    let (client_status_tx, mut client_status_rx) = mpsc::channel(16);
    let (role_select_tx, role_select_rx) = oneshot::channel();
    let (_client_confirm_tx, client_confirm_rx) = oneshot::channel();
    let (_client_cancel_tx, client_cancel_rx) = oneshot::channel();

    tokio::spawn(run_client_connector(
        state_client.clone(),
        parsed_qr,
        client_status_tx,
        role_select_rx,
        client_confirm_rx,
        client_cancel_rx,
    ));

    role_select_tx.send("receive".to_string()).unwrap();

    // Wait until verification
    while let Some(ev) = host_status_rx.recv().await {
        if let HostEvent::SasVerification { .. } = ev {
            break;
        }
    }

    // Host user rejects code
    host_confirm_tx.send(false).unwrap();

    // Both should terminate with Failed
    let mut host_failed = false;
    while let Some(ev) = host_status_rx.recv().await {
        if let HostEvent::Failed(_) = ev {
            host_failed = true;
            break;
        }
    }
    assert!(host_failed);

    let mut client_failed = false;
    while let Some(ev) = client_status_rx.recv().await {
        if let ClientEvent::Failed(_) = ev {
            client_failed = true;
            break;
        }
    }
    assert!(client_failed);
}

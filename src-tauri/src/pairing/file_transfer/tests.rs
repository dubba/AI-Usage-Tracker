use super::*;
use crate::model::{Account, OAuthSecret, Provider, ProviderSecret};
use tempfile::TempDir;

const CODE: &str = "482913";
const ACCESS_TOKEN: &str = "file-transfer-access-token";

fn new_state() -> (TempDir, Arc<AppState>) {
    let dir = TempDir::new().unwrap();
    let state = Arc::new(AppState::new(dir.path().to_path_buf(), "token".into()).unwrap());
    (dir, state)
}

async fn add_account(state: &AppState, id: &str) {
    state
        .persist_connected_account(
            Account {
                id: id.into(),
                label: "Claude".into(),
                provider: Provider::Anthropic,
                email: Some(format!("{id}@example.com")),
                created_at: chrono::Utc::now().to_rfc3339(),
                updated_at: chrono::Utc::now().to_rfc3339(),
                ..Account::for_test()
            },
            &ProviderSecret::Anthropic(OAuthSecret {
                access_token: ACCESS_TOKEN.into(),
                refresh_token: "refresh".into(),
                id_token: None,
                expires_at: 0,
            }),
        )
        .await
        .unwrap();
}

/// A sender with one account, showing `CODE`.
async fn sender() -> (TempDir, Arc<AppState>) {
    let (dir, state) = new_state();
    add_account(&state, "acc-file").await;
    state.pairing.testing_show_code(CODE).await;
    (dir, state)
}

/// The sender opens `request` and its user agrees to answer it.
async fn answer(sender: &AppState, request: &[u8]) -> Result<Vec<u8>, String> {
    open_request(sender, request.to_vec()).await?;
    answer_request(sender).await
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack
        .windows(needle.len())
        .any(|window| window == needle)
}

#[tokio::test]
async fn a_request_and_its_reply_move_the_accounts() {
    let (_s, sender) = sender().await;
    let (_r, receiver) = new_state();

    let request = create_request(&receiver, CODE).unwrap();
    assert_eq!(request.len(), REQUEST_LEN);
    assert!(
        !contains(&request, CODE.as_bytes()),
        "the code is never in a file"
    );

    let reply = answer(&sender, &request).await.unwrap();
    assert!(
        !contains(&reply, ACCESS_TOKEN.as_bytes()),
        "the reply is encrypted"
    );
    assert!(!contains(&reply, CODE.as_bytes()));

    let preview = preview_reply(&receiver, reply.clone()).unwrap();
    assert_eq!(preview.account_count, 1);
    assert!(
        receiver.store.list().is_empty(),
        "a preview imports nothing"
    );

    let summary = import_reply(&receiver, &preview.ticket, false)
        .await
        .unwrap();
    assert_eq!(summary.added, 1);
    assert_eq!(receiver.store.list()[0].id, "acc-file");
    assert!(
        receiver.pairing_file_receiver.lock().is_none(),
        "the transfer is over"
    );
}

#[tokio::test]
async fn a_reply_for_a_different_code_does_not_open_and_ends_the_request() {
    let (_s, sender) = sender().await;
    let (_r, receiver) = new_state();

    let request = create_request(&receiver, "913482").unwrap();
    let reply = answer(&sender, &request).await.unwrap();
    assert_eq!(
        preview_reply(&receiver, reply.clone()).unwrap_err(),
        REPLY_DOES_NOT_OPEN
    );
    // One guess: the request is gone, so the same reply cannot be tried again.
    assert_eq!(
        preview_reply(&receiver, reply.clone()).unwrap_err(),
        NO_REQUEST_OUT
    );
    assert!(receiver.store.list().is_empty());
}

#[tokio::test]
async fn a_code_answers_one_request() {
    let (_s, sender) = sender().await;
    let (_r, receiver) = new_state();
    let request = create_request(&receiver, CODE).unwrap();
    answer(&sender, &request).await.unwrap();
    assert_eq!(
        answer(&sender, &request).await.unwrap_err(),
        CODE_ALREADY_USED
    );
    let another = create_request(&receiver, CODE).unwrap();
    assert_eq!(
        answer(&sender, &another).await.unwrap_err(),
        CODE_ALREADY_USED
    );
}

#[tokio::test]
async fn only_a_device_showing_a_code_answers() {
    let (_s, sender) = new_state();
    add_account(&sender, "acc-file").await;
    let (_r, receiver) = new_state();
    let request = create_request(&receiver, CODE).unwrap();
    assert_eq!(answer(&sender, &request).await.unwrap_err(), NO_CODE_SHOWN);

    // A joining session has no code to answer with.
    sender.pairing.testing_open_session("joiner").await;
    assert_eq!(answer(&sender, &request).await.unwrap_err(), NO_CODE_SHOWN);
}

/// The sender answers only the request its user opened and agreed to, once.
#[tokio::test]
async fn the_sender_answers_the_request_it_opened() {
    let (_s, sender) = sender().await;
    let (_r, receiver) = new_state();
    assert_eq!(
        answer_request(&sender).await.unwrap_err(),
        NO_REQUEST_OPENED
    );

    let request = create_request(&receiver, CODE).unwrap();
    assert!(open_request(&sender, b"not a request".to_vec())
        .await
        .is_err());
    let info = open_request(&sender, request.clone()).await.unwrap();
    assert_eq!(info.account_count, 1);
    answer_request(&sender).await.unwrap();
    // The code is used: neither the same request nor a new one is answered.
    assert_eq!(
        open_request(&sender, request).await.unwrap_err(),
        CODE_ALREADY_USED
    );
    assert_eq!(
        answer_request(&sender).await.unwrap_err(),
        CODE_ALREADY_USED
    );
}

#[tokio::test]
async fn a_reply_to_an_older_request_is_refused_and_the_newer_one_still_waits() {
    let (_s, sender) = sender().await;
    let (_r, receiver) = new_state();

    let older = create_request(&receiver, CODE).unwrap();
    let reply_to_older = answer(&sender, &older).await.unwrap();
    let newer = create_request(&receiver, CODE).unwrap();
    assert_eq!(
        preview_reply(&receiver, reply_to_older.clone()).unwrap_err(),
        REPLY_FOR_ANOTHER_REQUEST
    );

    sender.pairing.testing_show_code(CODE).await;
    let reply = answer(&sender, &newer).await.unwrap();
    assert_eq!(
        preview_reply(&receiver, reply.clone())
            .unwrap()
            .account_count,
        1
    );
}

/// Opening a reply uses up its request, so each altered copy gets a fresh request and answer.
#[tokio::test]
async fn any_changed_byte_in_a_reply_stops_it_opening() {
    let (_s, sender) = sender().await;
    // The sender nonce, the host's key exchange message, the account count, and the ciphertext.
    let positions = [
        HEADER_LEN + NONCE_LEN,
        HEADER_LEN + 2 * NONCE_LEN + 1,
        REPLY_FIXED_LEN - 1,
        REPLY_FIXED_LEN + 30,
    ];
    for at in positions {
        let (_r, receiver) = new_state();
        let request = create_request(&receiver, CODE).unwrap();
        sender.pairing.testing_show_code(CODE).await;
        let mut reply = answer(&sender, &request).await.unwrap();
        reply[at] ^= 0x01;
        assert_eq!(
            preview_reply(&receiver, reply.clone()).unwrap_err(),
            REPLY_DOES_NOT_OPEN,
            "byte {at}"
        );
        assert!(receiver.store.list().is_empty());
    }
}

#[tokio::test]
async fn a_reply_with_more_accounts_than_it_states_is_refused() {
    let (_s, sender) = new_state();
    add_account(&sender, "acc-one").await;
    add_account(&sender, "acc-two").await;
    let payload = create_export_payload(&sender).unwrap();
    let (_r, receiver) = new_state();
    let request = create_request(&receiver, CODE).unwrap();
    // A sender that says one account but sends two.
    let reply = build_reply(CODE, &request, &payload, 1).unwrap();
    assert_eq!(
        preview_reply(&receiver, reply.clone()).unwrap_err(),
        MORE_ACCOUNTS_THAN_SHOWN
    );
}

#[tokio::test]
async fn an_import_needs_the_ticket_of_the_same_reply_once() {
    let (_s, sender) = sender().await;
    let (_r, receiver) = new_state();
    let request = create_request(&receiver, CODE).unwrap();
    let reply = answer(&sender, &request).await.unwrap();
    let preview = preview_reply(&receiver, reply.clone()).unwrap();

    assert_eq!(
        import_reply(&receiver, "not-the-ticket", false)
            .await
            .unwrap_err(),
        STALE_PREVIEW
    );
    // The failed try used the ticket up.
    assert_eq!(
        import_reply(&receiver, &preview.ticket, false)
            .await
            .unwrap_err(),
        STALE_PREVIEW
    );
    assert!(receiver.store.list().is_empty());
}

#[tokio::test]
async fn opening_the_same_reply_again_withdraws_the_first_ticket() {
    let (_s, sender) = sender().await;
    let (_r, receiver) = new_state();
    let request = create_request(&receiver, CODE).unwrap();
    let reply = answer(&sender, &request).await.unwrap();
    let first = preview_reply(&receiver, reply.clone()).unwrap();
    let second = preview_reply(&receiver, reply.clone()).unwrap();
    assert_eq!(second.account_count, 1);
    assert_ne!(first.ticket, second.ticket);

    // Another file leaves the opened reply alone.
    let mut other = reply.clone();
    let last = other.len() - 1;
    other[last] ^= 0x01;
    assert_eq!(
        preview_reply(&receiver, other.clone()).unwrap_err(),
        REPLY_FOR_ANOTHER_REQUEST
    );

    assert_eq!(
        import_reply(&receiver, &first.ticket, false)
            .await
            .unwrap_err(),
        STALE_PREVIEW
    );
    // The stale try used up the opened reply too.
    assert!(receiver.pairing_file_receiver.lock().is_none());
}

#[tokio::test]
async fn an_old_request_expires() {
    let (_s, sender) = sender().await;
    let (_r, receiver) = new_state();
    let request = create_request(&receiver, CODE).unwrap();
    let reply = answer(&sender, &request).await.unwrap();
    if let Some(ReceiverState::Waiting(pending)) = receiver.pairing_file_receiver.lock().as_mut() {
        let Some(past) = Instant::now().checked_sub(REQUEST_LIFETIME + Duration::from_secs(1))
        else {
            return; // The clock started less than ten minutes ago; nothing to test here.
        };
        pending.made_at = past;
    }
    assert_eq!(
        preview_reply(&receiver, reply.clone()).unwrap_err(),
        REQUEST_EXPIRED
    );
}

#[test]
fn files_are_told_apart_before_anything_is_used() {
    let (pending, request) = build_request(CODE).unwrap();
    drop(pending);
    assert!(check_request(&request).is_ok());

    let mut reply_header = request.clone();
    reply_header[MAGIC.len() + 1] = KIND_REPLY;
    assert_eq!(check_request(&reply_header).unwrap_err(), NOT_A_REQUEST);
    assert_eq!(parse_reply(&request).err().unwrap(), NOT_A_REPLY);

    let mut newer = request.clone();
    newer[MAGIC.len()] = FORMAT_VERSION + 1;
    assert_eq!(check_request(&newer).unwrap_err(), NEWER_FORMAT);

    for garbage in [
        &b""[..],
        b"AIUTPAI",
        b"not a pairing file at all",
        &request[..REQUEST_LEN - 1],
    ] {
        assert_eq!(check_request(garbage).unwrap_err(), NOT_A_PAIRING_FILE);
    }
    let mut longer = request.clone();
    longer.push(0);
    assert_eq!(check_request(&longer).unwrap_err(), NOT_A_PAIRING_FILE);

    let mut too_short = header(KIND_REPLY).to_vec();
    too_short.resize(REPLY_FIXED_LEN + CIPHERTEXT_OVERHEAD - 1, 0);
    assert_eq!(parse_reply(&too_short).err().unwrap(), NOT_A_PAIRING_FILE);
    let mut too_long = header(KIND_REPLY).to_vec();
    too_long.resize(MAX_REPLY_LEN + 1, 0);
    assert_eq!(parse_reply(&too_long).err().unwrap(), NOT_A_PAIRING_FILE);
}

#[test]
fn a_request_needs_a_six_digit_code() {
    for code in ["", "12345", "1234567", "12a456"] {
        assert_eq!(build_request(code).err().unwrap(), INVALID_CODE, "{code:?}");
    }
    assert!(build_request(" 482913 ").is_ok());
}

#[test]
fn a_request_with_a_malformed_key_exchange_gets_no_reply() {
    let (pending, mut request) = build_request(CODE).unwrap();
    drop(pending);
    for byte in &mut request[HEADER_LEN + NONCE_LEN..] {
        *byte = 0xff;
    }
    let payload = br#"{"format":"x"}"#;
    assert_eq!(
        build_reply(CODE, &request, payload, 0).unwrap_err(),
        NOT_A_PAIRING_FILE
    );
}

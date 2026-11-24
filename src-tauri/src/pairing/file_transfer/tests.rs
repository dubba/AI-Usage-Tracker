use super::*;
use crate::model::{Account, OAuthSecret, Provider, ProviderSecret};
use crate::pairing::PairingStatus;
use tempfile::TempDir;

const CODE: &str = "KTQMPRXDHW";
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

/// A sender with one account.
async fn sender() -> (TempDir, Arc<AppState>) {
    let (dir, state) = new_state();
    add_account(&state, "acc-file").await;
    (dir, state)
}

/// A receiver showing `code`.
async fn receiver(code: &str) -> (TempDir, Arc<AppState>) {
    let (dir, state) = new_state();
    state.pairing.testing_show_code(code).await;
    (dir, state)
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack
        .windows(needle.len())
        .any(|window| window == needle)
}

#[tokio::test]
async fn one_file_moves_the_accounts() {
    let (_s, sender) = sender().await;
    let (_r, receiver) = receiver(CODE).await;

    let file = seal(&sender, CODE).await.unwrap();
    assert!(
        !contains(&file, ACCESS_TOKEN.as_bytes()),
        "the file is encrypted"
    );
    assert!(
        !contains(&file, CODE.as_bytes()),
        "the code is never in the file"
    );

    let preview = open(&receiver, file).await.unwrap();
    assert_eq!(preview.account_count, 1);
    assert!(receiver.store.list().is_empty(), "opening imports nothing");

    let summary = import(&receiver, &preview.ticket, false).await.unwrap();
    assert_eq!(summary.added, 1);
    assert_eq!(receiver.store.list()[0].id, "acc-file");
    assert!(
        receiver.pairing_file_received.lock().is_none(),
        "the transfer is over"
    );
}

#[tokio::test]
async fn the_code_may_be_typed_in_lower_case_with_spaces_or_a_dash() {
    let (_s, sender) = sender().await;
    let (_r, receiver) = receiver(CODE).await;
    let file = seal(&sender, " ktqmp-rxdhw ").await.unwrap();
    assert_eq!(open(&receiver, file).await.unwrap().account_count, 1);
}

#[tokio::test]
async fn a_file_that_opens_uses_the_code_up_and_ends_the_wifi_session() {
    let (_s, sender) = sender().await;
    let (_r, receiver) = receiver(CODE).await;
    let file = seal(&sender, CODE).await.unwrap();
    open(&receiver, file.clone()).await.unwrap();
    assert!(matches!(
        receiver.pairing.get_status().await,
        PairingStatus::Idle
    ));
    // The same file again, or another one: the code no longer opens anything.
    assert_eq!(open(&receiver, file).await.unwrap_err(), NO_CODE_SHOWN);
}

#[tokio::test]
async fn a_file_for_another_code_does_not_open_and_the_code_still_works() {
    let (_s, sender) = sender().await;
    let (_r, receiver) = receiver(CODE).await;
    let typo = seal(&sender, "KTQMPRXDHX").await.unwrap();
    assert_eq!(open(&receiver, typo).await.unwrap_err(), FILE_DOES_NOT_OPEN);
    assert!(receiver.store.list().is_empty());
    assert!(matches!(
        receiver.pairing.get_status().await,
        PairingStatus::HostWaiting { .. }
    ));
    let corrected = seal(&sender, CODE).await.unwrap();
    assert_eq!(open(&receiver, corrected).await.unwrap().account_count, 1);
}

#[tokio::test]
async fn only_a_device_showing_a_link_code_opens_a_file() {
    let (_s, sender) = sender().await;
    let file = seal(&sender, CODE).await.unwrap();

    let (_r, nothing_shown) = new_state();
    assert_eq!(
        open(&nothing_shown, file.clone()).await.unwrap_err(),
        NO_CODE_SHOWN
    );

    let (_l, legacy) = receiver("482019").await;
    assert_eq!(open(&legacy, file).await.unwrap_err(), WIFI_ONLY_CODE);
}

#[tokio::test]
async fn a_six_digit_code_or_a_mistyped_one_makes_no_file() {
    let (_s, sender) = sender().await;
    assert_eq!(seal(&sender, "482019").await.unwrap_err(), WIFI_ONLY_CODE);
    for code in ["", "KTQMPRXDH", "KTQMPRXDHWA", "KTQMPRXDHO", "KTQMP1XDHW"] {
        assert_eq!(
            seal(&sender, code).await.unwrap_err(),
            INVALID_CODE,
            "{code}"
        );
    }
}

#[tokio::test]
async fn sending_uses_this_transfers_extras_up() {
    let (_s, sender) = sender().await;
    {
        let mut options = sender.pairing_options.write();
        options.include_settings = true;
        options.pending_ui_state = Some(serde_json::json!({}));
    }
    seal(&sender, CODE).await.unwrap();
    let options = sender.pairing_options.read();
    assert!(!options.include_settings);
    assert!(options.pending_ui_state.is_none());
}

#[tokio::test]
async fn any_changed_byte_stops_the_file_opening() {
    let (_s, sender) = sender().await;
    let file = seal(&sender, CODE).await.unwrap();
    // The salt, the account count, and the ciphertext.
    for at in [HEADER_LEN, FIXED_LEN - 1, FIXED_LEN + 30, file.len() - 1] {
        let (_r, receiver) = receiver(CODE).await;
        let mut changed = file.clone();
        changed[at] ^= 0x01;
        assert_eq!(
            open(&receiver, changed).await.unwrap_err(),
            FILE_DOES_NOT_OPEN,
            "byte {at}"
        );
        assert!(receiver.store.list().is_empty());
    }
}

#[tokio::test]
async fn a_file_with_more_accounts_than_it_states_is_refused() {
    let (_s, sender) = new_state();
    add_account(&sender, "acc-one").await;
    add_account(&sender, "acc-two").await;
    let payload = create_export_payload(&sender).unwrap();
    // A sender that says one account but sends two.
    let file = build(CODE, &payload, 1).unwrap();
    let (_r, receiver) = receiver(CODE).await;
    assert_eq!(
        open(&receiver, file).await.unwrap_err(),
        MORE_ACCOUNTS_THAN_SHOWN
    );
}

#[tokio::test]
async fn an_import_needs_the_ticket_once() {
    let (_s, sender) = sender().await;
    let (_r, receiver) = receiver(CODE).await;
    let file = seal(&sender, CODE).await.unwrap();
    let preview = open(&receiver, file).await.unwrap();

    assert_eq!(
        import(&receiver, "not-the-ticket", false)
            .await
            .unwrap_err(),
        STALE_PREVIEW
    );
    // The failed try used the ticket up.
    assert_eq!(
        import(&receiver, &preview.ticket, false).await.unwrap_err(),
        STALE_PREVIEW
    );
    assert!(receiver.store.list().is_empty());
}

#[test]
fn other_files_are_told_apart_before_any_key_is_derived() {
    assert_eq!(check(b"").unwrap_err(), NOT_A_PAIRING_FILE);
    assert_eq!(check(b"PK\x03\x04 a zip").unwrap_err(), NOT_A_PAIRING_FILE);
    let mut file = build(CODE, br#"{"accounts":[]}"#, 0).unwrap();
    assert!(check(&file).is_ok());

    file[MAGIC.len()] = FORMAT_VERSION - 1;
    assert_eq!(check(&file).unwrap_err(), OLDER_FORMAT);
    file[MAGIC.len()] = FORMAT_VERSION + 1;
    assert_eq!(check(&file).unwrap_err(), NEWER_FORMAT);
    file[MAGIC.len()] = FORMAT_VERSION;

    file[MAGIC.len() + 1] = KIND_ACCOUNTS + 1;
    assert_eq!(check(&file).unwrap_err(), NOT_A_PAIRING_FILE);
    file[MAGIC.len() + 1] = KIND_ACCOUNTS;

    assert_eq!(
        check(&file[..FIXED_LEN + CIPHERTEXT_OVERHEAD - 1]).unwrap_err(),
        NOT_A_PAIRING_FILE
    );
    let mut too_long = file.clone();
    too_long.resize(MAX_FILE_LEN + 1, 0);
    assert_eq!(check(&too_long).unwrap_err(), NOT_A_PAIRING_FILE);
}

#[test]
fn each_file_has_its_own_salt() {
    let payload = br#"{"accounts":[]}"#;
    let first = build(CODE, payload, 0).unwrap();
    let second = build(CODE, payload, 0).unwrap();
    assert_ne!(
        first[HEADER_LEN..HEADER_LEN + SALT_LEN],
        second[HEADER_LEN..HEADER_LEN + SALT_LEN]
    );
}

/// The release cost of one try at a code (the tests run a token one).
#[test]
fn a_try_at_a_code_costs_64_mib_and_three_passes() {
    let source = include_str!("../file_transfer.rs");
    assert!(source.contains("const ARGON2_MEMORY_KIB: u32 = 64 * 1024;"));
    assert!(source.contains("const ARGON2_PASSES: u32 = 3;"));
}

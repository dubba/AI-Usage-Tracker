use super::*;
use crate::store::credentials::keyring_store::{account_credential_user, credential_chunk_user};

const GENERATION: &str = "A1b2C3d4E5f6G7h8";

fn app_target(target: &str) -> bool {
    is_app_credential_target(target, &SERVICES)
}

/// The names the store writes are the names the uninstall removes.
#[test]
fn every_name_the_store_writes_is_removed() {
    for service in SERVICES {
        let account = account_credential_user("acc-1");
        assert!(app_target(&format!("{account}.{service}")), "{account}");
        for index in [0, 5, MAX_CREDENTIAL_CHUNKS - 1] {
            let chunk = credential_chunk_user("uuid_1234-abcd", GENERATION, index);
            assert!(app_target(&format!("{chunk}.{service}")), "{chunk}");
        }
        assert!(app_target(&format!("{BRIDGE_TOKEN_USER}.{service}")));
    }
    let past_the_last_chunk = credential_chunk_user("acc-1", GENERATION, MAX_CREDENTIAL_CHUNKS);
    assert!(!app_target(&format!(
        "{past_the_last_chunk}.{CREDENTIAL_SERVICE}"
    )));
}

#[test]
fn names_of_other_apps_and_malformed_names_are_left_alone() {
    for target in [
        // Other services.
        "account:acc-1.other-service",
        "bridge-api-token.discord",
        "account:acc-1.ai-usage-tracker-extra",
        "account:acc-1ai-usage-tracker",
        // Chunk index out of range or not a number.
        "account:acc-1:chunk:A1b2C3d4E5f6G7h8:32.ai-usage-tracker",
        "account:acc-1:chunk:A1b2C3d4E5f6G7h8:-1.ai-usage-tracker",
        "account:acc-1:chunk:A1b2C3d4E5f6G7h8:abc.ai-usage-tracker",
        "account:acc-1:chunk:A1b2C3d4E5f6G7h8:007.ai-usage-tracker",
        "account:acc-1:chunk:A1b2C3d4E5f6G7h8:.ai-usage-tracker",
        // The generation is 16 letters and digits.
        "account:acc-1:chunk:tooshort:0.ai-usage-tracker",
        "account:acc-1:chunk:A1b2C3d4E5f6G7h8extra:0.ai-usage-tracker",
        "account:acc-1:chunk:A1b2C3d4E5f6G7h_:0.ai-usage-tracker",
        // Account ids.
        "account:../traversal.ai-usage-tracker",
        "account:has spaces.ai-usage-tracker",
        "account:.ai-usage-tracker",
        "account:a.b.ai-usage-tracker",
        // Other users.
        "bridge-api-token-2.ai-usage-tracker",
        "accounts:acc-1.ai-usage-tracker",
        // Whitespace, NUL and slashes anywhere.
        " account:acc-1.ai-usage-tracker",
        "account:acc-1.ai-usage-tracker\0",
        "account:acc-1/extra.ai-usage-tracker",
        "account:acc-1\\extra.ai-usage-tracker",
        "",
    ] {
        assert!(!app_target(target), "{target:?}");
    }
    let too_long = format!("account:{}.ai-usage-tracker", "a".repeat(250));
    assert!(!app_target(&too_long));
}

/// `windows/uninstall-rules.json` gives the PowerShell fallback these rules (and the macOS
/// uninstall script its profile rules), so it must say what this module does.
#[test]
fn the_fallback_script_rules_match() {
    let manifest = env!("CARGO_MANIFEST_DIR");
    let rules: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(format!("{manifest}/windows/uninstall-rules.json")).unwrap(),
    )
    .unwrap();
    let conf: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(format!("{manifest}/tauri.conf.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(rules["bundleId"], conf["identifier"]);
    assert_eq!(rules["bundleId"], crate::uninstall::BUNDLE_ID);
    assert_eq!(rules["credentialServices"], serde_json::json!(SERVICES));
    assert_eq!(rules["bridgeTokenUser"], BRIDGE_TOKEN_USER);
    assert_eq!(rules["accountUserPrefix"], ACCOUNT_USER_PREFIX);
    assert_eq!(rules["chunkMarker"], CHUNK_MARKER);
    assert_eq!(
        rules["accountIdPattern"],
        format!("^[A-Za-z0-9_-]{{1,{MAX_ACCOUNT_ID_CHARS}}}$")
    );
    assert_eq!(
        rules["generationPattern"],
        format!("^[A-Za-z0-9]{{{CREDENTIAL_GENERATION_LENGTH}}}$")
    );
    assert_eq!(rules["maxChunkIndex"], MAX_CREDENTIAL_CHUNKS - 1);
    assert_eq!(rules["maxTargetLength"], MAX_TARGET_CHARS);
}

/// Against the real Credential Manager, under a service only this test uses, so no saved
/// sign-in of the app is touched. Also pins keyring's `{user}.{service}` naming.
#[cfg(windows)]
#[test]
fn removes_the_app_credentials_from_credential_manager_and_nothing_else() {
    use keyring::Entry;
    let service = format!("aiut-uninstall-test-{}", std::process::id());
    let other = format!("{service}-other");
    let account = Entry::new(&service, "account:acc-1").unwrap();
    let chunk = Entry::new(&service, &credential_chunk_user("acc-1", GENERATION, 3)).unwrap();
    let not_ours = Entry::new(&service, "someone-else").unwrap();
    let other_service = Entry::new(&other, "account:acc-1").unwrap();
    for entry in [&account, &chunk, &not_ours, &other_service] {
        entry.set_password("secret").unwrap();
    }

    let targets = windows::generic_credential_targets().unwrap();
    assert!(targets.contains(&format!("account:acc-1.{service}")));

    assert!(remove_app_credentials(&[service.as_str()]));
    assert!(matches!(
        account.get_password(),
        Err(keyring::Error::NoEntry)
    ));
    assert!(matches!(chunk.get_password(), Err(keyring::Error::NoEntry)));
    assert_eq!(not_ours.get_password().unwrap(), "secret");
    assert_eq!(other_service.get_password().unwrap(), "secret");
    // Nothing left to remove counts as removed.
    assert!(remove_app_credentials(&[service.as_str()]));

    not_ours.delete_credential().unwrap();
    other_service.delete_credential().unwrap();
}

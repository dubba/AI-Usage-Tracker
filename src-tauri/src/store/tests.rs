use super::accounts::{write_account_file, AccountFile, AccountStore, MAX_TOMBSTONES};
use super::credentials::cache::{
    cached_secret, forget_secret, remember_secret, remember_secret_with_state, SECRET_CACHE,
    SECRET_CACHE_TTL,
};
use super::credentials::chunking::{
    decode_provider_secret, parse_credential_manifest, split_utf16_chunks,
    CREDENTIAL_CHUNK_UTF16_UNITS,
};
use super::credentials::{
    delete_secret, load_provider_secret, save_provider_secret, save_provider_secret_with,
};
use super::*;
use crate::model::now_rfc3339;
use crate::model::{Account, OAuthSecret, Provider, ProviderSecret, UsageSnapshot};
use std::{
    fs,
    time::{Duration, Instant},
};
use tempfile::tempdir;

const WINDOWS_CREDENTIAL_BLOB_LIMIT_BYTES: usize = 2560;

#[test]
fn metadata_round_trip() {
    let dir = tempdir().unwrap();
    let store = AccountStore::load(dir.path().to_path_buf()).unwrap();
    let now = now_rfc3339();
    store
        .upsert(Account {
            id: "one".into(),
            label: "Main".into(),
            provider: Provider::Openai,
            email: Some("main@example.com".into()),
            provider_account_id: Some("account-1".into()),
            chatgpt_account_id: Some("account-1".into()),
            plan: Some("plus".into()),
            created_at: now.clone(),
            updated_at: now,
            last_usage: None,
            last_error: None,
            auth_required: false,
        })
        .unwrap();
    let reopened = AccountStore::load(dir.path().to_path_buf()).unwrap();
    assert_eq!(reopened.list().len(), 1);
    assert_eq!(reopened.list()[0].label, "Main");
    assert_eq!(reopened.list()[0].provider, Provider::Openai);
}

#[cfg(unix)]
#[test]
fn account_metadata_files_are_owner_only() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempdir().unwrap();
    let store = AccountStore::load(dir.path().to_path_buf()).unwrap();
    store.upsert(sample_account("one", "Main")).unwrap();
    store
        .mutate("one", |account| account.label = "Renamed".into())
        .unwrap();
    for name in ["accounts.json", "accounts.json.bak"] {
        let path = dir.path().join(name);
        let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "{name} should be owner-only");
    }
}

#[test]
fn backup_holds_the_previous_version_and_identical_writes_are_skipped() {
    let dir = tempdir().unwrap();
    let store = AccountStore::load(dir.path().to_path_buf()).unwrap();
    store.upsert(sample_account("one", "First")).unwrap();
    let after_first = fs::read(dir.path().join("accounts.json")).unwrap();

    store
        .mutate("one", |account| account.label = "Second".into())
        .unwrap();
    let after_second = fs::read(dir.path().join("accounts.json")).unwrap();
    assert_ne!(after_first, after_second);
    // The backup is the version before the latest write.
    assert_eq!(
        fs::read(dir.path().join("accounts.json.bak")).unwrap(),
        after_first
    );

    // Re-writing identical contents must not touch the backup.
    let accounts = store.list();
    write_account_file(dir.path(), &accounts).unwrap();
    assert_eq!(
        fs::read(dir.path().join("accounts.json")).unwrap(),
        after_second
    );
    assert_eq!(
        fs::read(dir.path().join("accounts.json.bak")).unwrap(),
        after_first
    );
    assert!(!dir.path().join("accounts.json.bak.tmp").exists());
}

#[test]
fn concurrent_updates_leave_the_latest_state_on_disk() {
    let dir = tempdir().unwrap();
    let store = std::sync::Arc::new(AccountStore::load(dir.path().to_path_buf()).unwrap());
    for index in 0..4 {
        store
            .upsert(sample_account(&format!("acc-{index}"), "Start"))
            .unwrap();
    }
    let handles: Vec<_> = (0..8)
        .map(|worker| {
            let store = store.clone();
            std::thread::spawn(move || {
                for round in 0..20 {
                    let id = format!("acc-{}", (worker + round) % 4);
                    store
                        .mutate(&id, |account| {
                            account.label = format!("w{worker}-r{round}");
                        })
                        .unwrap();
                }
            })
        })
        .collect();
    for handle in handles {
        handle.join().unwrap();
    }

    // Whatever interleaving happened, disk must match memory.
    let mut in_memory: Vec<_> = store
        .list()
        .into_iter()
        .map(|account| (account.id, account.label))
        .collect();
    let reopened = AccountStore::load(dir.path().to_path_buf()).unwrap();
    let mut on_disk: Vec<_> = reopened
        .list()
        .into_iter()
        .map(|account| (account.id, account.label))
        .collect();
    in_memory.sort();
    on_disk.sort();
    assert_eq!(in_memory, on_disk);
}

#[test]
fn a_failed_write_is_retried_by_the_next_change() {
    let dir = tempdir().unwrap();
    let store = AccountStore::load(dir.path().to_path_buf()).unwrap();
    store.upsert(sample_account("one", "Start")).unwrap();

    // A directory where the file goes makes the replace fail.
    let path = dir.path().join("accounts.json");
    let saved = fs::read(&path).unwrap();
    fs::remove_file(&path).unwrap();
    fs::create_dir(&path).unwrap();
    assert!(store
        .mutate("one", |account| account.label = "Lost".into())
        .is_err());
    fs::remove_dir(&path).unwrap();
    fs::write(&path, saved).unwrap();

    // The next change writes everything, including the failed one.
    store
        .mutate("one", |account| {
            account.updated_at = "2026-01-01T00:00:00Z".into()
        })
        .unwrap();
    let reopened = AccountStore::load(dir.path().to_path_buf()).unwrap();
    assert_eq!(reopened.list()[0].label, "Lost");
}

#[test]
fn concurrent_tombstone_updates_are_not_lost() {
    let dir = tempdir().unwrap();
    let store = std::sync::Arc::new(AccountStore::load(dir.path().to_path_buf()).unwrap());
    let handles: Vec<_> = (0..16)
        .map(|worker| {
            let store = store.clone();
            std::thread::spawn(move || {
                for round in 0..10 {
                    store.merge_tombstones(&[format!("gone-{worker}-{round}")]);
                }
            })
        })
        .collect();
    for handle in handles {
        handle.join().unwrap();
    }
    assert_eq!(store.tombstones().len(), 160);

    // Clearing while others add must not resurrect or drop the rest.
    let clearer = {
        let store = store.clone();
        std::thread::spawn(move || {
            for worker in 0..16 {
                store.clear_tombstone(&format!("gone-{worker}-0"));
            }
        })
    };
    let adder = {
        let store = store.clone();
        std::thread::spawn(move || {
            for round in 0..20 {
                store.merge_tombstones(&[format!("late-{round}")]);
            }
        })
    };
    clearer.join().unwrap();
    adder.join().unwrap();
    let ids = store.tombstones();
    assert_eq!(ids.len(), 160 - 16 + 20);
    assert!(ids
        .iter()
        .all(|id| !id.ends_with("-0") || id.starts_with("late")));
}

#[test]
fn tombstone_list_is_capped_and_a_corrupt_file_is_rebuilt() {
    let dir = tempdir().unwrap();
    let store = AccountStore::load(dir.path().to_path_buf()).unwrap();
    let many: Vec<String> = (0..MAX_TOMBSTONES + 25)
        .map(|i| format!("id-{i}"))
        .collect();
    store.merge_tombstones(&many);
    let ids = store.tombstones();
    assert_eq!(ids.len(), MAX_TOMBSTONES);
    assert_eq!(ids[0], "id-25", "the oldest entries are dropped");

    fs::write(dir.path().join("deleted-accounts.json"), b"{not json").unwrap();
    assert!(store.tombstones().is_empty());
    store.merge_tombstones(&["fresh".to_string()]);
    assert_eq!(store.tombstones(), vec!["fresh".to_string()]);
}

#[test]
fn legacy_account_defaults_to_openai() {
    let raw = r#"{
      "version": 1,
      "accounts": [{
        "id": "legacy",
        "label": "Legacy",
        "email": null,
        "chatgptAccountId": "acct",
        "plan": "plus",
        "createdAt": "2026-01-01T00:00:00Z",
        "updatedAt": "2026-01-01T00:00:00Z",
        "lastUsage": null,
        "lastError": null,
        "authRequired": false
      }]
    }"#;
    let parsed: AccountFile = serde_json::from_str(raw).unwrap();
    assert_eq!(parsed.accounts[0].provider, Provider::Openai);
    assert_eq!(parsed.accounts[0].effective_account_id(), Some("acct"));
}

#[test]
fn large_provider_secret_round_trips_through_chunks() {
    let secret = ProviderSecret::Openai(OAuthSecret {
        access_token: "a".repeat(4200),
        refresh_token: "r".repeat(500),
        id_token: Some("i".repeat(3600)),
        expires_at: 1_800_000_000_000,
    });
    let payload = serde_json::to_string(&secret).unwrap();
    let chunks = split_utf16_chunks(&payload, CREDENTIAL_CHUNK_UTF16_UNITS);
    assert!(chunks.len() > 1);
    assert!(chunks
        .iter()
        .all(|chunk| chunk.encode_utf16().count() * 2 <= WINDOWS_CREDENTIAL_BLOB_LIMIT_BYTES));
    let joined = chunks.concat();
    let decoded = decode_provider_secret(&joined).unwrap();
    match decoded {
        ProviderSecret::Openai(decoded) => {
            assert_eq!(decoded.access_token.len(), 4200);
            assert_eq!(decoded.refresh_token.len(), 500);
            assert_eq!(decoded.id_token.unwrap().len(), 3600);
        }
        _ => panic!("expected OpenAI credentials"),
    }
}

#[test]
fn chunk_split_respects_utf16_surrogate_pairs() {
    let payload = format!(
        "{}{}",
        "x".repeat(CREDENTIAL_CHUNK_UTF16_UNITS - 1),
        "😀".repeat(5)
    );
    let chunks = split_utf16_chunks(&payload, CREDENTIAL_CHUNK_UTF16_UNITS);
    assert_eq!(chunks.concat(), payload);
    assert!(chunks
        .iter()
        .all(|chunk| chunk.encode_utf16().count() * 2 <= WINDOWS_CREDENTIAL_BLOB_LIMIT_BYTES));
}

#[test]
fn legacy_single_entry_secret_still_decodes() {
    let legacy = OAuthSecret {
        access_token: "access".into(),
        refresh_token: "refresh".into(),
        id_token: None,
        expires_at: 123,
    };
    let payload = serde_json::to_string(&legacy).unwrap();
    let decoded = decode_provider_secret(&payload).unwrap();
    assert!(matches!(decoded, ProviderSecret::Openai(_)));
}

#[test]
fn recognizes_legacy_chunked_manifest() {
    let manifest = r#"{
        "format":"chunked-v1",
        "active":{"generation":"AbCdEf0123456789","chunks":3},
        "previous":null
    }"#;
    let parsed = parse_credential_manifest(manifest).unwrap().unwrap();
    assert_eq!(parsed.active.chunks, 3);
}

#[test]
fn ignores_regular_provider_secret_json() {
    assert!(
        parse_credential_manifest(r#"{"openai":{"accessToken":"token"}}"#)
            .unwrap()
            .is_none()
    );
}

#[test]
fn upsert_preserves_newer_usage_when_reconnecting() {
    use crate::model::UsageFreshness;
    let dir = tempdir().unwrap();
    let store = AccountStore::load(dir.path().to_path_buf()).unwrap();
    let mut current = sample_account("one", "Main");
    current.email = Some("old@example.com".into());
    current.last_usage = Some(UsageSnapshot {
        plan: Some("plus".into()),
        email: Some("old@example.com".into()),
        windows: Vec::new(),
        credits_usd: None,
        unlimited_credits: false,
        fetched_at: "2026-08-30T12:00:00Z".into(),
        freshness: UsageFreshness::Live,
        source: "wham".into(),
    });
    store.upsert(current).unwrap();

    let mut incoming = sample_account("one", "Renamed");
    incoming.email = Some("new@example.com".into());
    incoming.last_usage = Some(UsageSnapshot {
        plan: Some("plus".into()),
        email: Some("new@example.com".into()),
        windows: Vec::new(),
        credits_usd: None,
        unlimited_credits: false,
        fetched_at: "2026-08-30T11:00:00Z".into(),
        freshness: UsageFreshness::Live,
        source: "wham".into(),
    });
    let saved = store.upsert(incoming).unwrap();
    assert_eq!(saved.label, "Renamed");
    assert_eq!(saved.email.as_deref(), Some("new@example.com"));
    assert_eq!(
        saved
            .last_usage
            .as_ref()
            .map(|usage| usage.fetched_at.as_str()),
        Some("2026-08-30T12:00:00Z")
    );
}

fn sample_account(id: &str, label: &str) -> Account {
    let now = now_rfc3339();
    Account {
        id: id.into(),
        label: label.into(),
        provider: Provider::Openai,
        email: None,
        provider_account_id: None,
        chatgpt_account_id: None,
        plan: None,
        created_at: now.clone(),
        updated_at: now,
        last_usage: None,
        last_error: None,
        auth_required: false,
    }
}

#[test]
fn remove_keeps_account_when_secret_delete_fails() {
    let dir = tempdir().unwrap();
    let store = AccountStore::load(dir.path().to_path_buf()).unwrap();
    store.upsert(sample_account("one", "Main")).unwrap();

    let error = store
        .remove_after_secret_result("one", Err(StoreError::Credential("denied".into())))
        .unwrap_err();
    assert!(error
        .to_string()
        .contains("Unable to delete saved credentials; the account was not removed"));
    assert_eq!(store.list().len(), 1);
    assert_eq!(store.list()[0].id, "one");
}

#[test]
fn cached_secret_skips_keychain_read_and_unchanged_write() {
    let id = "cache-skip-keychain-io";
    forget_secret(id);
    let secret = ProviderSecret::Openai(OAuthSecret {
        access_token: "access".into(),
        refresh_token: "refresh".into(),
        id_token: None,
        expires_at: 1,
    });
    remember_secret(id, secret.clone());
    assert_eq!(load_provider_secret(id).unwrap(), secret);
    save_provider_secret(id, &secret).unwrap();
    forget_secret(id);
}

#[test]
fn remove_drops_account_after_secret_delete() {
    let dir = tempdir().unwrap();
    let store = AccountStore::load(dir.path().to_path_buf()).unwrap();
    store.upsert(sample_account("one", "Main")).unwrap();
    store.remove_after_secret_result("one", Ok(())).unwrap();
    assert!(store.list().is_empty());
    let reopened = AccountStore::load(dir.path().to_path_buf()).unwrap();
    assert!(reopened.list().is_empty());
}

fn sample_openai_secret(token: &str) -> ProviderSecret {
    ProviderSecret::Openai(OAuthSecret {
        access_token: format!("access-{token}"),
        refresh_token: format!("refresh-{token}"),
        id_token: None,
        expires_at: 1,
    })
}

#[test]
fn failed_write_keeps_rotated_secret_and_retries() {
    let id = "test-dirty-secret-retry";
    forget_secret(id);
    let original = sample_openai_secret("old");
    save_provider_secret_with(id, &original, |_, _| Ok(())).unwrap();

    let rotated = sample_openai_secret("new");
    let failed = save_provider_secret_with(id, &rotated, |_, _| {
        Err(StoreError::Credential("keychain locked".into()))
    });
    assert!(failed.is_err());
    // Loads must return the rotated secret, not the stale stored one.
    assert_eq!(cached_secret(id), Some(rotated.clone()));
    // A dirty entry never expires with the cache TTL.
    SECRET_CACHE.lock().get_mut(id).unwrap().cached_at =
        Instant::now() - SECRET_CACHE_TTL - Duration::from_secs(1);
    assert_eq!(cached_secret(id), Some(rotated.clone()));

    // Saving the same secret again must attempt the write, not skip it.
    let mut attempts = 0;
    save_provider_secret_with(id, &rotated, |_, _| {
        attempts += 1;
        Ok(())
    })
    .unwrap();
    assert_eq!(attempts, 1);
    assert!(!SECRET_CACHE.lock().get(id).unwrap().dirty);

    // Once clean, an identical save is skipped again.
    save_provider_secret_with(id, &rotated, |_, _| {
        panic!("clean cached secret must not be rewritten")
    })
    .unwrap();
    forget_secret(id);
}

#[test]
fn clean_read_does_not_overwrite_pending_secret() {
    let id = "test-dirty-not-clobbered";
    forget_secret(id);
    let pending = sample_openai_secret("pending");
    remember_secret_with_state(id, pending.clone(), true);
    remember_secret(id, sample_openai_secret("stale"));
    assert_eq!(cached_secret(id), Some(pending));
    forget_secret(id);
}

#[test]
fn account_ids_must_be_plain_tokens() {
    assert!(is_valid_account_id("4f0e8a3c-2b7d-4c1e-9a55-0d3f6b1e7c22"));
    assert!(is_valid_account_id("account_1"));
    for bad in [
        "",
        "../accounts",
        "..",
        "a/b",
        "a\\b",
        "name.json",
        "with space",
        "nul\0byte",
        &"x".repeat(65),
    ] {
        assert!(!is_valid_account_id(bad), "{bad:?} should be rejected");
    }
}

#[test]
fn invalid_account_ids_never_reach_credential_storage() {
    let dir = tempdir().unwrap();
    set_data_dir(dir.path().to_path_buf());
    let secret = sample_openai_secret("traversal");
    assert!(save_provider_secret("../accounts", &secret).is_err());
    assert!(load_provider_secret("../accounts").is_err());
    // Removal of an account with a bad id must not be blocked.
    assert!(delete_secret("../accounts").is_ok());
    assert!(!dir.path().join("accounts.json").exists());

    let store = AccountStore::load(dir.path().to_path_buf()).unwrap();
    assert!(store
        .persist_account(sample_account("../accounts", "Evil"), &secret)
        .is_err());
    assert!(store.list().is_empty());
}

#[test]
fn file_storage_secret_round_trip() {
    let dir = tempdir().unwrap();
    set_data_dir(dir.path().to_path_buf());
    let id = "test-file-storage-round-trip";
    forget_secret(id);
    let secret = ProviderSecret::Openai(OAuthSecret {
        access_token: "file_access".into(),
        refresh_token: "file_refresh".into(),
        id_token: None,
        expires_at: 12345,
    });
    save_provider_secret(id, &secret).unwrap();
    forget_secret(id);
    let loaded = load_provider_secret(id).unwrap();
    assert_eq!(loaded, secret);
    delete_secret(id).unwrap();
    forget_secret(id);
    assert!(load_provider_secret(id).is_err());
}

use super::*;
use crate::store::credentials::chunking::{CredentialGeneration, CHUNKED_CREDENTIAL_FORMAT};
use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet};

const ID: &str = "3f1c2b8e-1d4a-4c55-9a77-0f6c2e1b9d10";
const OLD_GEN: &str = "LegacyGen0000001";
const OLDER_GEN: &str = "LegacyGen0000000";
const NEW_GEN: &str = "CurrentGen000001";

/// An in-memory keychain. Deleting an entry in `fail_deletes` fails, as an
/// interrupted or locked keychain would.
#[derive(Default)]
struct FakeKeychain {
    entries: RefCell<BTreeMap<(String, String), String>>,
    fail_deletes: RefCell<BTreeSet<(String, String)>>,
}

impl FakeKeychain {
    fn set(&self, service: &str, user: &str, value: &str) {
        self.entries
            .borrow_mut()
            .insert((service.into(), user.into()), value.into());
    }

    fn fail_delete_of(&self, service: &str, user: &str) {
        self.fail_deletes
            .borrow_mut()
            .insert((service.into(), user.into()));
    }

    fn heal(&self) {
        self.fail_deletes.borrow_mut().clear();
    }

    fn keys(&self) -> Vec<(String, String)> {
        self.entries.borrow().keys().cloned().collect()
    }

    fn is_empty(&self) -> bool {
        self.entries.borrow().is_empty()
    }
}

impl CredentialBackend for FakeKeychain {
    fn get(&self, service: &str, user: &str) -> Result<Option<String>, StoreError> {
        Ok(self
            .entries
            .borrow()
            .get(&(service.to_string(), user.to_string()))
            .cloned())
    }

    fn delete(&self, service: &str, user: &str) -> Result<(), StoreError> {
        let key = (service.to_string(), user.to_string());
        if self.fail_deletes.borrow().contains(&key) {
            return Err(StoreError::Credential("interrupted".into()));
        }
        self.entries.borrow_mut().remove(&key);
        Ok(())
    }
}

fn manifest(active: &str, chunks: usize, previous: Option<(&str, usize)>) -> String {
    serde_json::to_string(&CredentialManifest {
        format: CHUNKED_CREDENTIAL_FORMAT.into(),
        active: CredentialGeneration {
            generation: active.into(),
            chunks,
        },
        previous: previous.map(|(generation, chunks)| CredentialGeneration {
            generation: generation.into(),
            chunks,
        }),
    })
    .unwrap()
}

fn root() -> String {
    account_credential_user(ID)
}

fn chunk(generation: &str, index: usize) -> String {
    credential_chunk_user(ID, generation, index)
}

/// A finished-but-not-cleaned migration: the current service has a plain
/// secret (Apple) and the legacy service still has a chunked credential, one
/// chunk of which also sits under the current service.
fn half_migrated() -> FakeKeychain {
    let keychain = FakeKeychain::default();
    keychain.set(CREDENTIAL_SERVICE, &root(), r#"{"provider":"openai"}"#);
    keychain.set(
        LEGACY_CREDENTIAL_SERVICE,
        &root(),
        &manifest(OLD_GEN, 2, Some((OLDER_GEN, 1))),
    );
    keychain.set(LEGACY_CREDENTIAL_SERVICE, &chunk(OLD_GEN, 0), "a");
    keychain.set(LEGACY_CREDENTIAL_SERVICE, &chunk(OLD_GEN, 1), "b");
    keychain.set(LEGACY_CREDENTIAL_SERVICE, &chunk(OLDER_GEN, 0), "c");
    keychain.set(CREDENTIAL_SERVICE, &chunk(OLD_GEN, 1), "b");
    keychain
}

#[test]
fn removal_finds_legacy_chunks_behind_a_current_root() {
    // Before L-81, a current root stopped the legacy manifest from being read.
    let keychain = half_migrated();
    delete_account_credentials(&keychain, ID).unwrap();
    assert!(keychain.is_empty(), "left behind: {:?}", keychain.keys());
}

#[test]
fn removal_deletes_current_manifest_chunks_and_both_roots() {
    let keychain = FakeKeychain::default();
    keychain.set(
        CREDENTIAL_SERVICE,
        &root(),
        &manifest(NEW_GEN, 2, Some((OLD_GEN, 1))),
    );
    keychain.set(CREDENTIAL_SERVICE, &chunk(NEW_GEN, 0), "a");
    keychain.set(CREDENTIAL_SERVICE, &chunk(NEW_GEN, 1), "b");
    keychain.set(LEGACY_CREDENTIAL_SERVICE, &chunk(OLD_GEN, 0), "c");
    keychain.set(LEGACY_CREDENTIAL_SERVICE, &root(), r#"{"plain":true}"#);
    delete_account_credentials(&keychain, ID).unwrap();
    assert!(keychain.is_empty(), "left behind: {:?}", keychain.keys());
}

#[test]
fn an_interrupted_removal_keeps_a_root_and_a_retry_finishes_at_every_step() {
    for (service, user) in half_migrated().keys() {
        let keychain = half_migrated();
        keychain.fail_delete_of(&service, &user);
        assert!(delete_account_credentials(&keychain, ID).is_err());
        // Whatever is left is still reachable from a root.
        let left = keychain.keys();
        let orphaned =
            left.iter().any(|(_, u)| u != &root()) && !left.iter().any(|(_, u)| u == &root());
        assert!(!orphaned, "failing {service}/{user} orphaned: {left:?}");

        keychain.heal();
        delete_account_credentials(&keychain, ID).unwrap();
        assert!(
            keychain.is_empty(),
            "retry after failing {service}/{user} left: {:?}",
            keychain.keys()
        );
    }
}

#[test]
fn a_failed_legacy_chunk_keeps_the_legacy_root() {
    let keychain = half_migrated();
    keychain.fail_delete_of(LEGACY_CREDENTIAL_SERVICE, &chunk(OLD_GEN, 1));
    assert!(remove_legacy_credentials(&keychain, ID).is_err());
    assert!(keychain
        .get(LEGACY_CREDENTIAL_SERVICE, &root())
        .unwrap()
        .is_some());
}

#[test]
fn legacy_cleanup_resumes_and_keeps_the_current_credential() {
    // The first run is interrupted at the legacy root; the next load resumes
    // from it and removes everything legacy, leaving the current secret.
    let keychain = half_migrated();
    keychain.fail_delete_of(LEGACY_CREDENTIAL_SERVICE, &root());
    assert!(remove_legacy_credentials(&keychain, ID).is_err());
    keychain.heal();
    remove_legacy_credentials(&keychain, ID).unwrap();

    assert_eq!(
        keychain.keys(),
        vec![(CREDENTIAL_SERVICE.to_string(), root())],
        "only the current root should remain"
    );
}

#[test]
fn legacy_cleanup_never_deletes_chunks_the_current_manifest_uses() {
    // A legacy manifest that (oddly) names the current generation must not
    // take the live chunks with it.
    let keychain = FakeKeychain::default();
    keychain.set(CREDENTIAL_SERVICE, &root(), &manifest(NEW_GEN, 1, None));
    keychain.set(CREDENTIAL_SERVICE, &chunk(NEW_GEN, 0), "live");
    keychain.set(
        LEGACY_CREDENTIAL_SERVICE,
        &root(),
        &manifest(NEW_GEN, 1, Some((OLD_GEN, 1))),
    );
    keychain.set(LEGACY_CREDENTIAL_SERVICE, &chunk(OLD_GEN, 0), "old");
    remove_legacy_credentials(&keychain, ID).unwrap();
    assert_eq!(
        keychain.keys(),
        vec![
            (CREDENTIAL_SERVICE.to_string(), root()),
            (CREDENTIAL_SERVICE.to_string(), chunk(NEW_GEN, 0)),
        ]
    );
}

#[test]
fn legacy_cleanup_without_legacy_entries_does_nothing() {
    let keychain = FakeKeychain::default();
    keychain.set(CREDENTIAL_SERVICE, &root(), r#"{"provider":"openai"}"#);
    remove_legacy_credentials(&keychain, ID).unwrap();
    assert_eq!(keychain.keys().len(), 1);
}

#[test]
fn a_corrupt_legacy_manifest_still_lets_the_root_go() {
    let keychain = FakeKeychain::default();
    keychain.set(
        LEGACY_CREDENTIAL_SERVICE,
        &root(),
        r#"{"format":"chunked-v1","active":{"generation":"bad","chunks":0}}"#,
    );
    delete_account_credentials(&keychain, ID).unwrap();
    assert!(keychain.is_empty());
}

use crate::{
    fs_util::{atomic_write_private, ensure_private_dir, ensure_private_file},
    limits::{clamp_chars, MAX_BUCKETS, MAX_BUCKET_NAME_CHARS},
    model::{now_rfc3339, AccountBucket, Provider},
    pairing::payload::MAX_ACCOUNTS,
    store::is_valid_account_id,
};
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
};
use uuid::Uuid;

const BUCKETS_FILE_NAME: &str = "account-buckets.json";

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BucketsFile {
    version: u32,
    buckets: Vec<AccountBucket>,
}

/// Removes duplicates and ids that cannot belong to an account, keeping order,
/// and stops at the account limit.
fn normalize_account_ids(ids: Vec<String>) -> Vec<String> {
    let mut result: Vec<String> = Vec::new();
    for id in ids {
        if result.len() >= MAX_ACCOUNTS {
            break;
        }
        if is_valid_account_id(&id) && !result.contains(&id) {
            result.push(id);
        }
    }
    result
}

pub struct BucketStore {
    path: PathBuf,
    buckets: RwLock<Vec<AccountBucket>>,
}

impl BucketStore {
    pub fn load(data_dir: &Path) -> Result<Self, String> {
        ensure_private_dir(data_dir)?;
        let path = data_dir.join(BUCKETS_FILE_NAME);
        let buckets = if path.exists() {
            let payload = fs::read_to_string(&path).map_err(|error| error.to_string())?;
            let parsed = serde_json::from_str::<BucketsFile>(&payload)
                .map_err(|error| format!("Unable to read saved account buckets: {error}"))?
                .buckets;
            ensure_private_file(&path)?;
            parsed
        } else {
            Vec::new()
        };
        Ok(Self {
            path,
            buckets: RwLock::new(buckets),
        })
    }

    pub fn list(&self) -> Vec<AccountBucket> {
        self.buckets.read().clone()
    }

    #[cfg(test)]
    pub fn get(&self, id: &str) -> Option<AccountBucket> {
        self.buckets.read().iter().find(|b| b.id == id).cloned()
    }

    pub fn save(
        &self,
        id: Option<String>,
        name: String,
        provider: Option<Provider>,
        account_ids: Vec<String>,
    ) -> Result<AccountBucket, String> {
        let name = name.trim().to_string();
        if name.is_empty() {
            return Err("Bucket group name cannot be empty.".into());
        }
        if name.chars().count() > MAX_BUCKET_NAME_CHARS {
            return Err(format!(
                "Bucket group name must be {MAX_BUCKET_NAME_CHARS} characters or fewer."
            ));
        }
        if account_ids.len() > MAX_ACCOUNTS {
            return Err(format!(
                "A bucket group can hold at most {MAX_ACCOUNTS} accounts."
            ));
        }
        let account_ids = normalize_account_ids(account_ids);

        let mut buckets = self.buckets.write();
        let now = now_rfc3339();

        let bucket = if let Some(bucket_id) = id {
            let index = buckets
                .iter()
                .position(|b| b.id == bucket_id)
                .ok_or_else(|| "Bucket group not found.".to_string())?;
            let created_at = buckets[index].created_at.clone();
            let updated = AccountBucket {
                id: bucket_id,
                name,
                provider,
                account_ids,
                created_at,
                updated_at: now,
            };
            buckets[index] = updated.clone();
            updated
        } else {
            if buckets.len() >= MAX_BUCKETS {
                return Err(format!("You can have at most {MAX_BUCKETS} bucket groups."));
            }
            let new_bucket = AccountBucket {
                id: format!("bucket_{}", Uuid::new_v4().simple()),
                name,
                provider,
                account_ids,
                created_at: now.clone(),
                updated_at: now,
            };
            buckets.push(new_bucket.clone());
            new_bucket
        };

        drop(buckets);
        self.persist()?;
        Ok(bucket)
    }

    pub fn upsert_imported(&self, mut incoming: AccountBucket) -> Result<(), String> {
        // Buckets from a pairing peer get the same bounds as ones made here.
        incoming.name = incoming.name.trim().to_string();
        clamp_chars(&mut incoming.name, MAX_BUCKET_NAME_CHARS);
        if incoming.name.is_empty() {
            return Err("Bucket group name cannot be empty.".into());
        }
        incoming.account_ids = normalize_account_ids(incoming.account_ids);
        clamp_chars(&mut incoming.created_at, 64);
        clamp_chars(&mut incoming.updated_at, 64);

        let mut buckets = self.buckets.write();
        let now = now_rfc3339();

        let existing_index = buckets.iter().position(|b| {
            b.id == incoming.id
                || (b.name.trim().eq_ignore_ascii_case(incoming.name.trim())
                    && b.provider == incoming.provider)
        });

        if let Some(index) = existing_index {
            let existing = &mut buckets[index];
            for id in incoming.account_ids {
                if existing.account_ids.len() >= MAX_ACCOUNTS {
                    break;
                }
                if !existing.account_ids.contains(&id) {
                    existing.account_ids.push(id);
                }
            }
            existing.updated_at = now;
        } else {
            if buckets.len() >= MAX_BUCKETS {
                return Err(format!("You can have at most {MAX_BUCKETS} bucket groups."));
            }
            buckets.push(incoming);
        }
        drop(buckets);
        self.persist()
    }

    pub fn delete(&self, id: &str) -> Result<(), String> {
        let mut buckets = self.buckets.write();
        let initial_len = buckets.len();
        buckets.retain(|b| b.id != id);
        if buckets.len() != initial_len {
            drop(buckets);
            self.persist()?;
        }
        Ok(())
    }

    pub fn cleanup_account(&self, account_id: &str) -> Result<(), String> {
        let mut buckets = self.buckets.write();
        let mut modified = false;
        for bucket in buckets.iter_mut() {
            let before = bucket.account_ids.len();
            bucket.account_ids.retain(|id| id != account_id);
            if bucket.account_ids.len() != before {
                bucket.updated_at = now_rfc3339();
                modified = true;
            }
        }
        if modified {
            drop(buckets);
            self.persist()?;
        }
        Ok(())
    }

    fn persist(&self) -> Result<(), String> {
        let payload = BucketsFile {
            version: 1,
            buckets: self.buckets.read().clone(),
        };
        let bytes = serde_json::to_vec_pretty(&payload).map_err(|error| error.to_string())?;
        atomic_write_private(&self.path, &bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn saves_and_retrieves_buckets() {
        let dir = tempdir().expect("tempdir");
        let store = BucketStore::load(dir.path()).expect("load");

        let bucket1 = store
            .save(
                None,
                "Antigravity Team A".into(),
                Some(Provider::Antigravity),
                vec!["acc1".into(), "acc2".into()],
            )
            .expect("save bucket1");

        let bucket2 = store
            .save(
                None,
                "Antigravity Team B".into(),
                Some(Provider::Antigravity),
                vec!["acc3".into(), "acc4".into()],
            )
            .expect("save bucket2");

        let list = store.list();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].id, bucket1.id);
        assert_eq!(list[0].name, "Antigravity Team A");
        assert_eq!(list[0].account_ids, vec!["acc1", "acc2"]);
        assert_eq!(list[1].id, bucket2.id);
        assert_eq!(list[1].name, "Antigravity Team B");

        // Reload from disk
        let reloaded = BucketStore::load(dir.path()).expect("reload");
        assert_eq!(reloaded.list().len(), 2);
    }

    #[test]
    fn cleans_up_deleted_account_from_buckets() {
        let dir = tempdir().expect("tempdir");
        let store = BucketStore::load(dir.path()).expect("load");

        let bucket = store
            .save(
                None,
                "Grok Alpha".into(),
                Some(Provider::Grok),
                vec!["g1".into(), "g2".into()],
            )
            .expect("save");

        store.cleanup_account("g1").expect("cleanup");
        let updated = store.get(&bucket.id).expect("get");
        assert_eq!(updated.account_ids, vec!["g2"]);
    }

    #[test]
    fn keeps_empty_bucket_after_last_account_is_removed() {
        let dir = tempdir().expect("tempdir");
        let store = BucketStore::load(dir.path()).expect("load");

        let bucket = store
            .save(
                None,
                "Emptyable".into(),
                Some(Provider::Grok),
                vec!["only".into()],
            )
            .expect("save");

        store.cleanup_account("only").expect("cleanup");
        let listed = store.list();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, bucket.id);
        assert!(listed[0].account_ids.is_empty());
    }

    #[test]
    fn saves_bucket_with_no_accounts() {
        let dir = tempdir().expect("tempdir");
        let store = BucketStore::load(dir.path()).expect("load");
        let created = store
            .save(None, "Placeholder".into(), None, vec![])
            .expect("save empty");
        assert!(created.account_ids.is_empty());
        assert_eq!(store.list().len(), 1);

        let updated = store
            .save(Some(created.id.clone()), "Placeholder".into(), None, vec![])
            .expect("update empty");
        assert!(updated.account_ids.is_empty());
        assert_eq!(store.list().len(), 1);
    }

    #[test]
    fn deletes_bucket() {
        let dir = tempdir().expect("tempdir");
        let store = BucketStore::load(dir.path()).expect("load");

        let bucket = store
            .save(None, "Temporary".into(), None, vec!["t1".into()])
            .expect("save");

        assert_eq!(store.list().len(), 1);
        store.delete(&bucket.id).expect("delete");
        assert_eq!(store.list().len(), 0);
    }

    #[test]
    fn rejects_oversized_names_and_account_lists() {
        let dir = tempdir().expect("tempdir");
        let store = BucketStore::load(dir.path()).expect("load");

        let long_name = "n".repeat(MAX_BUCKET_NAME_CHARS + 1);
        assert!(store.save(None, long_name, None, vec![]).is_err());

        let too_many: Vec<String> = (0..=MAX_ACCOUNTS).map(|i| format!("acc-{i}")).collect();
        assert!(store.save(None, "Big".into(), None, too_many).is_err());

        // Exactly at the limits is fine.
        let at_limit: Vec<String> = (0..MAX_ACCOUNTS).map(|i| format!("acc-{i}")).collect();
        let saved = store
            .save(None, "n".repeat(MAX_BUCKET_NAME_CHARS), None, at_limit)
            .expect("limits are inclusive");
        assert_eq!(saved.account_ids.len(), MAX_ACCOUNTS);
    }

    #[test]
    fn saved_account_ids_are_deduplicated_and_plain() {
        let dir = tempdir().expect("tempdir");
        let store = BucketStore::load(dir.path()).expect("load");
        let saved = store
            .save(
                None,
                "Mixed".into(),
                None,
                vec![
                    "a".into(),
                    "b".into(),
                    "a".into(),
                    "../evil".into(),
                    "c".into(),
                ],
            )
            .expect("save");
        assert_eq!(saved.account_ids, vec!["a", "b", "c"]);
    }

    #[test]
    fn group_count_is_capped() {
        let dir = tempdir().expect("tempdir");
        let store = BucketStore::load(dir.path()).expect("load");
        for index in 0..MAX_BUCKETS {
            store
                .save(None, format!("Group {index}"), None, vec![])
                .expect("under the cap");
        }
        assert!(store
            .save(None, "One too many".into(), None, vec![])
            .is_err());

        // Editing an existing group still works at the cap.
        let first = store.list()[0].clone();
        assert!(store
            .save(Some(first.id), "Renamed".into(), None, vec![])
            .is_ok());

        // Imports respect the same cap.
        let imported = AccountBucket {
            id: "bucket_imported".into(),
            name: "Imported".into(),
            provider: None,
            account_ids: vec![],
            created_at: now_rfc3339(),
            updated_at: now_rfc3339(),
        };
        assert!(store.upsert_imported(imported).is_err());
        assert_eq!(store.list().len(), MAX_BUCKETS);
    }

    #[test]
    fn imported_buckets_are_bounded() {
        let dir = tempdir().expect("tempdir");
        let store = BucketStore::load(dir.path()).expect("load");
        let incoming = AccountBucket {
            id: "bucket_imported".into(),
            name: format!("  {}  ", "n".repeat(500)),
            provider: None,
            account_ids: (0..500).map(|i| format!("acc-{i}")).collect(),
            created_at: now_rfc3339(),
            updated_at: now_rfc3339(),
        };
        store.upsert_imported(incoming).expect("import");
        let stored = &store.list()[0];
        assert_eq!(stored.name.chars().count(), MAX_BUCKET_NAME_CHARS);
        assert_eq!(stored.account_ids.len(), MAX_ACCOUNTS);

        let blank = AccountBucket {
            name: "   ".into(),
            ..stored.clone()
        };
        assert!(store.upsert_imported(blank).is_err());
    }
}

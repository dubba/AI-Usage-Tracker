use crate::{
    fs_util::{atomic_write_private, ensure_private_file},
    model::{now_rfc3339, AccountBucket, Provider},
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

pub struct BucketStore {
    path: PathBuf,
    buckets: RwLock<Vec<AccountBucket>>,
}

impl BucketStore {
    pub fn load(data_dir: &Path) -> Result<Self, String> {
        fs::create_dir_all(data_dir).map_err(|error| error.to_string())?;
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

    #[allow(dead_code)]
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

    pub fn upsert_imported(&self, incoming: AccountBucket) -> Result<(), String> {
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
                if !existing.account_ids.contains(&id) {
                    existing.account_ids.push(id);
                }
            }
            existing.updated_at = now;
        } else {
            buckets.push(incoming);
        }
        drop(buckets);
        self.persist()
    }

    #[allow(dead_code)]
    pub fn insert_imported(&self, bucket: AccountBucket) -> Result<(), String> {
        self.upsert_imported(bucket)
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
}

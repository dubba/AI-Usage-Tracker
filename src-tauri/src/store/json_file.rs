//! The load/save half shared by the small JSON stores (`account_order`, `buckets`, `alerts`,
//! `settings`). Each keeps its own in-memory shape and rules; this is only the file handling,
//! and what it guarantees is the same for all of them:
//!
//! - the data directory is created and made private (`ensure_private_dir`);
//! - a missing file loads as `T::default()`;
//! - an existing file is parsed (a parse failure reads "<unreadable text>: <serde error>") and
//!   made private again (`ensure_private_file`), so loosened permissions are repaired;
//! - a save is `atomic_write_private` of pretty-printed JSON: owner-only, and either the old or
//!   the new contents are on disk, never a partial file.
//!
//! Recovering from an unreadable file (moving it aside) is the caller's job, through
//! `load_with_metadata_recovery` in `state.rs`.

use crate::platform::fs_util::{atomic_write_private, ensure_private_dir, ensure_private_file};
use serde::{de::DeserializeOwned, Serialize};
use std::{
    fs,
    marker::PhantomData,
    path::{Path, PathBuf},
};

pub(crate) struct JsonFileStore<T> {
    path: PathBuf,
    kind: PhantomData<fn() -> T>,
}

impl<T: Serialize + DeserializeOwned + Default> JsonFileStore<T> {
    /// Opens `<data_dir>/<file_name>` and reads it. `unreadable` starts the error text for a file
    /// that exists but cannot be parsed, e.g. "Unable to read app settings".
    pub(crate) fn open(
        data_dir: &Path,
        file_name: &str,
        unreadable: &str,
    ) -> Result<(Self, T), String> {
        ensure_private_dir(data_dir)?;
        let path = data_dir.join(file_name);
        let value = if path.exists() {
            let payload = fs::read_to_string(&path).map_err(|error| error.to_string())?;
            let parsed = serde_json::from_str::<T>(&payload)
                .map_err(|error| format!("{unreadable}: {error}"))?;
            ensure_private_file(&path)?;
            parsed
        } else {
            T::default()
        };
        Ok((
            Self {
                path,
                kind: PhantomData,
            },
            value,
        ))
    }

    /// Writes `value` as the whole file.
    pub(crate) fn save(&self, value: &T) -> Result<(), String> {
        let payload = serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?;
        atomic_write_private(&self.path, &payload)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Debug, Default, PartialEq, Serialize, Deserialize)]
    struct Sample {
        #[serde(default)]
        names: Vec<String>,
    }

    #[test]
    fn a_missing_file_loads_as_the_default_and_creates_the_directory() {
        let root = tempfile::tempdir().unwrap();
        let data_dir = root.path().join("nested").join("data");
        let (_, value) =
            JsonFileStore::<Sample>::open(&data_dir, "sample.json", "Unable to read sample")
                .unwrap();
        assert_eq!(value, Sample::default());
        assert!(data_dir.is_dir());
        assert!(
            !data_dir.join("sample.json").exists(),
            "open writes nothing"
        );
    }

    #[test]
    fn save_then_open_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let (store, _) =
            JsonFileStore::<Sample>::open(dir.path(), "sample.json", "Unable to read sample")
                .unwrap();
        store
            .save(&Sample {
                names: vec!["a".into(), "b".into()],
            })
            .unwrap();
        let (_, again) =
            JsonFileStore::<Sample>::open(dir.path(), "sample.json", "Unable to read sample")
                .unwrap();
        assert_eq!(again.names, ["a", "b"]);
    }

    #[test]
    fn an_unreadable_file_reports_the_callers_text_and_the_parse_error() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("sample.json"), "{not json").unwrap();
        let error =
            JsonFileStore::<Sample>::open(dir.path(), "sample.json", "Unable to read sample")
                .err()
                .expect("a broken file is an error");
        assert!(error.starts_with("Unable to read sample: "), "{error}");
        // The file is left where it is for the caller to quarantine.
        assert!(dir.path().join("sample.json").exists());
    }

    #[test]
    fn saved_files_are_pretty_printed_and_private() {
        let dir = tempfile::tempdir().unwrap();
        let (store, _) =
            JsonFileStore::<Sample>::open(dir.path(), "sample.json", "Unable to read sample")
                .unwrap();
        store
            .save(&Sample {
                names: vec!["a".into()],
            })
            .unwrap();
        let text = fs::read_to_string(dir.path().join("sample.json")).unwrap();
        assert!(text.contains('\n'), "pretty-printed: {text}");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(dir.path().join("sample.json"))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
    }

    #[cfg(unix)]
    #[test]
    fn opening_repairs_loosened_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sample.json");
        fs::write(&path, r#"{"names":["a"]}"#).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        JsonFileStore::<Sample>::open(dir.path(), "sample.json", "Unable to read sample").unwrap();
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
}

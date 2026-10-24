//! The month files: `<app data dir>/activity-history/YYYY-MM.json`.
//!
//! Each file holds the readings of one UTC month as compact JSON,
//! `{"version":1,"trackers":{"<account id>|<window id>":[[t,u,r],...]}}`. A refresh rewrites only
//! the current month's file, about 100 KB per account at most. The current and the previous month
//! stay in memory; older months are read from disk when the page asks for a long range.
//!
//! Files are written like every other file the app keeps (`atomic_write_private`: owner-only, and
//! either the old or the new contents on disk, never a partial file). A file that cannot be read is
//! moved aside to `*.invalid` and treated as empty, so it never stops the app from starting.

use super::{account_prefix, parse_timestamp, tracker_key, tracker_windows, Reading};
use crate::{
    diagnostics,
    model::{Account, UsageFreshness},
    platform::fs_util::{atomic_write_private, ensure_private_dir, ensure_private_file},
};
use chrono::{DateTime, Datelike, Utc};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    fs,
    path::{Path, PathBuf},
};

const DIR_NAME: &str = "activity-history";
const FORMAT_VERSION: u32 = 1;
/// A reading is stored at least this often while the app is refreshing, even if nothing changed,
/// so a flat 0% can be told apart from a time when nothing was watching.
const HEARTBEAT_SECONDS: i64 = 60 * 60;
/// Month files older than this many months before the current one are deleted.
const RETENTION_MONTHS: i32 = 13;
/// A month file larger than this is not ours (a full month is about 100 KB per account).
const MAX_FILE_BYTES: u64 = 16 * 1024 * 1024;

/// A UTC calendar month. Ordered oldest first.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
struct MonthKey {
    year: i32,
    month: u32,
}

impl MonthKey {
    fn from_timestamp(t: i64) -> Option<Self> {
        let time = DateTime::<Utc>::from_timestamp(t, 0)?;
        (1970..=9999).contains(&time.year()).then(|| Self {
            year: time.year(),
            month: time.month(),
        })
    }

    /// Months since year 0, so that months can be added and subtracted.
    fn index(self) -> i32 {
        self.year * 12 + self.month as i32 - 1
    }

    fn from_index(index: i32) -> Self {
        Self {
            year: index.div_euclid(12),
            month: index.rem_euclid(12) as u32 + 1,
        }
    }

    fn minus_months(self, months: i32) -> Self {
        Self::from_index(self.index() - months)
    }

    fn previous(self) -> Self {
        self.minus_months(1)
    }

    fn file_name(self) -> String {
        format!("{:04}-{:02}.json", self.year, self.month)
    }

    /// The month a file name stands for. Only the exact `YYYY-MM.json` shape counts, so quarantined
    /// (`*.invalid`) and temporary files are never taken for months.
    fn from_file_name(name: &str) -> Option<Self> {
        let stem = name.strip_suffix(".json")?;
        let (year, month) = stem.split_once('-')?;
        let is_digits = |text: &str, len: usize| {
            text.len() == len && text.bytes().all(|byte| byte.is_ascii_digit())
        };
        if !is_digits(year, 4) || !is_digits(month, 2) {
            return None;
        }
        let (year, month) = (year.parse().ok()?, month.parse().ok()?);
        (1..=12).contains(&month).then_some(Self { year, month })
    }
}

#[derive(Deserialize)]
struct MonthFile {
    version: u32,
    #[serde(default)]
    trackers: BTreeMap<String, Vec<Reading>>,
}

#[derive(Serialize)]
struct MonthFileRef<'a> {
    version: u32,
    trackers: &'a BTreeMap<String, Vec<Reading>>,
}

#[derive(Default)]
struct Month {
    /// Readings per tracker key, oldest first.
    trackers: BTreeMap<String, Vec<Reading>>,
    /// Changed in memory and not yet on disk (the last write failed).
    dirty: bool,
}

struct Inner {
    dir: PathBuf,
    /// The months held in memory: the current one, the one before it, and any that could not be
    /// written yet.
    months: BTreeMap<MonthKey, Month>,
    current: Option<MonthKey>,
}

/// The weekly readings of every tracker. One mutex guards memory and disk: up to four accounts
/// refresh at once, and each refresh appends and rewrites the same month file.
pub struct HistoryStore {
    inner: Mutex<Inner>,
}

impl HistoryStore {
    /// Opens the history in `data_dir`. Never fails: whatever cannot be read is set aside and
    /// logged, and the app starts with less history.
    pub fn load(data_dir: &Path) -> Self {
        Self::load_at(data_dir, Utc::now().timestamp())
    }

    /// `load` with the clock given, so the tests of this module and its siblings can pin it.
    pub(super) fn load_at(data_dir: &Path, now: i64) -> Self {
        let dir = data_dir.join(DIR_NAME);
        if let Err(error) = ensure_private_dir(&dir) {
            diagnostics::warn(&format!("Activity history folder unavailable: {error}"));
        }
        let mut inner = Inner {
            dir,
            months: BTreeMap::new(),
            current: None,
        };
        if let Some(month) = MonthKey::from_timestamp(now) {
            inner.advance_to(month);
        }
        Self {
            inner: Mutex::new(inner),
        }
    }

    /// Stores what the live refresh of `account` found, for each of its trackers.
    ///
    /// Only live results count: a cached or stale snapshot says nothing new. A reading is written
    /// when the tracker has none yet, the used percent moved by more than 0.01, the reset time
    /// changed, or the last stored reading is an hour old (the heartbeat).
    pub fn record(&self, account: &Account) -> Result<(), String> {
        let Some(usage) = account.last_usage.as_ref() else {
            return Ok(());
        };
        if usage.freshness != UsageFreshness::Live {
            return Ok(());
        }
        let Some(t) = parse_timestamp(&usage.fetched_at) else {
            return Err("The refresh time could not be read.".into());
        };
        let readings: Vec<(String, Reading)> = tracker_windows(account)
            .into_iter()
            .filter_map(|window| {
                let resets_at = window.resets_at.as_deref().and_then(parse_timestamp);
                let reading = Reading::new(t, window.used_percent?, resets_at)?;
                Some((tracker_key(&account.id, &window.id), reading))
            })
            .collect();
        if readings.is_empty() {
            return Ok(());
        }
        self.inner.lock().record(t, readings)
    }

    /// The readings of the trackers in `keys` taken at or after `from` (unix seconds), oldest
    /// first. Months older than the two held in memory are read from disk and not kept.
    pub fn readings(&self, keys: &[String], from: i64) -> HashMap<String, Vec<Reading>> {
        let inner = self.inner.lock();
        let first = MonthKey::from_timestamp(from).unwrap_or(MonthKey {
            year: 1970,
            month: 1,
        });
        let mut months: BTreeSet<MonthKey> = list_month_files(&inner.dir).into_iter().collect();
        months.extend(inner.months.keys().copied());
        let mut found: HashMap<String, Vec<Reading>> = HashMap::new();
        for month in months.range(first..) {
            let loaded;
            let trackers = match inner.months.get(month) {
                Some(cached) => &cached.trackers,
                None => {
                    loaded = read_month(&inner.dir, *month);
                    &loaded.trackers
                }
            };
            for key in keys {
                if let Some(list) = trackers.get(key) {
                    found
                        .entry(key.clone())
                        .or_default()
                        .extend(list.iter().filter(|reading| reading.t >= from));
                }
            }
        }
        found
    }

    /// Forgets everything recorded for one account, in every month file.
    pub fn remove_account(&self, account_id: &str) -> Result<(), String> {
        let prefix = account_prefix(account_id);
        self.inner.lock().edit_months(|month| {
            let before = month.trackers.len();
            month.trackers.retain(|key, _| !key.starts_with(&prefix));
            month.trackers.len() != before
        })
    }

    /// Deletes all history, on disk and in memory.
    pub fn clear(&self) -> Result<(), String> {
        let mut inner = self.inner.lock();
        inner.months.clear();
        let entries = match fs::read_dir(&inner.dir) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(format!("Unable to list the activity history: {error}")),
        };
        let mut failure = None;
        for entry in entries.flatten() {
            let is_file = entry.file_type().is_ok_and(|kind| kind.is_file());
            if is_file {
                if let Err(error) = fs::remove_file(entry.path()) {
                    failure = Some(format!("Unable to delete activity history: {error}"));
                }
            }
        }
        failure.map_or(Ok(()), Err)
    }
}

impl Inner {
    fn record(&mut self, t: i64, readings: Vec<(String, Reading)>) -> Result<(), String> {
        let month = MonthKey::from_timestamp(t).ok_or("The refresh time is out of range.")?;
        match self.current {
            Some(current) if month < current => return Ok(()),
            Some(current) if month == current => self.ensure_loaded(month),
            _ => self.advance_to(month),
        }
        for (key, reading) in readings {
            if should_write(self.last_reading(&key), &reading) {
                let month = self.months.entry(month).or_default();
                month.trackers.entry(key).or_default().push(reading);
                month.dirty = true;
            }
        }
        match self.months.get_mut(&month) {
            Some(held) if held.dirty => persist(&self.dir, month, held),
            _ => Ok(()),
        }
    }

    /// The newest reading of a tracker among the months in memory.
    fn last_reading(&self, key: &str) -> Option<&Reading> {
        self.months
            .values()
            .rev()
            .find_map(|month| month.trackers.get(key).and_then(|list| list.last()))
    }

    fn ensure_loaded(&mut self, month: MonthKey) {
        if !self.months.contains_key(&month) {
            let loaded = read_month(&self.dir, month);
            self.months.insert(month, loaded);
        }
    }

    /// Makes `month` the current one: holds it and the month before in memory, lets go of older
    /// ones, and deletes month files past the retention.
    fn advance_to(&mut self, month: MonthKey) {
        self.current = Some(month);
        let previous = month.previous();
        self.ensure_loaded(month);
        self.ensure_loaded(previous);
        self.months
            .retain(|key, held| *key == month || *key == previous || held.dirty);
        let oldest_kept = month.minus_months(RETENTION_MONTHS);
        for expired in list_month_files(&self.dir)
            .into_iter()
            .filter(|key| *key < oldest_kept)
        {
            self.months.remove(&expired);
            if let Err(error) = fs::remove_file(self.dir.join(expired.file_name())) {
                diagnostics::warn(&format!("Unable to delete old activity history: {error}"));
            }
        }
    }

    /// Runs `edit` on every month, on disk or in memory, and saves the ones it changed (a month
    /// left with no readings is deleted).
    fn edit_months(&mut self, mut edit: impl FnMut(&mut Month) -> bool) -> Result<(), String> {
        let mut keys: BTreeSet<MonthKey> = list_month_files(&self.dir).into_iter().collect();
        keys.extend(self.months.keys().copied());
        for key in keys {
            let held = self.months.contains_key(&key);
            let mut month = self
                .months
                .remove(&key)
                .unwrap_or_else(|| read_month(&self.dir, key));
            let changed = edit(&mut month);
            let saved = if changed || month.dirty {
                persist(&self.dir, key, &mut month)
            } else {
                Ok(())
            };
            if held {
                self.months.insert(key, month);
            }
            saved?;
        }
        Ok(())
    }
}

/// Whether `reading` is worth storing after `last`, the newest one the tracker has. A reading that
/// is not newer than the last is never stored: it adds nothing, and the clock may have stepped back.
fn should_write(last: Option<&Reading>, reading: &Reading) -> bool {
    let Some(last) = last else {
        return true;
    };
    reading.t > last.t
        && (reading.hundredths().abs_diff(last.hundredths()) > 1
            || reading.r != last.r
            || reading.t - last.t >= HEARTBEAT_SECONDS)
}

/// The month files in `dir`, oldest first.
fn list_month_files(dir: &Path) -> Vec<MonthKey> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut months: Vec<MonthKey> = entries
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()))
        .filter_map(|entry| MonthKey::from_file_name(entry.file_name().to_str()?))
        .collect();
    months.sort_unstable();
    months
}

/// Reads one month. A missing file is an empty month; one that cannot be read is moved aside
/// (`*.invalid`) and is an empty month too.
fn read_month(dir: &Path, month: MonthKey) -> Month {
    let path = dir.join(month.file_name());
    if !path.exists() {
        return Month::default();
    }
    match read_month_file(&path) {
        Ok(loaded) => loaded,
        Err(error) => {
            diagnostics::warn(&format!(
                "Activity history for {:04}-{:02} is unreadable and was set aside: {error}",
                month.year, month.month
            ));
            if let Err(error) = crate::state::quarantine_metadata_file(dir, &month.file_name()) {
                diagnostics::warn(&format!("Unable to set aside activity history: {error}"));
            }
            Month::default()
        }
    }
}

fn read_month_file(path: &Path) -> Result<Month, String> {
    let size = fs::metadata(path).map_err(|error| error.to_string())?.len();
    if size > MAX_FILE_BYTES {
        return Err("the file is too large".into());
    }
    let payload = fs::read(path).map_err(|error| error.to_string())?;
    let file: MonthFile = serde_json::from_slice(&payload).map_err(|error| error.to_string())?;
    if file.version != FORMAT_VERSION {
        return Err(format!("unsupported version {}", file.version));
    }
    ensure_private_file(path)?;
    let trackers = file
        .trackers
        .into_iter()
        .filter_map(|(key, mut list)| {
            list.retain(|reading| reading.t > 0 && (0.0..=100.0).contains(&reading.u));
            list.sort_by_key(|reading| reading.t);
            list.dedup_by_key(|reading| reading.t);
            (!list.is_empty()).then_some((key, list))
        })
        .collect();
    Ok(Month {
        trackers,
        dirty: false,
    })
}

/// Writes `month` as `dir/YYYY-MM.json`, or deletes the file if the month is empty.
fn persist(dir: &Path, key: MonthKey, month: &mut Month) -> Result<(), String> {
    let path = dir.join(key.file_name());
    if month.trackers.is_empty() {
        match fs::remove_file(&path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("Unable to delete activity history: {error}")),
        }
    } else {
        let payload = serde_json::to_vec(&MonthFileRef {
            version: FORMAT_VERSION,
            trackers: &month.trackers,
        })
        .map_err(|error| error.to_string())?;
        atomic_write_private(&path, &payload)?;
    }
    month.dirty = false;
    Ok(())
}

#[cfg(test)]
mod tests;

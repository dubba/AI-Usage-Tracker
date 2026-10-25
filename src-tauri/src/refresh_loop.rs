#[cfg(any(target_os = "android", target_os = "ios", test))]
use crate::model::Account;
use crate::{state::AppState, usage};
#[cfg(any(target_os = "android", target_os = "ios", test))]
use chrono::{DateTime, Utc};
use std::{
    sync::Arc,
    time::{Duration, SystemTime},
};

pub(crate) fn account_refresh_is_due(
    last_refresh: SystemTime,
    now: SystemTime,
    interval: Duration,
) -> bool {
    now.duration_since(last_refresh).unwrap_or(Duration::MAX) >= interval
}

/// How early a scheduled background run may start and still count as due.
/// Android runs periodic work at its own pace, a little before or after the
/// period, and a run skipped for being a minute early would wait a whole period.
#[cfg(any(target_os = "android", target_os = "ios", test))]
const BACKGROUND_DUE_SLACK: Duration = Duration::from_secs(2 * 60);

/// Whether a background run should refresh now: some account has a usage
/// snapshot, and the newest one is at least one refresh interval old (less the
/// slack). A snapshot with an unreadable time counts as old. With no snapshot
/// at all, any account is still worth trying once.
#[cfg(any(target_os = "android", target_os = "ios", test))]
pub(crate) fn background_refresh_is_due(
    accounts: &[Account],
    now: SystemTime,
    interval: Duration,
) -> bool {
    if accounts.is_empty() {
        return false;
    }
    let newest = accounts
        .iter()
        .filter_map(|account| account.last_usage.as_ref())
        .filter_map(|usage| DateTime::parse_from_rfc3339(&usage.fetched_at).ok())
        .map(|fetched| SystemTime::from(fetched.with_timezone(&Utc)))
        .max();
    newest.is_none_or(|newest| {
        account_refresh_is_due(newest, now, interval.saturating_sub(BACKGROUND_DUE_SLACK))
    })
}

/// Runs `future` to completion from a thread that is not part of the async runtime
/// (the Android worker thread, the iOS task thread), giving up after `timeout`.
/// Returns false when it gave up. The timer is created inside the runtime: building
/// `tokio::time::timeout` out here panics, because a timer needs a running runtime.
#[cfg(any(target_os = "android", target_os = "ios", test))]
pub(crate) fn block_on_with_timeout<F: std::future::Future>(timeout: Duration, future: F) -> bool {
    tauri::async_runtime::block_on(async { tokio::time::timeout(timeout, future).await.is_ok() })
}

/// Whether a background run can read the saved sign-ins at all. A phone that is
/// locked, or whose secure storage is not ready, fails every read; refreshing
/// then would mark each account as failed for a reason the user cannot fix, so
/// the run is skipped. With no accounts there is nothing to read.
#[cfg(any(target_os = "android", target_os = "ios", test))]
pub(crate) fn credentials_look_readable(
    account_ids: &[String],
    can_read: impl Fn(&str) -> bool,
) -> bool {
    account_ids.is_empty() || account_ids.iter().any(|id| can_read(id))
}

/// How often the refresh loop re-checks the wall clock. `tokio::time::sleep`
/// runs on a monotonic clock that stops while the device is suspended, so a
/// single long sleep can overshoot the configured interval by however long the
/// machine slept. Short ticks bound that lateness.
pub(crate) const REFRESH_POLL_TICK: Duration = Duration::from_secs(30);

pub(crate) async fn run_account_refresh_loop(state: Arc<AppState>) {
    tokio::time::sleep(Duration::from_secs(2)).await;
    let mut last_refresh: Option<SystemTime> = None;
    loop {
        let interval = Duration::from_secs(state.settings.account_refresh_minutes() * 60);
        let due = last_refresh
            .is_none_or(|last| account_refresh_is_due(last, SystemTime::now(), interval));
        if due {
            let _ = usage::refresh_all_auto(state.clone()).await;
            last_refresh = Some(SystemTime::now());
            continue;
        }
        tokio::select! {
            _ = tokio::time::sleep(REFRESH_POLL_TICK) => {}
            _ = state.wait_for_refresh_check() => {}
            // A new interval only changes when the next refresh is due (the
            // loop re-reads it above); it must not refresh everything now.
            _ = state.settings.wait_for_refresh_schedule_change() => {}
            _ = state.wait_for_refresh_wakeup() => last_refresh = None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Provider, UsageFreshness, UsageSnapshot};
    use std::time::{Duration, SystemTime};

    fn account(fetched_at: Option<&str>) -> Account {
        Account {
            id: "a".into(),
            label: "A".into(),
            provider: Provider::Openai,
            email: None,
            provider_account_id: None,
            chatgpt_account_id: None,
            plan: None,
            created_at: "2026-10-25T00:00:00Z".into(),
            updated_at: "2026-10-25T00:00:00Z".into(),
            last_usage: fetched_at.map(|fetched_at| UsageSnapshot {
                plan: None,
                email: None,
                windows: vec![],
                credits_usd: None,
                unlimited_credits: false,
                fetched_at: fetched_at.into(),
                freshness: UsageFreshness::Live,
                source: "test".into(),
            }),
            last_error: None,
            auth_required: false,
        }
    }

    fn at(rfc3339: &str) -> SystemTime {
        SystemTime::from(
            DateTime::parse_from_rfc3339(rfc3339)
                .unwrap()
                .with_timezone(&Utc),
        )
    }

    #[test]
    fn background_refresh_waits_for_the_interval_with_a_little_slack() {
        let accounts = [account(Some("2026-10-25T12:00:00Z"))];
        let interval = Duration::from_secs(30 * 60);
        assert!(!background_refresh_is_due(
            &accounts,
            at("2026-10-25T12:20:00Z"),
            interval
        ));
        // 28 minutes is within the two-minute slack of a 30-minute interval.
        assert!(background_refresh_is_due(
            &accounts,
            at("2026-10-25T12:28:00Z"),
            interval
        ));
        assert!(background_refresh_is_due(
            &accounts,
            at("2026-10-25T13:00:00Z"),
            interval
        ));
    }

    #[test]
    fn background_refresh_uses_the_newest_snapshot() {
        let accounts = [
            account(Some("2026-10-25T10:00:00Z")),
            account(Some("2026-10-25T12:00:00Z")),
        ];
        let interval = Duration::from_secs(60 * 60);
        assert!(!background_refresh_is_due(
            &accounts,
            at("2026-10-25T12:30:00Z"),
            interval
        ));
    }

    #[test]
    fn block_on_with_timeout_works_from_a_plain_thread() {
        assert!(block_on_with_timeout(Duration::from_secs(5), async {}));
        assert!(!block_on_with_timeout(
            Duration::from_millis(20),
            std::future::pending::<()>()
        ));
    }

    #[test]
    fn credentials_look_readable_when_any_account_loads() {
        let ids = ["a".to_string(), "b".to_string()];
        assert!(credentials_look_readable(&ids, |id| id == "b"));
        assert!(!credentials_look_readable(&ids, |_| false));
        assert!(credentials_look_readable(&[], |_| false));
    }

    #[test]
    fn background_refresh_skips_an_empty_app_and_tries_accounts_without_a_snapshot() {
        let interval = Duration::from_secs(15 * 60);
        let now = at("2026-10-25T12:00:00Z");
        assert!(!background_refresh_is_due(&[], now, interval));
        assert!(background_refresh_is_due(&[account(None)], now, interval));
        assert!(background_refresh_is_due(
            &[account(Some("not a time"))],
            now,
            interval
        ));
    }

    #[test]
    fn account_refresh_is_due_after_the_configured_interval() {
        let last = SystemTime::UNIX_EPOCH;
        let interval = Duration::from_secs(15 * 60);
        let just_before = last + interval - Duration::from_secs(1);
        let exactly = last + interval;
        let later = last + interval + Duration::from_secs(1);
        assert!(!account_refresh_is_due(last, just_before, interval));
        assert!(account_refresh_is_due(last, exactly, interval));
        assert!(account_refresh_is_due(last, later, interval));
    }
}

use crate::{state::AppState, usage};
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
    use std::time::{Duration, SystemTime};

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

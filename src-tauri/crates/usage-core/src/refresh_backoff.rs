//! Per-account backoff for *automatic* refreshes.
//!
//! When a provider keeps failing (or asks us to slow down), retrying every
//! interval just adds load and trips harder rate limits. This tracks
//! consecutive failures in memory and defers the next automatic attempt.
//! Manual refreshes ignore it, and any success clears it.

use std::{collections::HashMap, time::Duration, time::Instant};

/// Delay after the second consecutive failure; doubles for each further one.
pub const BACKOFF_BASE: Duration = Duration::from_secs(5 * 60);
/// Longest an account is ever deferred, including a provider `Retry-After`.
pub const BACKOFF_MAX: Duration = Duration::from_secs(60 * 60);
/// Extra random delay, as a fraction of the base delay, so accounts that
/// failed together do not all retry together.
const JITTER_FRACTION: f64 = 0.2;

struct Entry {
    failures: u32,
    retry_at: Instant,
}

#[derive(Default)]
pub struct RefreshBackoff {
    entries: HashMap<String, Entry>,
}

impl RefreshBackoff {
    /// Records a failed attempt. `retry_after` is the provider's own hint and
    /// is honored even on the first failure. `jitter` is a value in `0..1`.
    pub fn record_failure(
        &mut self,
        account_id: &str,
        retry_after: Option<Duration>,
        now: Instant,
        jitter: f64,
    ) {
        let failures = self
            .entries
            .get(account_id)
            .map_or(0, |entry| entry.failures)
            .saturating_add(1);
        let delay = failure_delay(failures, retry_after, jitter);
        self.entries.insert(
            account_id.to_string(),
            Entry {
                failures,
                retry_at: now + delay,
            },
        );
    }

    pub fn record_success(&mut self, account_id: &str) {
        self.forget(account_id);
    }

    /// Drops all state for an account (success, removal, or suspension).
    pub fn forget(&mut self, account_id: &str) {
        self.entries.remove(account_id);
    }

    pub fn is_deferred(&self, account_id: &str, now: Instant) -> bool {
        self.entries
            .get(account_id)
            .is_some_and(|entry| entry.retry_at > now)
    }
}

fn failure_delay(failures: u32, retry_after: Option<Duration>, jitter: f64) -> Duration {
    // One failure is usually a blip: retry on the normal schedule.
    let exponential = if failures <= 1 {
        Duration::ZERO
    } else {
        BACKOFF_BASE.saturating_mul(1u32 << (failures - 2).min(6))
    };
    let hinted = retry_after.unwrap_or(Duration::ZERO);
    let base = exponential.max(hinted).min(BACKOFF_MAX);
    let jitter = jitter.clamp(0.0, 1.0);
    base.mul_f64(1.0 + JITTER_FRACTION * jitter)
        .min(BACKOFF_MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn minutes(value: u64) -> Duration {
        Duration::from_secs(value * 60)
    }

    #[test]
    fn first_failure_keeps_the_normal_schedule() {
        let mut backoff = RefreshBackoff::default();
        let now = Instant::now();
        backoff.record_failure("a", None, now, 0.5);
        assert!(!backoff.is_deferred("a", now));
    }

    #[test]
    fn repeated_failures_back_off_exponentially_up_to_the_cap() {
        let expected = [0, 5, 10, 20, 40, 60, 60, 60];
        for (index, minutes_expected) in expected.iter().enumerate() {
            let failures = index as u32 + 1;
            assert_eq!(
                failure_delay(failures, None, 0.0),
                minutes(*minutes_expected),
                "failure #{failures}"
            );
        }
        // Absurd failure counts must not overflow.
        assert_eq!(failure_delay(u32::MAX, None, 1.0), BACKOFF_MAX);
    }

    #[test]
    fn provider_retry_after_is_honored_and_capped() {
        assert_eq!(failure_delay(1, Some(minutes(30)), 0.0), minutes(30));
        assert_eq!(failure_delay(3, Some(minutes(2)), 0.0), minutes(10));
        assert_eq!(failure_delay(1, Some(minutes(600)), 0.0), BACKOFF_MAX);
    }

    #[test]
    fn jitter_only_adds_delay_and_never_passes_the_cap() {
        let base = failure_delay(3, None, 0.0);
        let jittered = failure_delay(3, None, 1.0);
        assert!(jittered > base);
        assert!(jittered <= base.mul_f64(1.0 + JITTER_FRACTION));
        assert_eq!(failure_delay(6, None, 1.0), BACKOFF_MAX);
        // Out-of-range jitter input is clamped.
        assert_eq!(failure_delay(3, None, 9.0), jittered);
    }

    #[test]
    fn deferral_expires_and_success_clears_it() {
        let mut backoff = RefreshBackoff::default();
        let now = Instant::now();
        backoff.record_failure("a", Some(minutes(10)), now, 0.0);
        assert!(backoff.is_deferred("a", now + minutes(9)));
        assert!(!backoff.is_deferred("a", now + minutes(11)));
        assert!(!backoff.is_deferred("other", now));

        backoff.record_failure("a", Some(minutes(10)), now, 0.0);
        backoff.record_success("a");
        assert!(!backoff.is_deferred("a", now));
        // A success also resets the escalation: the next failure is "first".
        backoff.record_failure("a", None, now, 0.0);
        assert!(!backoff.is_deferred("a", now));
    }
}

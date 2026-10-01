use crate::model::ProviderSecret;
use parking_lot::Mutex;
use std::{
    collections::HashMap,
    sync::LazyLock,
    time::{Duration, Instant},
};
use zeroize::Zeroize;

pub const SECRET_CACHE_TTL: Duration = Duration::from_secs(300);

pub(crate) struct CachedSecret {
    pub(in crate::store) secret: ProviderSecret,
    pub(in crate::store) cached_at: Instant,
    /// True while this secret has not been durably written to the native
    /// store. Refresh tokens rotate, so the previous stored value may already
    /// be revoked: a dirty entry must outlive the cache TTL and be retried,
    /// otherwise a failed write would strand the account.
    pub(in crate::store) dirty: bool,
}

pub(crate) static SECRET_CACHE: LazyLock<Mutex<HashMap<String, CachedSecret>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

pub(crate) fn prune_secret_cache(cache: &mut HashMap<String, CachedSecret>) {
    cache.retain(|_, entry| entry.dirty || entry.cached_at.elapsed() < SECRET_CACHE_TTL);
}

pub(crate) fn cached_secret(account_id: &str) -> Option<ProviderSecret> {
    let mut cache = SECRET_CACHE.lock();
    prune_secret_cache(&mut cache);
    cache.get(account_id).map(|entry| entry.secret.clone())
}

/// True only when `secret` is cached and already persisted, so a save can be
/// skipped. A dirty entry always needs another write attempt.
pub(crate) fn cached_secret_is_clean(account_id: &str, secret: &ProviderSecret) -> bool {
    let mut cache = SECRET_CACHE.lock();
    prune_secret_cache(&mut cache);
    cache
        .get(account_id)
        .is_some_and(|entry| !entry.dirty && &entry.secret == secret)
}

pub(crate) fn remember_secret(account_id: &str, secret: ProviderSecret) {
    // A clean read from the native store must never overwrite a newer secret
    // that is still waiting to be written.
    if SECRET_CACHE
        .lock()
        .get(account_id)
        .is_some_and(|entry| entry.dirty)
    {
        return;
    }
    remember_secret_with_state(account_id, secret, false);
}

pub(crate) fn remember_secret_with_state(account_id: &str, secret: ProviderSecret, dirty: bool) {
    let mut cache = SECRET_CACHE.lock();
    prune_secret_cache(&mut cache);
    cache.insert(
        account_id.to_string(),
        CachedSecret {
            secret,
            cached_at: Instant::now(),
            dirty,
        },
    );
}

pub(crate) fn mark_secret_clean(account_id: &str, secret: &ProviderSecret) {
    let mut cache = SECRET_CACHE.lock();
    if let Some(entry) = cache.get_mut(account_id) {
        // Only clear the flag if no newer secret replaced ours meanwhile.
        if &entry.secret == secret {
            entry.dirty = false;
            entry.cached_at = Instant::now();
        }
    }
}

pub(crate) fn forget_secret(account_id: &str) {
    let mut cache = SECRET_CACHE.lock();
    if let Some(mut entry) = cache.remove(account_id) {
        entry.secret.zeroize();
    }
}

impl Drop for CachedSecret {
    fn drop(&mut self) {
        self.secret.zeroize();
    }
}

//! Bounds on Google's paginated listings (L-87).
//!
//! A refresh holds the account lock until it finishes, and Google says when
//! to stop only through `nextPageToken`. A faulty or hostile reply could keep
//! handing out tokens, so every listing stops at a page count, an item count,
//! a token it has already seen, or a deadline, whichever comes first, and the
//! refresh fails as transient so the last good usage stays.

use super::ProviderError;
use std::{
    collections::HashSet,
    time::{Duration, Instant},
};

/// Real listings fit in one or two pages at the page sizes requested.
pub(super) const MAX_PAGES: usize = 20;
/// Models, metric descriptors, or quota series kept from one listing.
pub(super) const MAX_ITEMS: usize = 5_000;
/// Quota metric types queried in one refresh, each its own listing. The known
/// quota families give a few dozen.
pub(super) const MAX_METRIC_TYPES: usize = 100;
/// How long one listing may take in all, apart from each request's timeout.
pub(super) const MAX_LISTING_TIME: Duration = Duration::from_secs(60);

pub(super) struct Pager {
    what: &'static str,
    pages: usize,
    seen: HashSet<String>,
    deadline: Instant,
}

impl Pager {
    pub(super) fn new(what: &'static str) -> Self {
        Self::with_deadline(what, Instant::now() + MAX_LISTING_TIME)
    }

    pub(super) fn with_deadline(what: &'static str, deadline: Instant) -> Self {
        Self {
            what,
            pages: 0,
            seen: HashSet::new(),
            deadline,
        }
    }

    /// Called after each page with the reply's next-page token and how many
    /// items are kept so far. `Ok(None)` ends the listing, `Ok(Some(token))`
    /// asks for the next page, and an error means a bound was passed.
    pub(super) fn next(
        &mut self,
        token: Option<String>,
        items: usize,
    ) -> Result<Option<String>, ProviderError> {
        self.pages += 1;
        if items > MAX_ITEMS {
            return Err(self.too_much("more entries"));
        }
        let Some(token) = token.filter(|token| !token.trim().is_empty()) else {
            return Ok(None);
        };
        if self.pages >= MAX_PAGES {
            return Err(self.too_much("more pages"));
        }
        if !self.seen.insert(token.clone()) {
            return Err(ProviderError::Transient(format!(
                "{} repeated a page. Cached usage is being kept.",
                self.what
            )));
        }
        if Instant::now() >= self.deadline {
            return Err(ProviderError::Transient(format!(
                "{} took too long to list. Cached usage is being kept.",
                self.what
            )));
        }
        Ok(Some(token))
    }

    fn too_much(&self, what: &str) -> ProviderError {
        ProviderError::Transient(format!(
            "{} returned {what} than expected. Cached usage is being kept.",
            self.what
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message(error: ProviderError) -> String {
        match error {
            ProviderError::Transient(text) => text,
            other => panic!("expected a transient error, got {other:?}"),
        }
    }

    #[test]
    fn a_listing_ends_when_there_is_no_next_page() {
        let mut pager = Pager::new("Google");
        assert_eq!(pager.next(Some("a".into()), 10).unwrap(), Some("a".into()));
        assert_eq!(pager.next(Some("  ".into()), 20).unwrap(), None);
        assert_eq!(Pager::new("Google").next(None, 0).unwrap(), None);
    }

    #[test]
    fn endless_page_tokens_stop_at_the_page_limit() {
        let mut pager = Pager::new("Google");
        let mut pages = 0;
        let error = loop {
            match pager.next(Some(format!("token-{pages}")), 1) {
                Ok(Some(_)) => pages += 1,
                Ok(None) => panic!("the listing never ends by itself"),
                Err(error) => break error,
            }
        };
        assert_eq!(pages, MAX_PAGES - 1);
        assert!(message(error).contains("more pages"));
    }

    #[test]
    fn a_repeated_page_token_stops_the_listing() {
        let mut pager = Pager::new("Google");
        pager.next(Some("same".into()), 1).unwrap();
        assert!(message(pager.next(Some("same".into()), 2).unwrap_err()).contains("repeated"));
    }

    #[test]
    fn too_many_items_stop_the_listing_even_on_the_last_page() {
        let mut pager = Pager::new("Google");
        assert!(message(pager.next(None, MAX_ITEMS + 1).unwrap_err()).contains("more entries"));
        assert_eq!(Pager::new("Google").next(None, MAX_ITEMS).unwrap(), None);
    }

    #[test]
    fn a_listing_past_its_deadline_stops() {
        let mut pager = Pager::with_deadline("Google", Instant::now());
        assert!(message(pager.next(Some("a".into()), 1).unwrap_err()).contains("too long"));
    }
}

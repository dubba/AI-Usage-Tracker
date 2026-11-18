use crate::{model::Provider, state::AppState};

/// Runs on every successful startup. A write that fails is logged and tried
/// again on the next launch, because the account still looks unmigrated.
pub(crate) fn migrate_google_ai_studio_accounts(state: &AppState) {
    for account in state.store.list() {
        let legacy_ai_studio = account.provider == Provider::Antigravity
            && account
                .provider_account_id
                .as_deref()
                .is_some_and(|value| value.starts_with("google-ai-studio:"));
        if legacy_ai_studio {
            // This account becomes Google AI Studio and keeps its
            // `google-ai-studio:` fingerprint, which duplicate detection and
            // pairing use. The Antigravity clean-up below must not see it: it
            // reads the snapshot taken before this change (L-53).
            if state
                .store
                .mutate(&account.id, |account| {
                    account.provider = Provider::GoogleAiStudio;
                    account.plan = Some("Google AI Studio".into());
                })
                .is_err()
            {
                crate::diagnostics::warn(
                    "Could not move an account to Google AI Studio; it will be tried again at the next launch.",
                );
            }
        } else if account.provider == Provider::Antigravity {
            // Older builds cached the Antigravity Google Cloud *project* id in
            // the account identity field. Project ids always contain a letter
            // or hyphen; Google user ids are all digits. Clear non-numeric
            // values so pairing no longer treats distinct accounts sharing a
            // project as duplicates.
            let polluted = account
                .provider_account_id
                .as_deref()
                .is_some_and(|value| !value.bytes().all(|b| b.is_ascii_digit()));
            if polluted
                && state
                    .store
                    .mutate(&account.id, |account| {
                        account.provider_account_id = None;
                    })
                    .is_err()
            {
                crate::diagnostics::warn(
                    "Could not clear an outdated Antigravity account id; it will be tried again at the next launch.",
                );
            }
        }
    }
}

#[cfg(test)]
mod tests;

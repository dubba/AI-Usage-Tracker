use crate::{model::Provider, state::AppState};

pub(crate) fn migrate_google_ai_studio_accounts(state: &AppState) {
    for account in state.store.list() {
        let legacy_ai_studio = account.provider == Provider::Antigravity
            && account
                .provider_account_id
                .as_deref()
                .is_some_and(|value| value.starts_with("google-ai-studio:"));
        if legacy_ai_studio {
            let _ = state.store.mutate(&account.id, |account| {
                account.provider = Provider::GoogleAiStudio;
                account.plan = Some("Google AI Studio".into());
            });
        }
        // Older builds cached the Antigravity Google Cloud *project* id in the
        // account identity field. Project ids always contain a letter or hyphen;
        // Google user ids are all digits. Clear non-numeric values so pairing
        // no longer treats distinct accounts sharing a project as duplicates.
        if account.provider == Provider::Antigravity {
            let polluted = account
                .provider_account_id
                .as_deref()
                .is_some_and(|value| !value.bytes().all(|b| b.is_ascii_digit()));
            if polluted {
                let _ = state.store.mutate(&account.id, |account| {
                    account.provider_account_id = None;
                });
            }
        }
    }
}

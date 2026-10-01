use crate::alerts;
use crate::{
    alerts::UsageAlertSetting,
    model::{Account, Provider},
    state::AppState,
    usage,
};
use std::sync::Arc;
use tauri::State;

#[tauri::command]
pub fn get_account_alerts(
    state: State<'_, Arc<AppState>>,
    account_id: String,
) -> Result<Vec<UsageAlertSetting>, String> {
    if state.store.get(&account_id).is_none() {
        return Err("Account not found.".into());
    }
    Ok(state.alerts.get(&account_id))
}

pub fn is_alert_window_available(account: &Account, window_id: &str) -> bool {
    if let Some(usage) = account.last_usage.as_ref() {
        if usage
            .windows
            .iter()
            .any(|window| alerts::canonical_window_id(window) == Some(window_id))
        {
            return true;
        }
    }
    // Free OpenAI/ChatGPT accounts operate on a 30-day (monthly) quota limit.
    // Recognize monthly limit for OpenAI free tier accounts even if last_usage is pending
    // or cached with legacy session labels.
    if account.provider == Provider::Openai
        && window_id == "monthly"
        && account
            .plan
            .as_deref()
            .is_none_or(|p| p.eq_ignore_ascii_case("free"))
    {
        return true;
    }
    // Paid OpenAI accounts support 5-hour and weekly limits.
    if account.provider == Provider::Openai
        && (window_id == "five_hour" || window_id == "weekly")
        && account
            .plan
            .as_deref()
            .is_some_and(|p| !p.eq_ignore_ascii_case("free"))
    {
        return true;
    }
    false
}

#[tauri::command]
pub fn save_account_alerts(
    state: State<'_, Arc<AppState>>,
    account_id: String,
    settings: Vec<UsageAlertSetting>,
) -> Result<Vec<UsageAlertSetting>, String> {
    let account = state
        .store
        .get(&account_id)
        .ok_or_else(|| "Account not found.".to_string())?;

    for setting in &settings {
        if !setting.enabled {
            continue;
        }
        if !is_alert_window_available(&account, &setting.window_id) {
            return Err(format!(
                "{} is not available for this account's current plan.",
                setting.window_id.replace('_', " ")
            ));
        }
    }

    let saved = state.alerts.save(&account_id, settings)?;
    usage::emit_alerts_for_account(state.inner().as_ref(), &account);
    Ok(saved)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_monthly_window_for_free_openai_accounts() {
        use crate::model::{now_rfc3339, Account, Provider};

        let now = now_rfc3339();
        let free_account = Account {
            id: "openai-free".into(),
            label: "Free ChatGPT".into(),
            provider: Provider::Openai,
            email: None,
            provider_account_id: None,
            chatgpt_account_id: None,
            plan: Some("free".into()),
            created_at: now.clone(),
            updated_at: now.clone(),
            last_usage: None,
            last_error: None,
            auth_required: false,
        };

        assert!(is_alert_window_available(&free_account, "monthly"));
        assert!(!is_alert_window_available(&free_account, "five_hour"));
    }
}

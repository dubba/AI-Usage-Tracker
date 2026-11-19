use super::error::CommandResult;
use crate::{state::AppState, store::alerts::UsageAlertSetting, usage};
use std::sync::Arc;
use tauri::State;
#[cfg(target_os = "ios")]
use tauri_plugin_notification::{NotificationExt, PermissionState};

/// iOS shows the system permission prompt only once, so ask when the user first turns on an
/// alert. The plugin call blocks on the native side, so it runs off the command thread.
#[cfg(target_os = "ios")]
fn request_notification_permission(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        let notification = app.notification();
        if matches!(
            notification.permission_state(),
            Ok(PermissionState::Prompt | PermissionState::PromptWithRationale)
        ) {
            if let Err(err) = notification.request_permission() {
                crate::diagnostics::warn(&format!(
                    "[Notification] Permission request failed: {err}"
                ));
            }
        }
    });
}

#[tauri::command]
pub fn get_account_alerts(
    state: State<'_, Arc<AppState>>,
    account_id: String,
) -> CommandResult<Vec<UsageAlertSetting>> {
    if state.store.get(&account_id).is_none() {
        return Err("Account not found.".into());
    }
    Ok(state.alerts.get(&account_id))
}

#[tauri::command]
pub fn save_account_alerts(
    #[cfg_attr(not(target_os = "ios"), allow(unused_variables))] app: tauri::AppHandle,
    state: State<'_, Arc<AppState>>,
    account_id: String,
    settings: Vec<UsageAlertSetting>,
) -> CommandResult<Vec<UsageAlertSetting>> {
    let account = state
        .store
        .get(&account_id)
        .ok_or_else(|| "Account not found.".to_string())?;

    for setting in &settings {
        if !setting.enabled {
            continue;
        }
        if !usage_core::alerts::is_available(&account, &setting.window_id) {
            return Err(format!(
                "{} is not available for this account's current plan.",
                setting.window_id.replace('_', " ")
            )
            .into());
        }
    }

    #[cfg(target_os = "ios")]
    if settings.iter().any(|setting| setting.enabled) {
        request_notification_permission(app);
    }

    let saved = state
        .alerts
        .save(&account_id, settings)
        .map_err(crate::diagnostics::command_error)?;
    usage::emit_alerts_for_account(state.inner().as_ref(), &account);
    Ok(saved)
}

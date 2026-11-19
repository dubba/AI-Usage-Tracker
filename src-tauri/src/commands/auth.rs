use super::error::{CommandError, CommandResult, ErrorCode};
use super::validate_label;
use crate::{
    auth::google_ai_studio_oauth,
    auth::grok_login,
    auth::oauth,
    auth::oauth_common,
    auth::opencode_login,
    limits,
    model::{Account, LoginStart, LoginState, LoginStatus, Provider},
    providers,
    state::AppState,
};
use std::str::FromStr;
use std::sync::Arc;
use tauri::Manager;
use tauri::{AppHandle, State};

/// Every sign-in window a login can open, named by the module that opens it. `cancel_login`
/// closes all of them, so a window added without a label here would stay open after Cancel (the
/// test below fails until it is listed).
const LOGIN_WINDOW_LABELS: [&str; 3] = [
    opencode_login::LOGIN_WINDOW_LABEL,
    grok_login::LOGIN_WINDOW_LABEL,
    oauth::PROVIDER_LOGIN_WINDOW,
];

/// A sign-in failure, with a code for the two states the page acts on: another sign-in still
/// running (it offers to cancel that one) and an attempt this app no longer has (it stops
/// watching). Every other sentence is passed on as it is.
fn login_error(message: String) -> CommandError {
    let code = if message == oauth_common::LOGIN_IN_PROGRESS_MESSAGE {
        ErrorCode::LoginInProgress
    } else if message == oauth::LOGIN_ATTEMPT_GONE {
        ErrorCode::LoginAttemptGone
    } else {
        ErrorCode::Unclassified
    };
    CommandError::new(code, message)
}

#[tauri::command]
pub async fn start_login(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    label: String,
    provider: String,
    email: Option<String>,
    reconnect_account_id: Option<String>,
) -> CommandResult<LoginStart> {
    let provider = Provider::from_str(&provider)?;
    let email = limits::normalize_optional_email(email)?;
    let label = if label.trim().is_empty() {
        provider.display_name().to_string()
    } else {
        validate_label(&label)?
    };

    if provider == Provider::GoogleAiStudio {
        return Err("Google AI Studio setup begins with an API key in Add Account.".into());
    }
    if provider == Provider::OpencodeGo {
        opencode_login::start_login(
            app,
            state.inner().clone(),
            label,
            email,
            reconnect_account_id,
        )
        .await
        .map_err(login_error)
    } else if provider == Provider::Grok {
        grok_login::start_login(state.inner().clone(), label, reconnect_account_id)
            .await
            .map_err(login_error)
    } else {
        oauth::start_login(
            state.inner().clone(),
            label,
            provider,
            email,
            reconnect_account_id,
        )
        .await
        .map_err(login_error)
    }
}

#[tauri::command]
pub async fn probe_google_ai_studio_key(
    state: State<'_, Arc<AppState>>,
    api_key: String,
) -> CommandResult<Account> {
    providers::google_ai_studio::probe_account(
        state.inner().clone(),
        "Google AI Studio".into(),
        api_key,
    )
    .await
    .map_err(Into::into)
}

#[tauri::command]
pub async fn add_google_ai_studio_account(
    state: State<'_, Arc<AppState>>,
    label: String,
    api_key: String,
    selected_models: Vec<String>,
) -> CommandResult<Account> {
    providers::google_ai_studio::add_account(
        state.inner().clone(),
        validate_label(&label)?,
        api_key,
        selected_models,
    )
    .await
    .map_err(Into::into)
}

#[tauri::command]
pub async fn start_google_ai_studio_usage_login(
    state: State<'_, Arc<AppState>>,
    account_id: String,
    project_id: String,
    enable_monitoring: bool,
) -> CommandResult<LoginStart> {
    google_ai_studio_oauth::start_login(
        state.inner().clone(),
        account_id,
        project_id,
        enable_monitoring,
    )
    .await
    .map_err(login_error)
}

#[tauri::command]
pub async fn add_grok_account(
    state: State<'_, Arc<AppState>>,
    label: String,
    cookie_header: String,
    reconnect_account_id: Option<String>,
) -> CommandResult<Account> {
    let label = if label.trim().is_empty() {
        Provider::Grok.display_name().to_string()
    } else {
        validate_label(&label)?
    };
    grok_login::add_account(
        state.inner().clone(),
        label,
        cookie_header,
        reconnect_account_id,
    )
    .await
    .map_err(Into::into)
}

#[tauri::command]
pub async fn add_opencode_go_account(
    state: State<'_, Arc<AppState>>,
    label: String,
    workspace_id: String,
    auth_cookie: String,
    email: Option<String>,
    reconnect_account_id: Option<String>,
) -> CommandResult<Account> {
    let label = if label.trim().is_empty() {
        Provider::OpencodeGo.display_name().to_string()
    } else {
        validate_label(&label)?
    };
    let email = limits::normalize_optional_email(email)?;
    opencode_login::add_account(
        state.inner().clone(),
        label,
        workspace_id,
        auth_cookie,
        email,
        reconnect_account_id,
    )
    .await
    .map_err(Into::into)
}

#[tauri::command]
pub async fn get_login_status(
    state: State<'_, Arc<AppState>>,
    attempt_id: String,
) -> CommandResult<LoginStatus> {
    oauth::login_status(state.inner(), &attempt_id)
        .await
        .map_err(login_error)
}

#[tauri::command]
pub fn current_login_status(state: State<'_, Arc<AppState>>) -> Option<LoginStatus> {
    state.pending_login.read().clone()
}

#[tauri::command]
pub fn cancel_login(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    attempt_id: String,
) -> CommandResult<()> {
    let cancelled = {
        let mut pending = state.pending_login.write();
        let cancellable = pending
            .as_ref()
            .is_some_and(|login| login.attempt_id == attempt_id && login.status.is_in_progress());
        if cancellable {
            *pending = Some(LoginStatus {
                attempt_id: attempt_id.clone(),
                status: LoginState::Failed,
                message: Some("Authentication was canceled.".into()),
                account: None,
                projects: None,
                selected_project_id: None,
            });
        }
        cancellable
    };

    state.abort_login_resources(&attempt_id);
    if !cancelled {
        return Ok(());
    }

    for label in LOGIN_WINDOW_LABELS {
        if let Some(window) = app.get_webview_window(label) {
            let _ = window.close();
            let _ = window.destroy();
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{login_error, oauth, oauth_common, ErrorCode, LOGIN_WINDOW_LABELS};

    #[test]
    fn the_two_sign_in_states_the_page_acts_on_have_codes() {
        let busy = login_error(oauth_common::LOGIN_IN_PROGRESS_MESSAGE.into());
        assert_eq!(busy.code, ErrorCode::LoginInProgress);
        assert_eq!(busy.message, oauth_common::LOGIN_IN_PROGRESS_MESSAGE);
        assert_eq!(
            login_error(oauth::LOGIN_ATTEMPT_GONE.into()).code,
            ErrorCode::LoginAttemptGone
        );
        let other = login_error("The login attempt is no longer active.".into());
        assert_eq!(other.code, ErrorCode::Unclassified);
    }
    use std::{collections::BTreeSet, fs, path::Path};

    fn rust_sources(dir: &Path, out: &mut Vec<std::path::PathBuf>) {
        for entry in fs::read_dir(dir).unwrap().flatten() {
            let path = entry.path();
            if path.is_dir() {
                rust_sources(&path, out);
            } else if path.extension().is_some_and(|ext| ext == "rs") {
                out.push(path);
            }
        }
    }

    /// `const SOME_WINDOW: &str = "some-login";` lines whose name and value look like the label
    /// of a sign-in window (or the prefix of its popups).
    fn login_window_constants() -> BTreeSet<(String, String)> {
        let mut files = Vec::new();
        rust_sources(
            &Path::new(env!("CARGO_MANIFEST_DIR")).join("src"),
            &mut files,
        );
        let mut found = BTreeSet::new();
        for file in files {
            for line in fs::read_to_string(&file).unwrap().lines() {
                let line = line.trim();
                let Some(rest) = [
                    "pub(crate) const ",
                    "pub(super) const ",
                    "pub const ",
                    "const ",
                ]
                .iter()
                .find_map(|prefix| line.strip_prefix(prefix)) else {
                    continue;
                };
                let Some((name, value)) = rest.split_once(": &str = \"") else {
                    continue;
                };
                let Some(value) = value.strip_suffix("\";") else {
                    continue;
                };
                let name_fits = ["WINDOW", "LABEL", "POPUP_PREFIX"]
                    .iter()
                    .any(|word| name.contains(word));
                if name_fits && value.contains("login") {
                    found.insert((name.to_string(), value.to_string()));
                }
            }
        }
        found
    }

    #[test]
    fn cancel_login_closes_every_sign_in_window() {
        let constants = login_window_constants();
        // Guards the scan above against quietly matching nothing.
        assert!(
            constants.len() >= 4,
            "expected the three window labels and the popup prefix, found {constants:?}"
        );
        for (name, value) in constants {
            if value.ends_with('-') {
                // A popup prefix: popups are children of one of the listed windows.
                assert!(
                    LOGIN_WINDOW_LABELS
                        .iter()
                        .any(|label| value.starts_with(label)),
                    "{name} ({value}) is not a popup of a window in LOGIN_WINDOW_LABELS"
                );
            } else {
                assert!(
                    LOGIN_WINDOW_LABELS.contains(&value.as_str()),
                    "{name} ({value}) opens a sign-in window that cancel_login does not close; add it to LOGIN_WINDOW_LABELS"
                );
            }
        }
    }

    #[test]
    fn the_labels_are_the_three_known_windows() {
        assert_eq!(
            LOGIN_WINDOW_LABELS,
            ["opencode-go-login", "grok-login", "provider-login"]
        );
    }
}

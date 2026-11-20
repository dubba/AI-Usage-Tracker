//! Cloud Monitoring on the chosen project: whether it is enabled, and turning it on.

use super::*;

const MONITORING_SERVICE: &str = "monitoring.googleapis.com";

#[derive(Debug, Deserialize)]
pub(super) struct ServiceResponse {
    state: Option<String>,
}

#[derive(Debug, Deserialize)]
pub(super) struct OperationResponse {
    name: Option<String>,
    done: Option<bool>,
    error: Option<Value>,
}

// Short-lived value moved straight into a `LoginStatus`; boxing would only
// add indirection.

pub(super) async fn monitoring_enabled(
    app: &AppState,
    project: &CloudProjectOption,
    access_token: &str,
) -> Result<bool, String> {
    let response = app
        .client
        .get(format!(
            "https://serviceusage.googleapis.com/v1/projects/{}/services/{MONITORING_SERVICE}",
            project.project_number
        ))
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|error| {
            crate::providers::request_failed("Unable to check Cloud Monitoring", &error)
        })?;
    let status = response.status();
    let body = read_google_body(response).await?;
    if status == StatusCode::UNAUTHORIZED {
        return Err("Google authorization expired while checking Cloud Monitoring.".into());
    }
    if status == StatusCode::FORBIDDEN {
        return Err("The signed-in account cannot inspect services for this project. Ask a project owner for Service Usage Viewer access.".into());
    }
    if !status.is_success() {
        return Err(format!(
            "Cloud Monitoring status returned HTTP {}.",
            status.as_u16()
        ));
    }
    let service: ServiceResponse = serde_json::from_str(&body)
        .map_err(|_| String::from("Google returned an invalid service status."))?;
    Ok(service.state.as_deref() == Some("ENABLED"))
}

pub(super) async fn enable_monitoring(
    app: &AppState,
    project: &CloudProjectOption,
    access_token: &str,
) -> Result<(), String> {
    let response = app
        .client
        .post(format!(
            "https://serviceusage.googleapis.com/v1/projects/{}/services/{MONITORING_SERVICE}:enable",
            project.project_number
        ))
        .bearer_auth(access_token)
        .json(&json!({}))
        .send()
        .await
        .map_err(|error| {
            crate::providers::request_failed("Unable to enable Cloud Monitoring", &error)
        })?;
    let status = response.status();
    let body = read_google_body(response).await?;
    if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN {
        return Err("Google did not allow this account to enable Cloud Monitoring. A project owner or Service Usage Admin must enable it.".into());
    }
    if !status.is_success() {
        return Err(format!(
            "Enabling Cloud Monitoring returned HTTP {}.",
            status.as_u16()
        ));
    }
    let operation: OperationResponse = serde_json::from_str(&body)
        .map_err(|_| String::from("Google returned an invalid enable operation."))?;
    if operation.done == Some(true) {
        if operation.error.is_some() {
            return Err("Google could not enable Cloud Monitoring for this project.".into());
        }
        return Ok(());
    }
    let Some(name) = operation.name.filter(|value| !value.trim().is_empty()) else {
        return Ok(());
    };
    poll_operation(app, &name, access_token).await
}

pub(super) async fn poll_operation(
    app: &AppState,
    name: &str,
    access_token: &str,
) -> Result<(), String> {
    for _ in 0..30 {
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        let response = app
            .client
            .get(format!("https://serviceusage.googleapis.com/v1/{name}"))
            .bearer_auth(access_token)
            .send()
            .await
            .map_err(|error| {
                crate::providers::request_failed(
                    "Unable to check Cloud Monitoring enablement",
                    &error,
                )
            })?;
        let status = response.status();
        let body = read_google_body(response).await?;
        if !status.is_success() {
            return Err(format!(
                "Cloud Monitoring enablement check returned HTTP {}.",
                status.as_u16()
            ));
        }
        let operation: OperationResponse = serde_json::from_str(&body)
            .map_err(|_| String::from("Google returned an invalid operation status."))?;
        if operation.done == Some(true) {
            return if operation.error.is_some() {
                Err("Google could not enable Cloud Monitoring for this project.".into())
            } else {
                Ok(())
            };
        }
    }
    Err("Cloud Monitoring is still being enabled. Wait a minute and connect usage again.".into())
}

//! The Cloud projects behind a Google AI Studio key: which project a key belongs to, the list
//! the user can choose from, and the checks on what Google returns.

use super::*;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ProjectResponse {
    pub(super) name: String,
    pub(super) project_id: String,
    pub(super) display_name: Option<String>,
    pub(super) state: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ProjectSearchResponse {
    #[serde(default)]
    pub(super) projects: Vec<ProjectResponse>,
    pub(super) next_page_token: Option<String>,
}

#[derive(Debug, Deserialize)]
pub(super) struct LookupKeyResponse {
    pub(super) parent: Option<String>,
}

pub(super) async fn lookup_key_project(
    app: &AppState,
    api_key: &str,
    access_token: &str,
) -> Result<Option<CloudProjectOption>, String> {
    let response = app
        .client
        .post("https://apikeys.googleapis.com/v2/keys:lookupKey")
        .bearer_auth(access_token)
        .json(&serde_json::json!({ "keyString": api_key }))
        .send()
        .await
        .map_err(|_| {
            "Google API-key project lookup could not be reached. Check your network and try again."
                .to_string()
        })?;
    let status = response.status();
    let body = read_google_body(response).await?;
    if status == StatusCode::UNAUTHORIZED {
        return Err(
            "Google authorization expired before the API-key project could be found.".into(),
        );
    }
    if status == StatusCode::FORBIDDEN
        || status == StatusCode::NOT_FOUND
        || status == StatusCode::BAD_REQUEST
    {
        return Ok(None);
    }
    if !status.is_success() {
        return Err(format!(
            "Google API-key project lookup returned HTTP {}.",
            status.as_u16()
        ));
    }
    let lookup: LookupKeyResponse = serde_json::from_str(&body)
        .map_err(|_| String::from("Google returned an invalid API-key lookup response."))?;
    let Some(parent) = lookup.parent.filter(|value| !value.trim().is_empty()) else {
        return Ok(None);
    };
    resolve_project_resource(app, &parent, access_token)
        .await
        .map(Some)
}

pub(super) async fn list_projects(
    app: &AppState,
    access_token: &str,
) -> Result<Vec<CloudProjectOption>, String> {
    let mut page_token: Option<String> = None;
    let mut projects = Vec::new();
    loop {
        let mut request = app
            .client
            .get("https://cloudresourcemanager.googleapis.com/v3/projects:search")
            .bearer_auth(access_token)
            .query(&[("pageSize", "1000")]);
        if let Some(token) = page_token.as_deref() {
            request = request.query(&[("pageToken", token)]);
        }
        let response = request
            .send()
            .await
            .map_err(|error| format!("Google Cloud project search failed: {error}"))?;
        let status = response.status();
        let body = read_google_body(response).await?;
        if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN {
            return Err("Google did not allow this account to list Cloud projects.".into());
        }
        if !status.is_success() {
            return Err(format!(
                "Google Cloud project search returned HTTP {}.",
                status.as_u16()
            ));
        }
        let page: ProjectSearchResponse = serde_json::from_str(&body)
            .map_err(|_| String::from("Google returned an invalid project list."))?;
        projects.extend(page.projects.into_iter().filter_map(project_option));
        page_token = page
            .next_page_token
            .filter(|value| !value.trim().is_empty());
        if page_token.is_none() {
            break;
        }
    }
    projects.sort_by(|left, right| {
        left.display_name
            .to_ascii_lowercase()
            .cmp(&right.display_name.to_ascii_lowercase())
            .then_with(|| left.project_id.cmp(&right.project_id))
    });
    projects.dedup_by(|left, right| left.project_id == right.project_id);
    Ok(projects)
}

pub(super) async fn resolve_project_by_id(
    app: &AppState,
    project_id: &str,
    access_token: &str,
) -> Result<CloudProjectOption, String> {
    resolve_project_resource(app, &format!("projects/{project_id}"), access_token).await
}

pub(super) async fn resolve_project_resource(
    app: &AppState,
    resource: &str,
    access_token: &str,
) -> Result<CloudProjectOption, String> {
    let response = app
        .client
        .get(format!(
            "https://cloudresourcemanager.googleapis.com/v3/{resource}"
        ))
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|error| format!("Google Cloud project lookup failed: {error}"))?;
    let status = response.status();
    let body = read_google_body(response).await?;
    if status == StatusCode::NOT_FOUND {
        return Err("Google Cloud could not find that project.".into());
    }
    if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN {
        return Err("The signed-in Google account cannot view that Cloud project.".into());
    }
    if !status.is_success() {
        return Err(format!(
            "Google Cloud project lookup returned HTTP {}.",
            status.as_u16()
        ));
    }
    let project: ProjectResponse = serde_json::from_str(&body)
        .map_err(|_| String::from("Google returned invalid project information."))?;
    project_option(project).ok_or_else(|| "The selected Google Cloud project is not active.".into())
}

pub(super) fn project_option(project: ProjectResponse) -> Option<CloudProjectOption> {
    if project
        .state
        .as_deref()
        .is_some_and(|state| state != "ACTIVE")
    {
        return None;
    }
    let project_number = project.name.strip_prefix("projects/")?.trim().to_string();
    if project_number.is_empty() || project.project_id.trim().is_empty() {
        return None;
    }
    let display_name = project
        .display_name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(project.project_id.as_str())
        .to_string();
    Some(CloudProjectOption {
        project_id: project.project_id,
        project_number,
        display_name,
    })
}

pub(super) fn validate_project_id(value: &str) -> Result<String, String> {
    let value = value.trim();
    let valid_length = (6..=63).contains(&value.len());
    let valid_edges = value.as_bytes().first().is_some_and(u8::is_ascii_lowercase)
        && value
            .as_bytes()
            .last()
            .is_some_and(|value| value.is_ascii_lowercase() || value.is_ascii_digit());
    let valid_characters = value
        .bytes()
        .all(|value| value.is_ascii_lowercase() || value.is_ascii_digit() || value == b'-');
    if !valid_length || !valid_edges || !valid_characters {
        return Err("Google returned an invalid Cloud project ID.".into());
    }
    Ok(value.to_string())
}

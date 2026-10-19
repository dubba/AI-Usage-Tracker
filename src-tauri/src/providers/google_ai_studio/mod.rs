use crate::{
    google_client::{client_secret, CLIENT_ID, TOKEN_URL},
    model::{
        now_rfc3339, Account, GoogleAiStudioSecret, OAuthSecret, Provider, ProviderSecret,
        UsageFreshness, UsageSnapshot, UsageWindow,
    },
    oauth_common::{merge_into_existing, ConnectedFields},
    providers::{
        classify_status,
        oauth_refresh::{
            refresh_oauth_secret, IdToken, InvalidGrant, Lifetime, RefreshBody, RefreshRequest,
        },
        save_refreshed, Forbidden, ProviderError, ProviderUsage, StatusPolicy, REFRESH_SKEW_SECS,
    },
    state::AppState,
};
use chrono::{DateTime, Datelike, Duration, NaiveDate, TimeZone, Utc, Weekday};
use reqwest::RequestBuilder;
use serde::{de::DeserializeOwned, Deserialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap},
    sync::Arc,
};

mod quota;

use quota::*;

#[cfg(test)]
mod tests;
const MODELS_URL: &str = "https://generativelanguage.googleapis.com/v1beta/models";
const MONITORING_BASE: &str = "https://monitoring.googleapis.com/v3";
const METRIC_PREFIX: &str = "generativelanguage.googleapis.com/quota/";
/// The `source` strings of a Google AI Studio usage snapshot. The frontend spells them the
/// same (`usage-sources.ts`); `frontend_contract.rs` checks that they agree.
pub(crate) const SOURCE_MODELS_ONLY: &str = "google_ai_studio_model_access";
pub(crate) const SOURCE_MONITORING_WAITING: &str = "google_ai_studio_monitoring_waiting";
pub(crate) const SOURCE_MONITORING: &str = "google_ai_studio_cloud_monitoring";
const ACCOUNT_EMAIL: &str = "Google AI Studio API key";
const ACCOUNT_PLAN: &str = "Google AI Studio";
const MAX_SELECTED_MODELS: usize = 200;
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelsPage {
    #[serde(default)]
    models: Vec<GoogleModel>,
    next_page_token: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GoogleModel {
    name: String,
    display_name: Option<String>,
    #[serde(default)]
    supported_generation_methods: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct TrackableModel {
    name: String,
    label: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MetricDescriptorPage {
    #[serde(default)]
    metric_descriptors: Vec<MetricDescriptor>,
    next_page_token: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
struct MetricDescriptor {
    #[serde(rename = "type")]
    metric_type: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TimeSeriesPage {
    #[serde(default)]
    time_series: Vec<MonitoringTimeSeries>,
    next_page_token: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
struct MonitoringTimeSeries {
    metric: MonitoringMetric,
    #[serde(default)]
    points: Vec<MonitoringPoint>,
}

#[derive(Clone, Debug, Deserialize)]
struct MonitoringMetric {
    #[serde(default)]
    labels: HashMap<String, String>,
}

#[derive(Clone, Debug, Deserialize)]
struct MonitoringPoint {
    interval: MonitoringInterval,
    value: Value,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MonitoringInterval {
    end_time: Option<String>,
}

pub async fn probe_account(
    state: Arc<AppState>,
    label: String,
    api_key: String,
) -> Result<Account, String> {
    let api_key = validate_api_key(&api_key)?;
    let models = list_models(state.as_ref(), &api_key)
        .await
        .map_err(|error| error.to_string())?;
    if models.is_empty() {
        return Err(
            "Google returned no models that support generateContent for this API key.".into(),
        );
    }

    let now = now_rfc3339();
    let mut account = Account {
        id: "google-ai-studio-probe".into(),
        label: normalized_label(&label),
        provider: Provider::GoogleAiStudio,
        email: Some(ACCOUNT_EMAIL.into()),
        provider_account_id: None,
        chatgpt_account_id: None,
        plan: Some(ACCOUNT_PLAN.into()),
        created_at: now.clone(),
        updated_at: now.clone(),
        last_usage: Some(UsageSnapshot {
            plan: Some(ACCOUNT_PLAN.into()),
            email: Some(ACCOUNT_EMAIL.into()),
            windows: model_windows(models),
            credits_usd: None,
            unlimited_credits: false,
            fetched_at: now,
            freshness: UsageFreshness::Live,
            source: SOURCE_MODELS_ONLY.into(),
        }),
        last_error: None,
        auth_required: false,
    };
    account.classify_windows();
    Ok(account)
}

pub async fn add_account(
    state: Arc<AppState>,
    label: String,
    api_key: String,
    selected_models: Vec<String>,
) -> Result<Account, String> {
    let api_key = validate_api_key(&api_key)?;
    let selected_models = validate_selected_models(selected_models)?;
    let available_models = list_models(state.as_ref(), &api_key)
        .await
        .map_err(|error| error.to_string())?;
    let available_by_name: HashMap<&str, &TrackableModel> = available_models
        .iter()
        .map(|model| (model.name.as_str(), model))
        .collect();

    let unavailable = selected_models
        .iter()
        .filter(|name| !available_by_name.contains_key(name.as_str()))
        .cloned()
        .collect::<Vec<_>>();
    if !unavailable.is_empty() {
        return Err(format!(
            "Google did not return {} selected model{} for this API key. Load the model list again and reselect them.",
            unavailable.len(),
            if unavailable.len() == 1 { "" } else { "s" },
        ));
    }

    let selected = selected_models
        .iter()
        .filter_map(|name| available_by_name.get(name.as_str()).copied().cloned())
        .collect::<Vec<_>>();
    let provider = Provider::GoogleAiStudio;
    let provider_account_id = format!("google-ai-studio:{}", key_fingerprint(&api_key));
    let duplicate = state
        .store
        .find_duplicate(&provider, Some(&provider_account_id), None)
        .or_else(|| {
            state.store.list().into_iter().find(|account| {
                account.provider == Provider::Antigravity
                    && account.provider_account_id.as_deref() == Some(provider_account_id.as_str())
            })
        });
    let existing_secret = duplicate
        .as_ref()
        .and_then(|account| crate::store::load_provider_secret(&account.id).ok())
        .and_then(|secret| match secret {
            ProviderSecret::GoogleAiStudio(secret) => Some(secret),
            _ => None,
        });
    let mut account = merge_into_existing(
        duplicate.as_ref(),
        ConnectedFields {
            label: normalized_label(&label),
            provider,
            email: duplicate
                .as_ref()
                .and_then(|account| account.email.clone())
                .or_else(|| Some(ACCOUNT_EMAIL.into())),
            provider_account_id: duplicate
                .as_ref()
                .and_then(|account| account.provider_account_id.clone())
                .or(Some(provider_account_id)),
            chatgpt_account_id: None,
            plan: Some(ACCOUNT_PLAN.into()),
        },
    );
    // A new key has not been read for quota yet; until the first refresh it only proves access.
    account.last_usage = Some(UsageSnapshot {
        plan: Some(ACCOUNT_PLAN.into()),
        email: Some(ACCOUNT_EMAIL.into()),
        windows: model_windows(selected),
        credits_usd: None,
        unlimited_credits: false,
        fetched_at: account.updated_at.clone(),
        freshness: UsageFreshness::Live,
        source: SOURCE_MODELS_ONLY.into(),
    });

    state
        .persist_connected_account(
            account,
            &ProviderSecret::GoogleAiStudio(GoogleAiStudioSecret {
                api_key,
                selected_models,
                cloud_project_id: existing_secret
                    .as_ref()
                    .and_then(|secret| secret.cloud_project_id.clone()),
                cloud_oauth: existing_secret.and_then(|secret| secret.cloud_oauth),
            }),
        )
        .await
        .map_err(|error| error.to_string())
}

pub async fn refresh(
    app: &AppState,
    account: &Account,
    mut secret: GoogleAiStudioSecret,
) -> Result<(ProviderUsage, GoogleAiStudioSecret), ProviderError> {
    let api_key = validate_api_key(&secret.api_key).map_err(ProviderError::Transient)?;
    let selected_models = validate_selected_models(secret.selected_models.clone())
        .map_err(ProviderError::Transient)?;
    let available_models = list_models(app, &api_key).await?;
    let available_by_name: HashMap<&str, &TrackableModel> = available_models
        .iter()
        .map(|model| (model.name.as_str(), model))
        .collect();
    let selected = selected_models
        .iter()
        .filter_map(|name| available_by_name.get(name.as_str()).copied().cloned())
        .collect::<Vec<_>>();

    if selected.is_empty() {
        return Err(ProviderError::Transient(
            "Google no longer returned any of the selected models for this API key.".into(),
        ));
    }

    let Some(project_id) = secret.cloud_project_id.clone() else {
        return Ok((models_only_usage(account, selected), secret));
    };
    let Some(mut oauth) = secret.cloud_oauth.clone() else {
        return Ok((models_only_usage(account, selected), secret));
    };

    // Only refreshed up front: a rejected token is not retried, as for the other providers
    // (`with_fresh_secret`), because the Cloud token sits inside the API-key secret.
    if oauth.expires_within(REFRESH_SKEW_SECS) {
        oauth = refresh_cloud_secret(app, &oauth, IdToken::KeepCurrent).await?;
        secret.cloud_oauth = Some(oauth.clone());
        save_refreshed(&account.id, ProviderSecret::GoogleAiStudio(secret.clone()))?;
    }

    let windows = fetch_cloud_usage(app, &project_id, &oauth.access_token, &selected).await?;
    let (windows, source) = if windows.is_empty() {
        (waiting_windows(selected), SOURCE_MONITORING_WAITING)
    } else {
        (windows, SOURCE_MONITORING)
    };

    Ok((
        ProviderUsage {
            plan: Some(ACCOUNT_PLAN.into()),
            email: account.email.clone().or_else(|| Some(ACCOUNT_EMAIL.into())),
            provider_account_id: Some(format!("google-ai-studio-project:{project_id}")),
            windows,
            credits_usd: None,
            unlimited_credits: false,
            source: source.into(),
        },
        secret,
    ))
}

pub async fn validate_cloud_project_access(
    app: &AppState,
    project_id: &str,
    access_token: &str,
) -> Result<(), ProviderError> {
    let _ = list_metric_descriptors(app, project_id, access_token).await?;
    Ok(())
}

fn models_only_usage(account: &Account, models: Vec<TrackableModel>) -> ProviderUsage {
    ProviderUsage {
        plan: Some(ACCOUNT_PLAN.into()),
        email: account.email.clone().or_else(|| Some(ACCOUNT_EMAIL.into())),
        provider_account_id: account.provider_account_id.clone(),
        windows: model_windows(models),
        credits_usd: None,
        unlimited_credits: false,
        source: SOURCE_MODELS_ONLY.into(),
    }
}

async fn list_models(app: &AppState, api_key: &str) -> Result<Vec<TrackableModel>, ProviderError> {
    let mut page_token: Option<String> = None;
    let mut models = Vec::new();

    loop {
        let mut request = app
            .client
            .get(MODELS_URL)
            .header("x-goog-api-key", api_key)
            .query(&[("pageSize", "1000")]);
        if let Some(token) = page_token.as_deref() {
            request = request.query(&[("pageToken", token)]);
        }

        let page: ModelsPage = google_json(request, "Google models.list").await?;
        models.extend(filter_trackable_models(page.models));
        page_token = page
            .next_page_token
            .filter(|token| !token.trim().is_empty());
        if page_token.is_none() {
            break;
        }
    }

    models.sort_by(|left, right| {
        left.label
            .to_ascii_lowercase()
            .cmp(&right.label.to_ascii_lowercase())
            .then_with(|| left.name.cmp(&right.name))
    });
    models.dedup_by(|left, right| left.name == right.name);
    Ok(models)
}

async fn fetch_cloud_usage(
    app: &AppState,
    project_id: &str,
    access_token: &str,
    selected_models: &[TrackableModel],
) -> Result<Vec<UsageWindow>, ProviderError> {
    let descriptors = list_metric_descriptors(app, project_id, access_token).await?;
    let metric_types = descriptors
        .into_iter()
        .map(|descriptor| descriptor.metric_type)
        .filter(|metric_type| supported_metric_type(metric_type))
        .collect::<Vec<_>>();
    if metric_types.is_empty() {
        return Ok(Vec::new());
    }

    let end = Utc::now();
    let start = end - Duration::hours(26);
    let mut series = Vec::new();
    for metric_type in metric_types {
        series.extend(
            query_time_series(app, project_id, access_token, &metric_type, start, end).await?,
        );
    }

    Ok(normalize_quota_windows(series, selected_models, end))
}

async fn list_metric_descriptors(
    app: &AppState,
    project_id: &str,
    access_token: &str,
) -> Result<Vec<MetricDescriptor>, ProviderError> {
    let mut page_token: Option<String> = None;
    let mut descriptors = Vec::new();
    loop {
        let mut request = app
            .client
            .get(format!(
                "{MONITORING_BASE}/projects/{project_id}/metricDescriptors"
            ))
            .bearer_auth(access_token)
            .query(&[
                (
                    "filter",
                    format!("metric.type = starts_with(\"{METRIC_PREFIX}\")"),
                ),
                ("pageSize", "10000".into()),
                ("activeOnly", "false".into()),
            ]);
        if let Some(token) = page_token.as_deref() {
            request = request.query(&[("pageToken", token)]);
        }
        let page: MetricDescriptorPage = google_json(request, "Google Cloud Monitoring").await?;
        descriptors.extend(page.metric_descriptors);
        page_token = page
            .next_page_token
            .filter(|token| !token.trim().is_empty());
        if page_token.is_none() {
            break;
        }
    }
    Ok(descriptors)
}

async fn query_time_series(
    app: &AppState,
    project_id: &str,
    access_token: &str,
    metric_type: &str,
    start: DateTime<Utc>,
    end: DateTime<Utc>,
) -> Result<Vec<QuotaSeries>, ProviderError> {
    let mut page_token: Option<String> = None;
    let mut result = Vec::new();
    loop {
        let mut request = app
            .client
            .get(format!(
                "{MONITORING_BASE}/projects/{project_id}/timeSeries"
            ))
            .bearer_auth(access_token)
            .query(&[
                ("filter", format!("metric.type = \"{metric_type}\"")),
                ("interval.startTime", start.to_rfc3339()),
                ("interval.endTime", end.to_rfc3339()),
                ("view", "FULL".into()),
                ("pageSize", "100000".into()),
            ]);
        if let Some(token) = page_token.as_deref() {
            request = request.query(&[("pageToken", token)]);
        }
        let page: TimeSeriesPage = google_json(request, "Google Cloud Monitoring").await?;
        for item in page.time_series {
            let model = item.metric.labels.get("model").cloned().unwrap_or_default();
            let limit_name = item
                .metric
                .labels
                .get("limit_name")
                .cloned()
                .unwrap_or_default();
            if model.trim().is_empty() || limit_name.trim().is_empty() {
                continue;
            }
            let points = item
                .points
                .into_iter()
                .filter_map(|point| {
                    let end_time = point.interval.end_time?.parse::<DateTime<Utc>>().ok()?;
                    let value = monitoring_value(&point.value)?;
                    value.is_finite().then_some(QuotaPoint { end_time, value })
                })
                .collect::<Vec<_>>();
            if !points.is_empty() {
                result.push(QuotaSeries {
                    metric_type: metric_type.into(),
                    model,
                    limit_name,
                    points,
                });
            }
        }
        page_token = page
            .next_page_token
            .filter(|token| !token.trim().is_empty());
        if page_token.is_none() {
            break;
        }
    }
    Ok(result)
}

fn network_error(context: &str) -> ProviderError {
    ProviderError::Transient(format!(
        "{context} could not be reached. Check your network and try again."
    ))
}

async fn google_json<T: DeserializeOwned>(
    request: RequestBuilder,
    context: &str,
) -> Result<T, ProviderError> {
    let response = request.send().await.map_err(|_| network_error(context))?;
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if let Some(error) = classify_status(
        "Google",
        status,
        None,
        &StatusPolicy {
            forbidden: Forbidden::Transient(
                "Google Cloud denied Monitoring access. Confirm the project ID, enable the Cloud Monitoring API, and grant this Google account Monitoring Viewer access.",
            ),
            rate_limits: false,
            other: Box::new(|status| format!("{context} returned HTTP {}.", status.as_u16())),
        },
    ) {
        return Err(error);
    }
    serde_json::from_str(&body)
        .map_err(|_| ProviderError::Transient(format!("{context} returned unreadable data.")))
}

/// Refreshes the Google Cloud authorization used for quota reads. Also called while connecting,
/// where the new `id_token` is wanted; day-to-day refreshes keep the stored one.
pub(crate) async fn refresh_cloud_secret(
    app: &AppState,
    secret: &OAuthSecret,
    id_token: IdToken,
) -> Result<OAuthSecret, ProviderError> {
    let client_secret = client_secret();
    refresh_oauth_secret(
        RefreshRequest {
            client: &app.client,
            provider: "Google",
            url: TOKEN_URL,
            body: RefreshBody::Form(&[
                ("client_id", CLIENT_ID),
                ("client_secret", client_secret.as_str()),
                ("refresh_token", secret.refresh_token.as_str()),
                ("grant_type", "refresh_token"),
            ]),
            invalid_grant: InvalidGrant::AnyStatus,
            lifetime: Lifetime::DefaultsToOneHour,
            id_token,
        },
        secret,
    )
    .await
}

fn filter_trackable_models(models: Vec<GoogleModel>) -> Vec<TrackableModel> {
    models
        .into_iter()
        .filter(|model| {
            model
                .supported_generation_methods
                .iter()
                .any(|method| method == "generateContent")
        })
        .filter_map(|model| {
            let name = model.name.trim().to_string();
            if name.is_empty() {
                return None;
            }
            let label = model
                .display_name
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
                .unwrap_or_else(|| name.trim_start_matches("models/").to_string());
            Some(TrackableModel { name, label })
        })
        .collect()
}

fn model_windows(models: Vec<TrackableModel>) -> Vec<UsageWindow> {
    models
        .into_iter()
        .map(|model| UsageWindow {
            id: model.name,
            label: model.label,
            used_percent: None,
            remaining_percent: None,
            resets_at: None,
            window_seconds: None,
            kind: None,
        })
        .collect()
}

fn waiting_windows(models: Vec<TrackableModel>) -> Vec<UsageWindow> {
    models
        .into_iter()
        .map(|model| UsageWindow {
            id: format!("{}:waiting", model.name),
            label: model.label,
            used_percent: None,
            remaining_percent: None,
            resets_at: None,
            window_seconds: None,
            kind: None,
        })
        .collect()
}

fn validate_api_key(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.len() < 20 || value.len() > 512 || value.chars().any(char::is_whitespace) {
        return Err("Enter a valid Google AI Studio API key.".into());
    }
    Ok(value.to_string())
}

fn validate_selected_models(values: Vec<String>) -> Result<Vec<String>, String> {
    let mut result = Vec::new();
    for value in values {
        let value = value.trim();
        if value.is_empty() || value.len() > 256 || !value.starts_with("models/") {
            return Err("The selected Google model list is invalid. Load the models again.".into());
        }
        if !result.iter().any(|existing| existing == value) {
            result.push(value.to_string());
        }
    }
    if result.is_empty() {
        return Err("Select at least one Google model to track.".into());
    }
    if result.len() > MAX_SELECTED_MODELS {
        return Err(format!(
            "Select no more than {MAX_SELECTED_MODELS} Google models."
        ));
    }
    Ok(result)
}

fn normalized_label(value: &str) -> String {
    let value = value.trim();
    if value.is_empty() {
        "Google AI Studio".into()
    } else {
        value.to_string()
    }
}

fn key_fingerprint(api_key: &str) -> String {
    Sha256::digest(api_key.as_bytes())
        .iter()
        .take(8)
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

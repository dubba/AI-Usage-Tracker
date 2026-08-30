use crate::{
    model::{
        now_rfc3339, Account, GoogleAiStudioSecret, OAuthSecret, Provider, ProviderSecret,
        UsageFreshness, UsageSnapshot, UsageWindow,
    },
    providers::{ProviderError, ProviderUsage},
    state::AppState,
};
use chrono::{DateTime, Datelike, Duration, NaiveDate, TimeZone, Utc, Weekday};
use reqwest::{RequestBuilder, StatusCode};
use serde::{de::DeserializeOwned, Deserialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap},
    sync::Arc,
};
use uuid::Uuid;

const MODELS_URL: &str = "https://generativelanguage.googleapis.com/v1beta/models";
const MONITORING_BASE: &str = "https://monitoring.googleapis.com/v3";
const METRIC_PREFIX: &str = "generativelanguage.googleapis.com/quota/";
const SOURCE_MODELS_ONLY: &str = "google_ai_studio_model_access";
const SOURCE_MONITORING_WAITING: &str = "google_ai_studio_monitoring_waiting";
const SOURCE_MONITORING: &str = "google_ai_studio_cloud_monitoring";
const ACCOUNT_EMAIL: &str = "Google AI Studio API key";
const ACCOUNT_PLAN: &str = "Google AI Studio";
const MAX_SELECTED_MODELS: usize = 200;
const GOOGLE_CLIENT_ID: &str =
    "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
const GOOGLE_CLIENT_SECRET_BYTES: &[u8] = &[
    71, 79, 67, 83, 80, 88, 45, 75, 53, 56, 70, 87, 82, 52, 56, 54, 76, 100, 76, 74, 49, 109, 76,
    66, 56, 115, 88, 67, 52, 122, 54, 113, 68, 65, 102,
];
const KNOWN_QUOTA_FAMILIES: &[&str] = &[
    "generate_content_free_tier_requests",
    "generate_content_free_tier_input_token_count",
    "generate_requests_per_model",
    "generate_content_paid_tier_input_token_count",
    "generate_content_paid_tier_2_requests",
    "generate_content_paid_tier_2_input_token_count",
    "generate_content_paid_tier_3_requests",
    "generate_content_paid_tier_3_input_token_count",
];

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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OAuthRefreshResponse {
    access_token: String,
    refresh_token: Option<String>,
    expires_in: Option<i64>,
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

#[derive(Clone, Debug)]
struct QuotaPoint {
    end_time: DateTime<Utc>,
    value: f64,
}

#[derive(Clone, Debug)]
struct QuotaSeries {
    metric_type: String,
    model: String,
    limit_name: String,
    points: Vec<QuotaPoint>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum QuotaKind {
    Rpm,
    Tpm,
    Rpd,
    Tpd,
}

impl QuotaKind {
    fn label(self) -> &'static str {
        match self {
            Self::Rpm => "RPM",
            Self::Tpm => "TPM",
            Self::Rpd => "RPD",
            Self::Tpd => "TPD",
        }
    }

    fn window_seconds(self) -> u64 {
        match self {
            Self::Rpm | Self::Tpm => 60,
            Self::Rpd | Self::Tpd => 86_400,
        }
    }

    fn is_daily(self) -> bool {
        matches!(self, Self::Rpd | Self::Tpd)
    }
}

#[derive(Default)]
struct QuotaBucket {
    usage_points: Vec<QuotaPoint>,
    limit: Option<f64>,
}

struct WindowCandidate {
    window: UsageWindow,
    limit: f64,
    model_label: String,
    kind: QuotaKind,
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
    Ok(Account {
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
    })
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
    let now = now_rfc3339();
    let account = Account {
        id: duplicate
            .as_ref()
            .map(|account| account.id.clone())
            .unwrap_or_else(|| Uuid::new_v4().to_string()),
        label: normalized_label(&label),
        provider,
        email: duplicate
            .as_ref()
            .and_then(|account| account.email.clone())
            .or_else(|| Some(ACCOUNT_EMAIL.into())),
        provider_account_id: duplicate
            .as_ref()
            .and_then(|account| account.provider_account_id.clone())
            .or_else(|| Some(provider_account_id)),
        chatgpt_account_id: None,
        plan: Some(ACCOUNT_PLAN.into()),
        created_at: duplicate
            .as_ref()
            .map(|account| account.created_at.clone())
            .unwrap_or_else(|| now.clone()),
        updated_at: now.clone(),
        last_usage: Some(UsageSnapshot {
            plan: Some(ACCOUNT_PLAN.into()),
            email: Some(ACCOUNT_EMAIL.into()),
            windows: model_windows(selected),
            credits_usd: None,
            unlimited_credits: false,
            fetched_at: now,
            freshness: UsageFreshness::Live,
            source: SOURCE_MODELS_ONLY.into(),
        }),
        last_error: None,
        auth_required: false,
    };

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

    if oauth.expires_within(300) {
        oauth = refresh_cloud_secret(app, oauth).await?;
        secret.cloud_oauth = Some(oauth.clone());
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

async fn google_json<T: DeserializeOwned>(
    request: RequestBuilder,
    context: &str,
) -> Result<T, ProviderError> {
    let response = request
        .send()
        .await
        .map_err(|error| ProviderError::Transient(format!("{context} request failed: {error}")))?;
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if status == StatusCode::UNAUTHORIZED {
        return Err(ProviderError::Auth);
    }
    if status == StatusCode::FORBIDDEN {
        return Err(ProviderError::Transient(
            "Google Cloud denied Monitoring access. Confirm the project ID, enable the Cloud Monitoring API, and grant this Google account Monitoring Viewer access.".into(),
        ));
    }
    if !status.is_success() {
        return Err(ProviderError::Transient(format!(
            "{context} returned HTTP {}.",
            status.as_u16()
        )));
    }
    serde_json::from_str(&body).map_err(|error| {
        ProviderError::Transient(format!("{context} returned unreadable data: {error}"))
    })
}

async fn refresh_cloud_secret(
    app: &AppState,
    secret: OAuthSecret,
) -> Result<OAuthSecret, ProviderError> {
    let client_secret = String::from_utf8_lossy(GOOGLE_CLIENT_SECRET_BYTES).to_string();
    let response = app
        .client
        .post("https://oauth2.googleapis.com/token")
        .form(&[
            ("client_id", GOOGLE_CLIENT_ID),
            ("client_secret", client_secret.as_str()),
            ("refresh_token", secret.refresh_token.as_str()),
            ("grant_type", "refresh_token"),
        ])
        .send()
        .await
        .map_err(|error| {
            ProviderError::Transient(format!("Google token refresh failed: {error}"))
        })?;
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if status == StatusCode::UNAUTHORIZED
        || status == StatusCode::FORBIDDEN
        || body.to_ascii_lowercase().contains("invalid_grant")
    {
        return Err(ProviderError::Auth);
    }
    if !status.is_success() {
        return Err(ProviderError::Transient(format!(
            "Google token refresh returned HTTP {}.",
            status.as_u16()
        )));
    }
    let tokens: OAuthRefreshResponse = serde_json::from_str(&body).map_err(|error| {
        ProviderError::Transient(format!("Google returned an invalid token refresh: {error}"))
    })?;
    Ok(OAuthSecret {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token.unwrap_or(secret.refresh_token),
        id_token: secret.id_token,
        expires_at: Utc::now().timestamp_millis() + tokens.expires_in.unwrap_or(3600) * 1000,
    })
}

fn normalize_quota_windows(
    series: Vec<QuotaSeries>,
    selected_models: &[TrackableModel],
    now: DateTime<Utc>,
) -> Vec<UsageWindow> {
    let mut buckets: BTreeMap<(String, String, String), QuotaBucket> = BTreeMap::new();
    for item in series {
        let Some(base) = metric_base(&item.metric_type) else {
            continue;
        };
        let Some(selected) = match_selected_model(&item.model, selected_models) else {
            continue;
        };
        let key = (
            selected.name.clone(),
            base.to_string(),
            item.limit_name.clone(),
        );
        let bucket = buckets.entry(key).or_default();
        if item.metric_type.ends_with("/usage") {
            bucket.usage_points.extend(item.points);
        } else if item.metric_type.ends_with("/limit") {
            let latest = item
                .points
                .iter()
                .max_by_key(|point| point.end_time)
                .map(|point| point.value);
            if let Some(value) = latest.filter(|value| *value > 0.0) {
                bucket.limit = Some(bucket.limit.map_or(value, |current| current.max(value)));
            }
        }
    }

    let selected_by_name = selected_models
        .iter()
        .map(|model| (model.name.as_str(), model))
        .collect::<HashMap<_, _>>();
    let mut best: BTreeMap<(String, QuotaKind), WindowCandidate> = BTreeMap::new();
    for ((model_name, base, limit_name), bucket) in buckets {
        let Some(limit) = bucket.limit.filter(|limit| *limit > 0.0) else {
            continue;
        };
        let Some(kind) = classify_quota(&base, &limit_name) else {
            continue;
        };
        let Some(model) = selected_by_name.get(model_name.as_str()) else {
            continue;
        };
        if bucket.usage_points.is_empty() {
            continue;
        }
        let used = usage_for_window(&bucket.usage_points, kind, now).max(0.0);
        let used_percent = (used / limit * 100.0).clamp(0.0, 100.0);
        let window = UsageWindow {
            id: format!("{}:{}", model.name, kind.label().to_ascii_lowercase()),
            label: format!("{} · {}", model.label, kind.label()),
            used_percent: Some(used_percent),
            remaining_percent: Some((100.0 - used_percent).clamp(0.0, 100.0)),
            resets_at: kind
                .is_daily()
                .then(|| next_pacific_midnight(now).to_rfc3339()),
            window_seconds: Some(kind.window_seconds()),
        };
        let key = (model.name.clone(), kind);
        let candidate = WindowCandidate {
            window,
            limit,
            model_label: model.label.clone(),
            kind,
        };
        match best.get(&key) {
            Some(existing) if existing.limit >= candidate.limit => {}
            _ => {
                best.insert(key, candidate);
            }
        }
    }

    let mut candidates = best.into_values().collect::<Vec<_>>();
    candidates.sort_by(|left, right| {
        left.model_label
            .to_ascii_lowercase()
            .cmp(&right.model_label.to_ascii_lowercase())
            .then_with(|| left.kind.cmp(&right.kind))
    });
    candidates
        .into_iter()
        .map(|candidate| candidate.window)
        .collect()
}

fn usage_for_window(points: &[QuotaPoint], kind: QuotaKind, now: DateTime<Utc>) -> f64 {
    if points.is_empty() {
        return 0.0;
    }
    let start = if kind.is_daily() {
        current_pacific_midnight(now)
    } else {
        let latest = points
            .iter()
            .map(|point| point.end_time)
            .max()
            .unwrap_or(now);
        latest - Duration::seconds(kind.window_seconds() as i64)
    };
    points
        .iter()
        .filter(|point| point.end_time > start)
        .map(|point| point.value)
        .sum()
}

fn classify_quota(metric_base: &str, limit_name: &str) -> Option<QuotaKind> {
    let value = format!("{metric_base} {limit_name}").to_ascii_lowercase();
    let tokens = metric_base.contains("token");
    let daily = ["per_day", "per-day", "perday", "daily", " day"]
        .iter()
        .any(|needle| value.contains(needle));
    let minute = [
        "per_minute",
        "per-minute",
        "perminute",
        "minute",
        "rpm",
        "tpm",
    ]
    .iter()
    .any(|needle| value.contains(needle));
    match (tokens, daily, minute) {
        (false, true, _) => Some(QuotaKind::Rpd),
        (true, true, _) => Some(QuotaKind::Tpd),
        (false, false, true) => Some(QuotaKind::Rpm),
        (true, false, true) => Some(QuotaKind::Tpm),
        _ => None,
    }
}

fn metric_base(metric_type: &str) -> Option<&str> {
    let value = metric_type.strip_prefix(METRIC_PREFIX)?;
    value
        .strip_suffix("/usage")
        .or_else(|| value.strip_suffix("/limit"))
}

fn supported_metric_type(metric_type: &str) -> bool {
    let Some(base) = metric_base(metric_type) else {
        return false;
    };
    KNOWN_QUOTA_FAMILIES.contains(&base)
}

fn match_selected_model<'a>(
    candidate: &str,
    selected: &'a [TrackableModel],
) -> Option<&'a TrackableModel> {
    let candidate = canonical_model(candidate);
    selected.iter().find(|model| {
        let selected = canonical_model(&model.name);
        candidate == selected || candidate.ends_with(&selected) || selected.ends_with(&candidate)
    })
}

fn canonical_model(value: &str) -> String {
    value
        .trim()
        .trim_start_matches("models/")
        .trim_start_matches("publishers/google/models/")
        .to_ascii_lowercase()
}

fn monitoring_value(value: &Value) -> Option<f64> {
    value
        .get("int64Value")
        .and_then(|value| {
            value
                .as_str()
                .and_then(|value| value.parse::<f64>().ok())
                .or_else(|| value.as_i64().map(|value| value as f64))
        })
        .or_else(|| value.get("doubleValue").and_then(Value::as_f64))
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

fn current_pacific_midnight(now: DateTime<Utc>) -> DateTime<Utc> {
    let offset = pacific_offset_seconds(now);
    let local = now + Duration::seconds(offset as i64);
    pacific_midnight_utc(local.date_naive())
}

fn next_pacific_midnight(now: DateTime<Utc>) -> DateTime<Utc> {
    let offset = pacific_offset_seconds(now);
    let local = now + Duration::seconds(offset as i64);
    let next = local.date_naive().succ_opt().unwrap_or(local.date_naive());
    pacific_midnight_utc(next)
}

fn pacific_midnight_utc(date: NaiveDate) -> DateTime<Utc> {
    let offset = pacific_midnight_offset_seconds(date);
    let local_midnight = date.and_hms_opt(0, 0, 0).expect("valid midnight");
    Utc.from_utc_datetime(&(local_midnight - Duration::seconds(offset as i64)))
}

fn pacific_offset_seconds(now: DateTime<Utc>) -> i32 {
    let year = now.year();
    let start = nth_weekday_of_month(year, 3, Weekday::Sun, 2)
        .and_hms_opt(10, 0, 0)
        .map(|value| Utc.from_utc_datetime(&value))
        .expect("valid DST start");
    let end = nth_weekday_of_month(year, 11, Weekday::Sun, 1)
        .and_hms_opt(9, 0, 0)
        .map(|value| Utc.from_utc_datetime(&value))
        .expect("valid DST end");
    if now >= start && now < end {
        -7 * 3600
    } else {
        -8 * 3600
    }
}

fn pacific_midnight_offset_seconds(date: NaiveDate) -> i32 {
    let start = nth_weekday_of_month(date.year(), 3, Weekday::Sun, 2);
    let end = nth_weekday_of_month(date.year(), 11, Weekday::Sun, 1);
    if (date > start && date < end) || date == end {
        -7 * 3600
    } else {
        -8 * 3600
    }
}

fn nth_weekday_of_month(year: i32, month: u32, weekday: Weekday, occurrence: u32) -> NaiveDate {
    let first = NaiveDate::from_ymd_opt(year, month, 1).expect("valid month");
    let days = (7 + weekday.num_days_from_monday() as i64
        - first.weekday().num_days_from_monday() as i64)
        % 7;
    first + Duration::days(days + 7 * (occurrence.saturating_sub(1)) as i64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_only_generate_content_models() {
        let models = filter_trackable_models(vec![
            GoogleModel {
                name: "models/gemini-test".into(),
                display_name: Some("Gemini Test".into()),
                supported_generation_methods: vec!["generateContent".into()],
            },
            GoogleModel {
                name: "models/embedding-test".into(),
                display_name: Some("Embedding Test".into()),
                supported_generation_methods: vec!["embedContent".into()],
            },
        ]);
        assert_eq!(
            models,
            vec![TrackableModel {
                name: "models/gemini-test".into(),
                label: "Gemini Test".into(),
            }]
        );
    }

    #[test]
    fn classifies_google_quota_windows() {
        assert_eq!(
            classify_quota(
                "generate_content_free_tier_requests",
                "GenerateRequestsPerModelPerMinute-FreeTier",
            ),
            Some(QuotaKind::Rpm)
        );
        assert_eq!(
            classify_quota(
                "generate_content_free_tier_input_token_count",
                "GenerateContentInputTokensPerModelPerMinute-FreeTier",
            ),
            Some(QuotaKind::Tpm)
        );
        assert_eq!(
            classify_quota(
                "generate_content_free_tier_requests",
                "GenerateRequestsPerModelPerDay-FreeTier",
            ),
            Some(QuotaKind::Rpd)
        );
    }

    #[test]
    fn matches_monitoring_model_labels_to_models_list_names() {
        let models = vec![TrackableModel {
            name: "models/gemini-3.1-flash-lite".into(),
            label: "Gemini 3.1 Flash Lite".into(),
        }];
        assert_eq!(
            match_selected_model("gemini-3.1-flash-lite", &models).map(|model| model.name.as_str()),
            Some("models/gemini-3.1-flash-lite")
        );
    }

    #[test]
    fn pacific_daily_window_uses_midnight_and_handles_dst() {
        let summer = "2026-07-27T12:00:00Z".parse::<DateTime<Utc>>().unwrap();
        assert_eq!(
            current_pacific_midnight(summer).to_rfc3339(),
            "2026-07-27T07:00:00+00:00"
        );
        let winter = "2026-01-27T12:00:00Z".parse::<DateTime<Utc>>().unwrap();
        assert_eq!(
            current_pacific_midnight(winter).to_rfc3339(),
            "2026-01-27T08:00:00+00:00"
        );
    }

    #[test]
    fn fingerprint_does_not_store_the_key() {
        let fingerprint = key_fingerprint("abcdefghijklmnopqrstuvwxyz123456");
        assert_eq!(fingerprint.len(), 16);
        assert!(!fingerprint.contains("abcdef"));
    }
}

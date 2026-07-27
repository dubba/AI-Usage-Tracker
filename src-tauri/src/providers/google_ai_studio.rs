use crate::{
    model::{
        now_rfc3339, Account, GoogleAiStudioSecret, Provider, ProviderSecret, UsageFreshness,
        UsageSnapshot, UsageWindow,
    },
    providers::{ProviderError, ProviderUsage},
    state::AppState,
    store::save_provider_secret,
};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{collections::HashMap, sync::Arc};
use uuid::Uuid;

const MODELS_URL: &str = "https://generativelanguage.googleapis.com/v1beta/models";
const SOURCE_NAME: &str = "Google Gemini API models.list";
const ACCOUNT_EMAIL: &str = "Google AI Studio API key";
const ACCOUNT_PLAN: &str = "Google AI Studio API key (testing)";
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
        return Err("Google returned no models that support generateContent for this API key.".into());
    }

    let now = now_rfc3339();
    Ok(Account {
        id: "google-ai-studio-probe".into(),
        label: normalized_label(&label),
        provider: Provider::Antigravity,
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
            source: SOURCE_NAME.into(),
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

    let selected_windows = selected_models
        .iter()
        .filter_map(|name| available_by_name.get(name.as_str()).copied().cloned())
        .collect::<Vec<_>>();
    let provider = Provider::Antigravity;
    let provider_account_id = format!("google-ai-studio:{}", key_fingerprint(&api_key));
    let duplicate = state
        .store
        .find_duplicate(&provider, Some(&provider_account_id), None);
    let now = now_rfc3339();
    let account = Account {
        id: duplicate
            .as_ref()
            .map(|account| account.id.clone())
            .unwrap_or_else(|| Uuid::new_v4().to_string()),
        label: normalized_label(&label),
        provider,
        email: Some(ACCOUNT_EMAIL.into()),
        provider_account_id: Some(provider_account_id),
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
            windows: model_windows(selected_windows),
            credits_usd: None,
            unlimited_credits: false,
            fetched_at: now,
            freshness: UsageFreshness::Live,
            source: SOURCE_NAME.into(),
        }),
        last_error: None,
        auth_required: false,
    };

    save_provider_secret(
        &account.id,
        &ProviderSecret::GoogleAiStudio(GoogleAiStudioSecret {
            api_key,
            selected_models,
        }),
    )
    .map_err(|error| error.to_string())?;

    state.store.upsert(account).map_err(|error| error.to_string())
}

pub async fn refresh(
    app: &AppState,
    account: &Account,
    secret: &GoogleAiStudioSecret,
) -> Result<ProviderUsage, ProviderError> {
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

    Ok(ProviderUsage {
        plan: Some(ACCOUNT_PLAN.into()),
        email: Some(ACCOUNT_EMAIL.into()),
        provider_account_id: account.provider_account_id.clone(),
        windows: model_windows(selected),
        credits_usd: None,
        unlimited_credits: false,
        source: SOURCE_NAME.into(),
    })
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

        let response = request
            .send()
            .await
            .map_err(|error| ProviderError::Transient(format!("Unable to contact Google: {error}")))?;
        let status = response.status();
        let body = response
            .text()
            .await
            .map_err(|error| ProviderError::Transient(format!("Unable to read Google's model response: {error}")))?;
        if !status.is_success() {
            let message = if matches!(status.as_u16(), 400 | 401 | 403) {
                "Google rejected this AI Studio API key. Check that it is valid and enabled for the Gemini API.".into()
            } else if status.as_u16() == 429 {
                "Google temporarily rate-limited the model-list request. Try refreshing again later.".into()
            } else {
                format!("Google models.list returned HTTP {}.", status.as_u16())
            };
            return Err(ProviderError::Transient(message));
        }

        let page: ModelsPage = serde_json::from_str(&body).map_err(|error| {
            ProviderError::Transient(format!("Google returned an unreadable model list: {error}"))
        })?;
        models.extend(filter_trackable_models(page.models));
        page_token = page.next_page_token.filter(|token| !token.trim().is_empty());
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
        return Err(format!("Select no more than {MAX_SELECTED_MODELS} Google models."));
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
    fn selected_models_are_deduplicated_without_changing_order() {
        assert_eq!(
            validate_selected_models(vec![
                "models/gemini-b".into(),
                "models/gemini-a".into(),
                "models/gemini-b".into(),
            ])
            .unwrap(),
            vec!["models/gemini-b", "models/gemini-a"]
        );
    }

    #[test]
    fn fingerprint_does_not_store_the_key() {
        let fingerprint = key_fingerprint("abcdefghijklmnopqrstuvwxyz123456");
        assert_eq!(fingerprint.len(), 16);
        assert!(!fingerprint.contains("abcdef"));
    }
}

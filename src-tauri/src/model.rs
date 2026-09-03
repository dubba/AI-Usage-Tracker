use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::{fmt, str::FromStr};

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Provider {
    #[default]
    Openai,
    Anthropic,
    Antigravity,
    GoogleAiStudio,
    Grok,
    OpencodeGo,
}

impl Provider {
    pub fn id(&self) -> &'static str {
        match self {
            Self::Openai => "openai",
            Self::Anthropic => "anthropic",
            Self::Antigravity => "antigravity",
            Self::GoogleAiStudio => "google_ai_studio",
            Self::Grok => "grok",
            Self::OpencodeGo => "opencode_go",
        }
    }

    pub fn display_name(&self) -> &'static str {
        match self {
            Self::Openai => "GPT/Codex",
            Self::Anthropic => "Claude",
            Self::Antigravity => "Antigravity",
            Self::GoogleAiStudio => "AI Studio",
            Self::Grok => "Grok/Cursor",
            Self::OpencodeGo => "OpenCode Go",
        }
    }
}

impl fmt::Display for Provider {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.id())
    }
}

impl FromStr for Provider {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value.trim().to_ascii_lowercase().replace('-', "_").as_str() {
            "openai" | "codex" | "codex/gpt" | "gpt/codex" | "gpt" => Ok(Self::Openai),
            "anthropic" | "claude" => Ok(Self::Anthropic),
            "antigravity" | "google_antigravity" => Ok(Self::Antigravity),
            "google_ai_studio" | "ai_studio" | "gemini_api" => Ok(Self::GoogleAiStudio),
            "google" => Ok(Self::Antigravity),
            "grok" | "xai" | "supergrok" | "super_grok" | "grok/cursor" | "cursor" => Ok(Self::Grok),
            "opencode_go" | "opencode" | "go" => Ok(Self::OpencodeGo),
            _ => Err("Unsupported provider.".into()),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageWindow {
    pub id: String,
    pub label: String,
    pub used_percent: Option<f64>,
    pub remaining_percent: Option<f64>,
    pub resets_at: Option<String>,
    pub window_seconds: Option<u64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSnapshot {
    pub plan: Option<String>,
    pub email: Option<String>,
    pub windows: Vec<UsageWindow>,
    pub credits_usd: Option<f64>,
    pub unlimited_credits: bool,
    pub fetched_at: String,
    pub freshness: UsageFreshness,
    pub source: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum UsageFreshness {
    Live,
    Stale,
    Unavailable,
    AuthRequired,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub provider: Provider,
    pub email: Option<String>,
    #[serde(default)]
    pub provider_account_id: Option<String>,
    #[serde(default)]
    pub chatgpt_account_id: Option<String>,
    pub plan: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub last_usage: Option<UsageSnapshot>,
    pub last_error: Option<String>,
    pub auth_required: bool,
}

impl Account {
    pub fn touch(&mut self) {
        self.updated_at = Utc::now().to_rfc3339();
    }

    pub fn effective_account_id(&self) -> Option<&str> {
        self.provider_account_id
            .as_deref()
            .or(self.chatgpt_account_id.as_deref())
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthSecret {
    pub access_token: String,
    pub refresh_token: String,
    pub id_token: Option<String>,
    pub expires_at: i64,
}

impl OAuthSecret {
    pub fn expires_within(&self, seconds: i64) -> bool {
        self.expires_at <= Utc::now().timestamp_millis() + seconds * 1000
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenCodeGoSecret {
    pub workspace_id: String,
    pub auth_cookie: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoogleAiStudioSecret {
    pub api_key: String,
    pub selected_models: Vec<String>,
    #[serde(default)]
    pub cloud_project_id: Option<String>,
    #[serde(default)]
    pub cloud_oauth: Option<OAuthSecret>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrokSecret {
    #[serde(default)]
    pub cookie_header: Option<String>,
    #[serde(default)]
    pub auth_file: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "provider", content = "credentials", rename_all = "snake_case")]
pub enum ProviderSecret {
    Openai(OAuthSecret),
    Anthropic(OAuthSecret),
    Antigravity(OAuthSecret),
    OpencodeGo(OpenCodeGoSecret),
    GoogleAiStudio(GoogleAiStudioSecret),
    Grok(GrokSecret),
}

impl ProviderSecret {
    pub fn provider(&self) -> Provider {
        match self {
            Self::Openai(_) => Provider::Openai,
            Self::Anthropic(_) => Provider::Anthropic,
            Self::Antigravity(_) => Provider::Antigravity,
            Self::GoogleAiStudio(_) => Provider::GoogleAiStudio,
            Self::Grok(_) => Provider::Grok,
            Self::OpencodeGo(_) => Provider::OpencodeGo,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginStart {
    pub attempt_id: String,
    pub authorization_url: String,
    pub expires_at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudProjectOption {
    pub project_id: String,
    pub project_number: String,
    pub display_name: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginStatus {
    pub attempt_id: String,
    pub status: String,
    pub message: Option<String>,
    pub account: Option<Account>,
    #[serde(default)]
    pub projects: Option<Vec<CloudProjectOption>>,
    #[serde(default)]
    pub selected_project_id: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeStatus {
    pub endpoint: String,
    pub enabled: bool,
    pub running: bool,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeInfo {
    pub endpoint: String,
    pub token: String,
    pub enabled: bool,
    pub running: bool,
    pub error: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountBucket {
    pub id: String,
    pub name: String,
    pub provider: Option<Provider>,
    pub account_ids: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DashboardSnapshot {
    pub accounts: Vec<Account>,
    pub buckets: Vec<AccountBucket>,
    pub bridge: BridgeStatus,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateStatus {
    pub current_version: String,
    pub available: bool,
    pub available_version: Option<String>,
    pub date: Option<String>,
    pub body: Option<String>,
    /// Set when the check failed. `available` is always false in that case.
    pub error: Option<String>,
}

impl AppUpdateStatus {
    pub fn up_to_date(current_version: String) -> Self {
        Self {
            current_version,
            available: false,
            available_version: None,
            date: None,
            body: None,
            error: None,
        }
    }

    pub fn available(
        current_version: String,
        available_version: String,
        date: Option<String>,
        body: Option<String>,
    ) -> Self {
        Self {
            current_version,
            available: true,
            available_version: Some(available_version),
            date,
            body,
            error: None,
        }
    }

    pub fn failed(current_version: String, error: impl Into<String>) -> Self {
        Self {
            current_version,
            available: false,
            available_version: None,
            date: None,
            body: None,
            error: Some(error.into()),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicUsageAccount {
    pub id: String,
    pub label: String,
    pub provider: Provider,
    pub email: Option<String>,
    pub provider_account_id: Option<String>,
    pub plan: Option<String>,
    pub status: String,
    pub source: Option<String>,
    pub windows: Vec<UsageWindow>,
    pub credits_usd: Option<f64>,
    pub fetched_at: Option<String>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicUsageResponse {
    pub schema_version: u32,
    pub generated_at: String,
    pub accounts: Vec<PublicUsageAccount>,
}

#[cfg(test)]
#[derive(Clone, Debug)]
pub struct TokenClaims {
    pub email: Option<String>,
    pub account_id: Option<String>,
    pub plan: Option<String>,
    pub expires_at: Option<i64>,
}

pub fn now_rfc3339() -> String {
    Utc::now().to_rfc3339()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dashboard_snapshot_omits_bridge_token() {
        let snapshot = DashboardSnapshot {
            accounts: Vec::new(),
            buckets: Vec::new(),
            bridge: BridgeStatus {
                endpoint: "http://127.0.0.1:47831/v1/paseo-usage".into(),
                enabled: true,
                running: true,
                error: None,
            },
        };
        let json = serde_json::to_value(&snapshot).unwrap();
        assert!(json["bridge"].get("token").is_none());
        assert_eq!(
            json["bridge"]["endpoint"],
            "http://127.0.0.1:47831/v1/paseo-usage"
        );
    }

    #[test]
    fn app_update_status_serializes_structured_error() {
        let failed = AppUpdateStatus::failed("0.3.3".into(), "Unable to check for updates: network down");
        let json = serde_json::to_value(&failed).unwrap();
        assert_eq!(json["currentVersion"], "0.3.3");
        assert_eq!(json["available"], false);
        assert_eq!(json["availableVersion"], serde_json::Value::Null);
        assert_eq!(json["error"], "Unable to check for updates: network down");

        let current = AppUpdateStatus::up_to_date("0.3.3".into());
        let json = serde_json::to_value(&current).unwrap();
        assert_eq!(json["available"], false);
        assert_eq!(json["error"], serde_json::Value::Null);

        let newer = AppUpdateStatus::available(
            "0.3.3".into(),
            "0.3.4".into(),
            Some("2026-09-01".into()),
            Some("notes".into()),
        );
        let json = serde_json::to_value(&newer).unwrap();
        assert_eq!(json["available"], true);
        assert_eq!(json["availableVersion"], "0.3.4");
        assert_eq!(json["error"], serde_json::Value::Null);
    }
}

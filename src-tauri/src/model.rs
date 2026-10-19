use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::{fmt, str::FromStr};
use zeroize::Zeroize;

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
            Self::Openai => "ChatGPT",
            Self::Anthropic => "Claude",
            Self::Antigravity => "Antigravity",
            Self::GoogleAiStudio => "AI Studio",
            Self::Grok => "Grok",
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
            "grok" | "xai" | "supergrok" | "super_grok" | "grok/cursor" | "cursor" => {
                Ok(Self::Grok)
            }
            "opencode_go" | "opencode" | "go" => Ok(Self::OpencodeGo),
            _ => Err("Unsupported provider.".into()),
        }
    }
}

/// Length of the 5-hour and weekly usage windows. The frontend has the same two numbers
/// (`constants.ts`); `frontend_contract.rs` checks that they agree.
pub const FIVE_HOUR_WINDOW_SECONDS: u64 = 18_000;
pub const WEEKLY_WINDOW_SECONDS: u64 = 604_800;

/// The monthly window lengths providers report: about 30 days, give or take a few.
const MONTHLY_WINDOW_SECONDS: std::ops::RangeInclusive<u64> = 2_000_000..=2_700_000;

/// What a usage window measures. Providers name their windows in their own words (ids such as
/// `five_hour_2`, labels such as "Gemini models · 7-Day Limit"); this is the one place that turns
/// those into the three kinds the app has alerts, sidebar slots and styling for.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WindowKind {
    FiveHour,
    Weekly,
    Monthly,
}

/// Words that name a window, as lower-case tokens ("5-Hour" is `5`, `hour`). The kinds are tried in
/// this order, so a window that could be read two ways is the shorter one.
const KIND_PHRASES: [(WindowKind, &[&[&str]]); 3] = [
    (
        WindowKind::FiveHour,
        &[&["5h"], &["5hr"], &["5", "hour"], &["five", "hour"]],
    ),
    (
        WindowKind::Weekly,
        &[&["weekly"], &["7d"], &["7", "day"], &["seven", "day"]],
    ),
    (
        WindowKind::Monthly,
        &[&["monthly"], &["30d"], &["30", "day"], &["thirty", "day"]],
    ),
];

/// Splits on anything that is not a letter or digit, and reads "hours" and "days" as "hour" and
/// "day". Whole tokens are matched, so "15h" is not "5h" and "17d" is not "7d".
fn name_tokens(text: &str) -> Vec<String> {
    text.to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|token| !token.is_empty())
        .map(|token| match token {
            "hours" => "hour".to_string(),
            "days" => "day".to_string(),
            other => other.to_string(),
        })
        .collect()
}

fn mentions(tokens: &[String], phrase: &[&str]) -> bool {
    tokens.windows(phrase.len()).any(|run| {
        run.iter()
            .zip(phrase)
            .all(|(token, expected)| token == expected)
    })
}

impl WindowKind {
    /// The serialized name, which is also the id the alert settings use for the kind.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::FiveHour => "five_hour",
            Self::Weekly => "weekly",
            Self::Monthly => "monthly",
        }
    }

    /// The kind of a window from its id, label and length, or `None` when it is none of the three
    /// (a model's quota, say).
    pub fn classify(id: &str, label: &str, window_seconds: Option<u64>) -> Option<Self> {
        let id_tokens = name_tokens(id);
        let label_tokens = name_tokens(label);
        KIND_PHRASES.iter().find_map(|(kind, phrases)| {
            let by_length = match kind {
                Self::FiveHour => window_seconds == Some(FIVE_HOUR_WINDOW_SECONDS),
                Self::Weekly => window_seconds == Some(WEEKLY_WINDOW_SECONDS),
                Self::Monthly => {
                    window_seconds.is_some_and(|s| MONTHLY_WINDOW_SECONDS.contains(&s))
                }
            };
            let by_name = phrases
                .iter()
                .any(|phrase| mentions(&id_tokens, phrase) || mentions(&label_tokens, phrase));
            let by_id = *kind == Self::FiveHour && id.eq_ignore_ascii_case("rolling");
            (by_length || by_name || by_id).then_some(*kind)
        })
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
    /// Worked out from the fields above by [`WindowKind::classify`] wherever usage enters the app
    /// (a refresh, the account file, a pairing import), never read from a provider. Providers leave
    /// it `None`. It is for the app's own commands; the local API does not publish it.
    #[serde(default)]
    pub kind: Option<WindowKind>,
}

impl UsageWindow {
    /// Sets `kind` from the id, label and length.
    pub fn classify(&mut self) {
        self.kind = WindowKind::classify(&self.id, &self.label, self.window_seconds);
    }

    /// This window with its kind set.
    pub fn classified(mut self) -> Self {
        self.classify();
        self
    }
}

impl UsageSnapshot {
    /// Sets the kind of every window.
    pub fn classify_windows(&mut self) {
        self.windows.iter_mut().for_each(UsageWindow::classify);
    }
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
    /// Sets the kind of every window in the account's last usage.
    pub fn classify_windows(&mut self) {
        if let Some(usage) = self.last_usage.as_mut() {
            usage.classify_windows();
        }
    }

    pub fn touch(&mut self) {
        self.updated_at = Utc::now().to_rfc3339();
    }

    pub fn effective_account_id(&self) -> Option<&str> {
        self.provider_account_id
            .as_deref()
            .or(self.chatgpt_account_id.as_deref())
    }
}

/// What `{:?}` prints in place of a credential. The secret structs below
/// implement `Debug` by hand so that formatting one (a stray `{:?}`, a panic
/// message, an `assert_eq!` failure) cannot write a token or cookie anywhere.
pub(crate) const REDACTED_DEBUG: &str = "<redacted>";

fn redacted_option<T>(value: &Option<T>) -> Option<&'static str> {
    value.as_ref().map(|_| REDACTED_DEBUG)
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize, Zeroize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthSecret {
    pub access_token: String,
    pub refresh_token: String,
    pub id_token: Option<String>,
    pub expires_at: i64,
}

impl fmt::Debug for OAuthSecret {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("OAuthSecret")
            .field("access_token", &REDACTED_DEBUG)
            .field("refresh_token", &REDACTED_DEBUG)
            .field("id_token", &redacted_option(&self.id_token))
            .field("expires_at", &self.expires_at)
            .finish()
    }
}

impl OAuthSecret {
    pub fn expires_within(&self, seconds: i64) -> bool {
        self.expires_at <= Utc::now().timestamp_millis() + seconds * 1000
    }
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize, Zeroize)]
#[serde(rename_all = "camelCase")]
pub struct OpenCodeGoSecret {
    pub workspace_id: String,
    pub auth_cookie: String,
}

impl fmt::Debug for OpenCodeGoSecret {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("OpenCodeGoSecret")
            .field("workspace_id", &self.workspace_id)
            .field("auth_cookie", &REDACTED_DEBUG)
            .finish()
    }
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize, Zeroize)]
#[serde(rename_all = "camelCase")]
pub struct GoogleAiStudioSecret {
    pub api_key: String,
    pub selected_models: Vec<String>,
    #[serde(default)]
    pub cloud_project_id: Option<String>,
    #[serde(default)]
    pub cloud_oauth: Option<OAuthSecret>,
}

impl fmt::Debug for GoogleAiStudioSecret {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("GoogleAiStudioSecret")
            .field("api_key", &REDACTED_DEBUG)
            .field("selected_models", &self.selected_models)
            .field("cloud_project_id", &self.cloud_project_id)
            .field("cloud_oauth", &self.cloud_oauth)
            .finish()
    }
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize, Zeroize)]
#[serde(rename_all = "camelCase")]
pub struct GrokSecret {
    #[serde(default)]
    pub cookie_header: Option<String>,
}

impl fmt::Debug for GrokSecret {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("GrokSecret")
            .field("cookie_header", &redacted_option(&self.cookie_header))
            .finish()
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Zeroize)]
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

/// Where a sign-in attempt stands. Serialized in snake_case to match the
/// `LoginStatus["status"]` union in `src/types.ts`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LoginState {
    Waiting,
    Complete,
    Failed,
    ChooseProject,
    MonitoringDisabled,
}

impl LoginState {
    /// The attempt still holds the login slot: no other sign-in may start, and
    /// it can still be cancelled or abandoned.
    pub fn is_in_progress(self) -> bool {
        matches!(
            self,
            Self::Waiting | Self::ChooseProject | Self::MonitoringDisabled
        )
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginStatus {
    pub attempt_id: String,
    pub status: LoginState,
    pub message: Option<String>,
    pub account: Option<Account>,
    #[serde(default)]
    pub projects: Option<Vec<CloudProjectOption>>,
    #[serde(default)]
    pub selected_project_id: Option<String>,
}

impl LoginStatus {
    pub fn failed(attempt_id: impl Into<String>, message: String) -> Self {
        Self {
            attempt_id: attempt_id.into(),
            status: LoginState::Failed,
            message: Some(message),
            account: None,
            projects: None,
            selected_project_id: None,
        }
    }

    /// A sign-in that has started and is waiting on the provider; `message` is what to show meanwhile.
    pub fn waiting(attempt_id: impl Into<String>, message: Option<String>) -> Self {
        Self {
            attempt_id: attempt_id.into(),
            status: LoginState::Waiting,
            message,
            account: None,
            projects: None,
            selected_project_id: None,
        }
    }

    /// A sign-in that finished and connected `account`.
    pub fn complete(attempt_id: impl Into<String>, account: Account) -> Self {
        Self {
            attempt_id: attempt_id.into(),
            status: LoginState::Complete,
            message: None,
            account: Some(account),
            projects: None,
            selected_project_id: None,
        }
    }

    /// True when this is attempt `attempt_id` and it is still waiting on the provider.
    pub fn is_waiting_for(&self, attempt_id: &str) -> bool {
        self.attempt_id == attempt_id && self.status == LoginState::Waiting
    }
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
    /// Masked bearer token (e.g. `abcd••••••wxyz`). The full token is never
    /// sent over IPC by default; use the explicit `reveal_bridge_token`
    /// command after user confirmation to obtain it once.
    pub token: String,
    pub token_last4: String,
    pub enabled: bool,
    pub running: bool,
    pub error: Option<String>,
}

/// Masks a bridge token for IPC responses: first 4 + bullets + last 4.
/// Short tokens are fully masked to avoid leaking length oracles beyond size.
pub fn mask_bridge_token(token: &str) -> String {
    if token.len() <= 8 {
        return "•".repeat(token.len().max(4));
    }
    let first = &token[..4];
    let last4 = &token[token.len() - 4..];
    format!("{first}{}{last4}", "•".repeat(12))
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
    /// Saved sign-ins that are still stored unencrypted (Android). The app
    /// keeps retrying; the UI warns when this stays above zero.
    pub unprotected_credentials: usize,
    /// Accounts whose saved sign-in is still a plain file because locking it
    /// failed. Empty when every sign-in is locked, and on desktop.
    pub unprotected_account_ids: Vec<String>,
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
    pub windows: Vec<BridgeUsageWindow>,
    pub credits_usd: Option<f64>,
    pub fetched_at: Option<String>,
    pub error: Option<String>,
}

/// A usage window as the local API (`/v1/paseo-usage`) publishes it. It is its own type, apart from
/// `UsageWindow`, so a field added to the app's model cannot reach the public API by accident.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeUsageWindow {
    pub id: String,
    pub label: String,
    pub used_percent: Option<f64>,
    pub remaining_percent: Option<f64>,
    pub resets_at: Option<String>,
    pub window_seconds: Option<u64>,
}

impl From<&UsageWindow> for BridgeUsageWindow {
    fn from(window: &UsageWindow) -> Self {
        Self {
            id: window.id.clone(),
            label: window.label.clone(),
            used_percent: window.used_percent,
            remaining_percent: window.remaining_percent,
            resets_at: window.resets_at.clone(),
            window_seconds: window.window_seconds,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicUsageResponse {
    pub schema_version: u32,
    pub generated_at: String,
    pub accounts: Vec<PublicUsageAccount>,
}

#[derive(Clone, Debug)]
pub struct TokenClaims {
    pub email: Option<String>,
    pub account_id: Option<String>,
    pub plan: Option<String>,
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
                endpoint: crate::bridge_api::bridge_endpoint(),
                enabled: true,
                running: true,
                error: None,
            },
            unprotected_credentials: 0,
            unprotected_account_ids: Vec::new(),
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
        let failed =
            AppUpdateStatus::failed("0.3.3".into(), "Unable to check for updates: network down");
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

    #[test]
    fn debug_output_of_secrets_never_contains_the_credential() {
        let oauth = OAuthSecret {
            access_token: "at_SECRET_ACCESS".into(),
            refresh_token: "rt_SECRET_REFRESH".into(),
            id_token: Some("id_SECRET_ID".into()),
            expires_at: 1_700_000_000_000,
        };
        let studio = GoogleAiStudioSecret {
            api_key: "AIza_SECRET_KEY".into(),
            selected_models: vec!["gemini-pro".into()],
            cloud_project_id: Some("project-1".into()),
            cloud_oauth: Some(oauth.clone()),
        };
        let all = [
            format!("{oauth:?}"),
            format!("{:?}", ProviderSecret::Openai(oauth.clone())),
            format!("{:?}", ProviderSecret::Anthropic(oauth)),
            format!(
                "{:?}",
                ProviderSecret::OpencodeGo(OpenCodeGoSecret {
                    workspace_id: "wrk_123".into(),
                    auth_cookie: "auth_SECRET_COOKIE".into(),
                })
            ),
            format!("{:?}", ProviderSecret::GoogleAiStudio(studio)),
            format!(
                "{:?}",
                ProviderSecret::Grok(GrokSecret {
                    cookie_header: Some("sso=SECRET_SSO; jwt=SECRET_JWT".into()),
                })
            ),
        ];
        for text in &all {
            assert!(!text.contains("SECRET"), "{text}");
        }
        // Non-secret fields stay readable for debugging.
        assert!(all[0].contains("expires_at: 1700000000000"), "{}", all[0]);
        assert!(all[3].contains("wrk_123"), "{}", all[3]);
        assert!(all[4].contains("gemini-pro") && all[4].contains("project-1"));
    }

    /// The same sample windows are checked against the frontend's fallback classifier
    /// (`src/shared/lib/window-kinds.test.ts`), so the two cannot drift apart unnoticed.
    #[test]
    fn window_kinds_match_the_shared_fixture() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../src/shared/lib/window-kinds.fixture.json"
        ))
        .unwrap();
        let cases = fixture["cases"].as_array().unwrap();
        assert!(cases.len() > 20);
        for case in cases {
            let name = case["name"].as_str().unwrap();
            let kind = WindowKind::classify(
                case["id"].as_str().unwrap(),
                case["label"].as_str().unwrap(),
                case["windowSeconds"].as_u64(),
            );
            assert_eq!(
                kind.map(WindowKind::as_str),
                case["kind"].as_str(),
                "{name}"
            );
        }
    }

    #[test]
    fn kind_is_recomputed_not_trusted_and_the_old_file_format_loads() {
        let old: UsageWindow = serde_json::from_value(serde_json::json!({
            "id": "five_hour", "label": "5 hour", "usedPercent": 1.0, "remainingPercent": 99.0,
            "resetsAt": null, "windowSeconds": 18000
        }))
        .unwrap();
        assert_eq!(old.kind, None);
        assert_eq!(old.classified().kind, Some(WindowKind::FiveHour));
        let json = serde_json::to_value(UsageWindow {
            kind: Some(WindowKind::Monthly),
            ..serde_json::from_value(serde_json::json!({
                "id": "x", "label": "x", "usedPercent": null, "remainingPercent": null,
                "resetsAt": null, "windowSeconds": null
            }))
            .unwrap()
        })
        .unwrap();
        assert_eq!(json["kind"], "monthly");
    }
}

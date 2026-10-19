//! Values the Rust backend and the TypeScript frontend each spell out. A change on one side
//! alone would only show up as wrong behavior at run time, so these tests read the frontend
//! files and check that both sides agree. (`lib.rs` does the same for the command list.)

use crate::{
    model::{Provider, FIVE_HOUR_WINDOW_SECONDS, WEEKLY_WINDOW_SECONDS},
    providers::{
        google_ai_studio::{SOURCE_MODELS_ONLY, SOURCE_MONITORING, SOURCE_MONITORING_WAITING},
        grok::GROK_BOT_WINDOW_ID,
    },
    settings::{DEFAULT_ACCOUNT_REFRESH_MINUTES, OFFERED_REFRESH_MINUTES},
};
use std::{collections::BTreeMap, str::FromStr};

const USAGE_SOURCES_TS: &str = include_str!("../../src/shared/lib/usage-sources.ts");
const CONSTANTS_TS: &str = include_str!("../../src/shared/lib/constants.ts");
const PROVIDERS_TS: &str = include_str!("../../src/shared/lib/providers.ts");
const GENERAL_SECTION_TSX: &str = include_str!("../../src/features/settings/GeneralSection.tsx");

/// The text of `export const <name> = ...;` up to the closing `;`.
fn ts_const<'a>(source: &'a str, name: &str) -> &'a str {
    let marker = format!("export const {name}");
    let start = source
        .find(&marker)
        .unwrap_or_else(|| panic!("`{name}` is not exported by the frontend file"));
    let rest = &source[start..];
    // A `;` inside the value (a string or an object) would end it early; none of these have one.
    let end = rest
        .find("};")
        .map(|index| index + 1)
        .or_else(|| rest.find(';'))
        .unwrap_or_else(|| panic!("`{name}` has no end"));
    &rest[..end]
}

fn ts_string(source: &str, name: &str) -> String {
    let text = ts_const(source, name);
    let first = text
        .find('"')
        .unwrap_or_else(|| panic!("`{name}` is not a string"));
    let rest = &text[first + 1..];
    rest[..rest.find('"').expect("closing quote")].to_string()
}

fn ts_number(source: &str, name: &str) -> u64 {
    let text = ts_const(source, name);
    let value = text
        .split('=')
        .nth(1)
        .unwrap_or_else(|| panic!("`{name}` has no value"))
        .trim()
        .trim_end_matches(';')
        .replace('_', "");
    value
        .parse()
        .unwrap_or_else(|_| panic!("`{name}` is not a plain number: {value}"))
}

/// `key: "value"` pairs of an object literal, e.g. `USAGE_SOURCES`.
fn ts_string_object(source: &str, name: &str) -> BTreeMap<String, String> {
    ts_const(source, name)
        .lines()
        .filter_map(|line| {
            let (key, value) = line.trim().split_once(':')?;
            let value = value.trim().strip_prefix('"')?;
            let value = &value[..value.find('"')?];
            Some((key.trim().to_string(), value.to_string()))
        })
        .collect()
}

#[test]
fn usage_source_strings_match_the_frontend() {
    let sources = ts_string_object(USAGE_SOURCES_TS, "USAGE_SOURCES");
    let expected: BTreeMap<String, String> = [
        ("googleModelAccess", SOURCE_MODELS_ONLY),
        ("googleMonitoringWaiting", SOURCE_MONITORING_WAITING),
        ("googleCloudMonitoring", SOURCE_MONITORING),
    ]
    .into_iter()
    .map(|(key, value)| (key.to_string(), value.to_string()))
    .collect();
    assert_eq!(
        sources, expected,
        "src/shared/lib/usage-sources.ts and providers/google_ai_studio.rs disagree"
    );
}

#[test]
fn grok_bot_window_id_matches_the_frontend() {
    assert_eq!(
        ts_string(USAGE_SOURCES_TS, "GROK_BOT_WINDOW_ID"),
        GROK_BOT_WINDOW_ID
    );
}

#[test]
fn default_refresh_interval_matches_the_frontend() {
    assert_eq!(
        ts_number(CONSTANTS_TS, "DEFAULT_ACCOUNT_REFRESH_MINUTES"),
        DEFAULT_ACCOUNT_REFRESH_MINUTES
    );
}

#[test]
fn window_lengths_match_the_frontend() {
    assert_eq!(
        ts_number(CONSTANTS_TS, "FIVE_HOUR_WINDOW_SECONDS"),
        FIVE_HOUR_WINDOW_SECONDS
    );
    assert_eq!(
        ts_number(CONSTANTS_TS, "WEEKLY_WINDOW_SECONDS"),
        WEEKLY_WINDOW_SECONDS
    );
}

/// Every provider, listed so that adding a variant to `Provider` stops compiling here until the
/// new one is added (the match has no wildcard).
fn all_providers() -> Vec<Provider> {
    let all = vec![
        Provider::Openai,
        Provider::Anthropic,
        Provider::Antigravity,
        Provider::GoogleAiStudio,
        Provider::Grok,
        Provider::OpencodeGo,
    ];
    for provider in &all {
        match provider {
            Provider::Openai
            | Provider::Anthropic
            | Provider::Antigravity
            | Provider::GoogleAiStudio
            | Provider::Grok
            | Provider::OpencodeGo => {}
        }
    }
    all
}

/// Provider id -> short display name from `PROVIDER_META` in `providers.ts`.
fn ts_provider_names() -> BTreeMap<String, String> {
    let text = ts_const(
        PROVIDERS_TS,
        "PROVIDER_META: Record<Provider, ProviderMeta>",
    );
    let mut names = BTreeMap::new();
    let mut current: Option<String> = None;
    for line in text.lines() {
        let trimmed = line.trim();
        if let Some(id) = trimmed.strip_suffix(": {") {
            current = Some(id.to_string());
        } else if let (Some(id), Some(rest)) = (&current, trimmed.strip_prefix("name: \"")) {
            names.insert(id.clone(), rest[..rest.find('"').unwrap()].to_string());
            current = None;
        }
    }
    names
}

#[test]
fn provider_display_names_match_the_frontend() {
    let ts = ts_provider_names();
    let rust: BTreeMap<String, String> = all_providers()
        .into_iter()
        .map(|provider| {
            (
                provider.id().to_string(),
                provider.display_name().to_string(),
            )
        })
        .collect();
    assert_eq!(
        ts, rust,
        "src/shared/lib/providers.ts PROVIDER_META names and model.rs Provider::display_name disagree"
    );
    for id in rust.keys() {
        assert_eq!(Provider::from_str(id).unwrap().id(), id);
    }
}

#[test]
fn the_extractors_read_what_they_should() {
    // A guard against the helpers above quietly matching nothing.
    assert_eq!(ts_string_object(USAGE_SOURCES_TS, "USAGE_SOURCES").len(), 3);
    assert_eq!(ts_provider_names().len(), 6);
    assert_eq!(ts_number(CONSTANTS_TS, "FIVE_HOUR_WINDOW_SECONDS"), 18_000);
}

#[test]
fn bridge_window_names_the_real_port() {
    let window = include_str!("../../src/features/api-integration/ApiIntegrationWindow.tsx");
    let address = format!("127.0.0.1:{}", crate::bridge_api::BRIDGE_PORT);
    assert!(
        window.contains(&format!("<code>{address}</code>")),
        "ApiIntegrationWindow.tsx must show the local API address {address}"
    );
}

#[test]
fn refresh_interval_choices_match_the_settings_page() {
    let marker = "const ACCOUNT_REFRESH_OPTIONS = [";
    let start = GENERAL_SECTION_TSX.find(marker).expect("options list") + marker.len();
    let list = &GENERAL_SECTION_TSX[start..];
    let list = &list[..list.find(']').unwrap()];
    let offered: Vec<u64> = list
        .split(',')
        .filter_map(|value| value.trim().parse().ok())
        .collect();
    assert_eq!(offered, OFFERED_REFRESH_MINUTES);
}

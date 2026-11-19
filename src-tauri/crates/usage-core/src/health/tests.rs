use super::*;
use serde_json::{Map, Value};

const FIXTURE: &str = include_str!("../../../../../src/shared/lib/account-health.fixture.json");

fn merged(base: &Value, overrides: &Value) -> Value {
    let mut object: Map<String, Value> = base.as_object().expect("base is an object").clone();
    for (key, value) in overrides.as_object().expect("overrides are an object") {
        object.insert(key.clone(), value.clone());
    }
    Value::Object(object)
}

/// The frontend shows what these say (`account-health.test.ts` checks its chips and alerts
/// against the same cases), so the two cannot drift apart.
#[test]
fn health_matches_the_shared_fixture() {
    let fixture: Value = serde_json::from_str(FIXTURE).unwrap();
    let cases = fixture["cases"].as_array().unwrap();
    assert!(cases.len() >= 20);
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let mut account = merged(&fixture["baseAccount"], &case["account"]);
        account["lastUsage"] = match &case["usage"] {
            Value::Null => Value::Null,
            usage => merged(&fixture["baseUsage"], usage),
        };
        let account: Account = serde_json::from_value(account).unwrap();
        let health = serde_json::to_value(AccountHealth::of(&account)).unwrap();
        let google = serde_json::to_value(GoogleSetup::of(&account)).unwrap();
        assert_eq!(health, case["health"], "health of {name}");
        assert_eq!(google, case["googleSetup"], "Google setup of {name}");
        let serialized = serde_json::to_value(&account).unwrap();
        assert_eq!(
            serialized["health"], case["health"],
            "serialized health of {name}"
        );
        assert_eq!(
            serialized["googleSetup"], case["googleSetup"],
            "serialized setup of {name}"
        );
    }
}

#[test]
fn derived_values_are_not_read_back() {
    let fixture: Value = serde_json::from_str(FIXTURE).unwrap();
    let mut account = merged(&fixture["baseAccount"], &Value::Object(Map::new()));
    account["lastUsage"] = Value::Null;
    account["health"] = "live".into();
    account["googleSetup"] = "ready".into();
    let account: Account = serde_json::from_value(account).unwrap();
    let serialized = serde_json::to_value(&account).unwrap();
    assert_eq!(serialized["health"], "inactive");
    assert_eq!(serialized["googleSetup"], Value::Null);
}

#[test]
fn every_stored_field_is_still_serialized() {
    let fixture: Value = serde_json::from_str(FIXTURE).unwrap();
    let mut stored = merged(&fixture["baseAccount"], &Value::Object(Map::new()));
    stored["lastUsage"] = fixture["baseUsage"].clone();
    let account: Account = serde_json::from_value(stored.clone()).unwrap();
    let mut serialized = serde_json::to_value(&account).unwrap();
    let object = serialized.as_object_mut().unwrap();
    assert!(object.remove("health").is_some());
    assert!(object.remove("googleSetup").is_some());
    assert!(object.remove("autoRefresh").is_some());
    assert!(object.remove("headline").is_some());
    assert_eq!(serialized, stored);
}

const NOW: &str = "2026-09-03T12:00:00Z";

fn now() -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(NOW)
        .unwrap()
        .with_timezone(&Utc)
}

/// The fixture's base account with live usage fetched at `NOW`, changed by `change`.
fn scheduled_account(change: impl FnOnce(&mut Value)) -> Account {
    let fixture: Value = serde_json::from_str(FIXTURE).unwrap();
    let mut account = merged(&fixture["baseAccount"], &Value::Object(Map::new()));
    account["lastUsage"] = fixture["baseUsage"].clone();
    account["lastUsage"]["fetchedAt"] = NOW.into();
    change(&mut account);
    serde_json::from_value(account).unwrap()
}

fn minutes(minutes: i64) -> TimeDelta {
    TimeDelta::minutes(minutes)
}

#[test]
fn scheduled_refresh_is_due_once_an_account_is_a_whole_interval_old() {
    let accounts = [scheduled_account(|_| {})];
    assert!(!scheduled_refresh_is_due(
        &accounts,
        minutes(15),
        now() + minutes(14)
    ));
    assert!(scheduled_refresh_is_due(
        &accounts,
        minutes(15),
        now() + minutes(15)
    ));
    assert!(!scheduled_refresh_is_due(
        &[],
        minutes(15),
        now() + minutes(60)
    ));
}

#[test]
fn scheduled_refresh_is_due_for_an_account_never_fetched_or_with_an_unreadable_time() {
    let never = scheduled_account(|account| account["lastUsage"] = Value::Null);
    let unreadable = scheduled_account(|account| account["lastUsage"]["fetchedAt"] = "nope".into());
    assert!(scheduled_refresh_is_due(&[never], minutes(15), now()));
    assert!(scheduled_refresh_is_due(&[unreadable], minutes(15), now()));
}

#[test]
fn the_schedule_skips_accounts_that_must_sign_in_again_and_google_keys_without_cloud_usage() {
    let signed_out = scheduled_account(|account| {
        account["authRequired"] = true.into();
        account["lastUsage"] = Value::Null;
    });
    let key_only = scheduled_account(|account| {
        account["provider"] = "google_ai_studio".into();
        account["lastUsage"]["source"] = SOURCE_MODELS_ONLY.into();
    });
    let waiting = scheduled_account(|account| {
        account["provider"] = "google_ai_studio".into();
        account["lastUsage"]["source"] = SOURCE_MONITORING_WAITING.into();
    });
    let connected = scheduled_account(|account| {
        account["provider"] = "google_ai_studio".into();
        account["lastUsage"]["source"] = SOURCE_MONITORING.into();
    });
    assert!(!refreshes_on_schedule(&signed_out));
    assert!(!refreshes_on_schedule(&key_only));
    assert!(refreshes_on_schedule(&waiting));
    assert!(refreshes_on_schedule(&connected));
    let an_hour_later = now() + minutes(60);
    assert!(!scheduled_refresh_is_due(
        &[signed_out.clone(), key_only.clone()],
        minutes(15),
        an_hour_later
    ));
    assert!(scheduled_refresh_is_due(
        &[signed_out, key_only, connected],
        minutes(15),
        an_hour_later
    ));
    // Only the stored sign-in flag counts: usage that says to sign in again is still retried.
    let stale_sign_in =
        scheduled_account(|account| account["lastUsage"]["freshness"] = "auth_required".into());
    assert!(refreshes_on_schedule(&stale_sign_in));
}

#[test]
fn accounts_carry_whether_the_schedule_includes_them() {
    let included = serde_json::to_value(scheduled_account(|_| {})).unwrap();
    let skipped = serde_json::to_value(scheduled_account(|account| {
        account["authRequired"] = true.into()
    }))
    .unwrap();
    assert_eq!(included["autoRefresh"], true);
    assert_eq!(skipped["autoRefresh"], false);
}

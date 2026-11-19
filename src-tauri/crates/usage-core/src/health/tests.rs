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
    assert_eq!(serialized, stored);
}

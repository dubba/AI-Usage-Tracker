use super::*;
use serde_json::{json, Value};

const FIXTURE: &str = include_str!("../../../../../src/shared/lib/headline.fixture.json");

fn account(entry: &Value) -> Account {
    let windows = entry["windows"].as_array().map(|windows| {
        windows
            .iter()
            .map(|window| {
                let mut window = window.clone();
                window["usedPercent"] = Value::Null;
                window
            })
            .collect::<Vec<_>>()
    });
    serde_json::from_value(json!({
        "id": entry["name"],
        "label": entry["name"],
        "provider": entry["provider"],
        "email": null,
        "plan": entry["plan"],
        "createdAt": "2026-09-01T00:00:00Z",
        "updatedAt": "2026-09-01T00:00:00Z",
        "lastUsage": windows.map(|windows| json!({
            "plan": null,
            "email": null,
            "windows": windows,
            "creditsUsd": null,
            "unlimitedCredits": false,
            "fetchedAt": "2026-09-03T12:00:00Z",
            "freshness": "live",
            "source": "test",
        })),
        "lastError": null,
        "authRequired": false,
    }))
    .unwrap()
}

/// The frontend picks from these candidates (`headline.test.ts` checks the percents and labels it
/// shows against the same cases), so the two cannot drift apart.
#[test]
fn headline_matches_the_shared_fixture() {
    let fixture: Value = serde_json::from_str(FIXTURE).unwrap();
    let entries = fixture["accounts"].as_array().unwrap();
    assert!(entries.len() >= 15);
    for entry in entries {
        let name = entry["name"].as_str().unwrap();
        let account = account(entry);
        let headline = serde_json::to_value(Headline::of(&account)).unwrap();
        assert_eq!(headline, entry["headline"], "headline of {name}");
        let serialized = serde_json::to_value(&account).unwrap();
        assert_eq!(
            serialized["headline"], entry["headline"],
            "serialized headline of {name}"
        );
    }
}

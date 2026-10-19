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

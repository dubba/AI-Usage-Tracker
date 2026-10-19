use super::*;

pub(super) const KNOWN_QUOTA_FAMILIES: &[&str] = &[
    "generate_content_free_tier_requests",
    "generate_content_free_tier_input_token_count",
    "generate_requests_per_model",
    "generate_content_paid_tier_input_token_count",
    "generate_content_paid_tier_2_requests",
    "generate_content_paid_tier_2_input_token_count",
    "generate_content_paid_tier_3_requests",
    "generate_content_paid_tier_3_input_token_count",
];

#[derive(Clone, Debug)]
pub(super) struct QuotaPoint {
    pub(super) end_time: DateTime<Utc>,
    pub(super) value: f64,
}

#[derive(Clone, Debug)]
pub(super) struct QuotaSeries {
    pub(super) metric_type: String,
    pub(super) model: String,
    pub(super) limit_name: String,
    pub(super) points: Vec<QuotaPoint>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(super) enum QuotaKind {
    Rpm,
    Tpm,
    Rpd,
    Tpd,
}

impl QuotaKind {
    pub(super) fn label(self) -> &'static str {
        match self {
            Self::Rpm => "RPM",
            Self::Tpm => "TPM",
            Self::Rpd => "RPD",
            Self::Tpd => "TPD",
        }
    }

    pub(super) fn window_seconds(self) -> u64 {
        match self {
            Self::Rpm | Self::Tpm => 60,
            Self::Rpd | Self::Tpd => 86_400,
        }
    }

    pub(super) fn is_daily(self) -> bool {
        matches!(self, Self::Rpd | Self::Tpd)
    }
}

#[derive(Default)]
pub(super) struct QuotaBucket {
    pub(super) usage_points: Vec<QuotaPoint>,
    pub(super) limit: Option<f64>,
}

pub(super) struct WindowCandidate {
    pub(super) window: UsageWindow,
    pub(super) limit: f64,
    pub(super) model_label: String,
    pub(super) kind: QuotaKind,
}

pub(super) fn normalize_quota_windows(
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
            kind: None,
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

pub(super) fn usage_for_window(points: &[QuotaPoint], kind: QuotaKind, now: DateTime<Utc>) -> f64 {
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

pub(super) fn classify_quota(metric_base: &str, limit_name: &str) -> Option<QuotaKind> {
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

pub(super) fn metric_base(metric_type: &str) -> Option<&str> {
    let value = metric_type.strip_prefix(METRIC_PREFIX)?;
    value
        .strip_suffix("/usage")
        .or_else(|| value.strip_suffix("/limit"))
}

pub(super) fn supported_metric_type(metric_type: &str) -> bool {
    let Some(base) = metric_base(metric_type) else {
        return false;
    };
    KNOWN_QUOTA_FAMILIES.contains(&base)
}

pub(super) fn match_selected_model<'a>(
    candidate: &str,
    selected: &'a [TrackableModel],
) -> Option<&'a TrackableModel> {
    let candidate = canonical_model(candidate);
    selected.iter().find(|model| {
        let selected = canonical_model(&model.name);
        candidate == selected || candidate.ends_with(&selected) || selected.ends_with(&candidate)
    })
}

pub(super) fn canonical_model(value: &str) -> String {
    value
        .trim()
        .trim_start_matches("models/")
        .trim_start_matches("publishers/google/models/")
        .to_ascii_lowercase()
}

pub(super) fn monitoring_value(value: &Value) -> Option<f64> {
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

pub(super) fn current_pacific_midnight(now: DateTime<Utc>) -> DateTime<Utc> {
    let offset = pacific_offset_seconds(now);
    let local = now + Duration::seconds(offset as i64);
    pacific_midnight_utc(local.date_naive())
}

pub(super) fn next_pacific_midnight(now: DateTime<Utc>) -> DateTime<Utc> {
    let offset = pacific_offset_seconds(now);
    let local = now + Duration::seconds(offset as i64);
    let next = local.date_naive().succ_opt().unwrap_or(local.date_naive());
    pacific_midnight_utc(next)
}

pub(super) fn pacific_midnight_utc(date: NaiveDate) -> DateTime<Utc> {
    let offset = pacific_midnight_offset_seconds(date);
    let local_midnight = date.and_hms_opt(0, 0, 0).expect("valid midnight");
    Utc.from_utc_datetime(&(local_midnight - Duration::seconds(offset as i64)))
}

pub(super) fn pacific_offset_seconds(now: DateTime<Utc>) -> i32 {
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

pub(super) fn pacific_midnight_offset_seconds(date: NaiveDate) -> i32 {
    let start = nth_weekday_of_month(date.year(), 3, Weekday::Sun, 2);
    let end = nth_weekday_of_month(date.year(), 11, Weekday::Sun, 1);
    if (date > start && date < end) || date == end {
        -7 * 3600
    } else {
        -8 * 3600
    }
}

pub(super) fn nth_weekday_of_month(
    year: i32,
    month: u32,
    weekday: Weekday,
    occurrence: u32,
) -> NaiveDate {
    let first = NaiveDate::from_ymd_opt(year, month, 1).expect("valid month");
    let days = (7 + weekday.num_days_from_monday() as i64
        - first.weekday().num_days_from_monday() as i64)
        % 7;
    first + Duration::days(days + 7 * (occurrence.saturating_sub(1)) as i64)
}

# Gemini quota discovery probe

This probe is the mandatory discovery step before AI Usage Tracker adds production Google AI Studio/Gemini quota calculations.

It intentionally does **not** calculate remaining quota, assign reset windows, or expose a new provider in the desktop interface. Its job is to capture the real Google Cloud metric shapes for a test project so the production adapter can be based on observed data rather than assumptions.

## What the probe records

The generated JSON report contains:

- Gemini-related Cloud Monitoring metric descriptors;
- metric type, launch stage, metric kind, value type, unit, labels, and monitored resource types;
- raw request, input-token, limit, and quota-exceeded time series for the known free and paid metric families;
- `model`, `limit_name`, and `method` label values when Google returns them;
- monitored-resource labels;
- point start and end timestamps;
- typed point values exactly as returned by Google;
- Service Usage consumer quota definitions and effective limits when available;
- partial failures and permission errors without including credentials;
- an explicit `validation.status = "not_run"` marker until someone compares the report with AI Studio.

The probe does not infer whether a `limit_name` means RPM, TPM, RPD, TPD, or another window. That normalization belongs after real payloads are reviewed.

## Security behavior

- The OAuth access token remains in process memory and is never written to the report.
- API keys, access tokens, refresh tokens, ID tokens, authorization values, private keys, passwords, and similarly named fields are recursively redacted.
- Project IDs and project numbers are replaced with `[PROJECT]` by default.
- The default output filename uses a short SHA-256 fingerprint rather than the project ID.
- The report file is created with owner-only permissions where the operating system honors POSIX file modes.
- `gemini-quota-probe-*.json` is ignored by Git so a diagnostic export is not committed accidentally.
- Clear project identifiers appear only when `--include-project-identifiers` is supplied explicitly.

Always inspect a report before sharing it outside the project.

## Google Cloud prerequisites

Enable these APIs on the target project:

```text
monitoring.googleapis.com
serviceusage.googleapis.com
generativelanguage.googleapis.com
```

The monitoring principal needs read-only access. Recommended roles:

```text
roles/monitoring.viewer
roles/serviceusage.serviceUsageViewer
```

`roles/serviceusage.serviceUsageViewer` includes `serviceusage.quotas.get`. A custom read-only role is also acceptable when it contains the required Monitoring and Service Usage read permissions.

An AI Studio API key is not sufficient to query Cloud Monitoring. Use OAuth through Application Default Credentials, a service account, Workload Identity Federation, or another server-side Google Cloud credential flow.

## Prepare representative data

Before running the probe:

1. Confirm the AI Studio key belongs to the Google Cloud project being queried.
2. Make representative generation calls to at least two Gemini models.
3. Include enough calls to create visible request and input-token activity.
4. Wait several minutes because Monitoring samples some quota metrics every 60 seconds and Google notes that visibility can lag by up to 150 seconds.
5. Open the AI Studio **Usage** and **Rate Limits** screens for the same project so the report can be compared immediately.

Do not assume separate API keys in the same project have separate provider quotas. Google applies Gemini API limits per project.

## Authenticate locally

Preferred local setup:

```bash
gcloud auth application-default login \
  --scopes=https://www.googleapis.com/auth/cloud-platform
```

The probe obtains a token with:

```bash
gcloud auth application-default print-access-token \
  --scopes=https://www.googleapis.com/auth/cloud-platform
```

Application Default Credentials can also point to a service-account or Workload Identity Federation credential file through `GOOGLE_APPLICATION_CREDENTIALS`.

For controlled automation, `GOOGLE_OAUTH_ACCESS_TOKEN` can supply a short-lived token. Do not save that token in a repository file, command argument, URL, log, or diagnostic export.

## Run the probe

From the repository root:

```bash
npm run probe:gemini-quota -- \
  --project YOUR_PROJECT_ID \
  --project-number YOUR_PROJECT_NUMBER \
  --output ./gemini-quota-probe.json
```

The project number is recommended for Service Usage quota discovery. Cloud Monitoring continues to use the project ID supplied by `--project`.

Options:

```text
--project PROJECT_ID              Required Google Cloud project ID
--project-number NUMBER           Project number used by Service Usage
--output PATH                     Report destination
--lookback-hours HOURS            Monitoring interval, 1-744; default 48
--include-project-identifiers     Preserve clear project ID and number
--skip-service-usage              Query Monitoring only
-h, --help                        Show command help
```

## Validate the result against AI Studio

For each model exercised before the probe, compare:

- request usage;
- request limit;
- input-token usage;
- input-token limit;
- every returned `limit_name`;
- `method` labels;
- quota-exceeded series;
- metric timestamps and observed delay;
- free-tier versus paid-tier metric families;
- reset behavior shown in AI Studio.

Record the comparison separately. The probe deliberately leaves its validation status as `not_run`; it must not claim that raw metrics match AI Studio automatically.

## Expected interpretation rules

During review, preserve these distinctions:

- `DELTA` usage metrics require aggregation over the correct quota window. The newest point is not automatically “usage today.”
- `GAUGE` limit metrics normally use the latest applicable point.
- Requests per day reset at midnight Pacific, including daylight-saving changes.
- Rolling RPM, TPM, and spend windows must be calculated over their actual rolling periods.
- Unknown `limit_name` values remain unknown until validated.
- Monitoring is authoritative but delayed.
- Local request logging is immediate but sees only calls routed through the tracker or an integrated router.
- A later hybrid estimate must retain the provider data-through timestamp to avoid double-counting local events.

## Known metric registry

The initial registry queries request, input-token, limit, usage, and exceeded variants for these families:

```text
quota/generate_content_free_tier_requests
quota/generate_content_free_tier_input_token_count
quota/generate_requests_per_model
quota/generate_content_paid_tier_input_token_count
quota/generate_content_paid_tier_2_requests
quota/generate_content_paid_tier_2_input_token_count
quota/generate_content_paid_tier_3_requests
quota/generate_content_paid_tier_3_input_token_count
```

The descriptor report also lists other `generativelanguage.googleapis.com/` metrics visible to the project. New or Alpha/Beta metrics must be reviewed before being added to production normalization.

## Targeted tests

```bash
npm run test:gemini-quota-probe
```

The tests cover:

- credential and project-identifier redaction;
- project ID and project number validation;
- non-reversible display fingerprints;
- known request and token metric registration;
- argument parsing.

Network calls are not made by the tests.

## Official references

- [Gemini API rate limits](https://ai.google.dev/gemini-api/docs/rate-limits)
- [Google Cloud Monitoring Gemini metric catalog](https://cloud.google.com/monitoring/api/metrics_gcp_d_h)
- [Metric descriptor listing](https://cloud.google.com/monitoring/api/ref_v3/rest/v3/projects.metricDescriptors/list)
- [Time-series listing](https://cloud.google.com/monitoring/api/ref_v3/rest/v3/projects.timeSeries/list)
- [Monitoring filters](https://cloud.google.com/monitoring/api/v3/filters)
- [Service Usage consumer quota metrics](https://cloud.google.com/service-usage/docs/reference/rest/v1beta1/services.consumerQuotaMetrics/list)
- [Service Usage IAM roles](https://cloud.google.com/iam/docs/roles-permissions/serviceusage)
- [Application Default Credentials](https://cloud.google.com/docs/authentication/provide-credentials-adc)

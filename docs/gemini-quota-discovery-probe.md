# Gemini quota discovery probe

`scripts/gemini-quota-probe.mjs` records Google Cloud Monitoring and Service Usage shapes for a project. It does not calculate remaining quota, assign reset windows, or add a provider. Production Google AI Studio quota is `src-tauri/src/providers/google_ai_studio/`, and this probe is not that path.

The report's `validation.status` stays `not_run`. The probe does not infer whether a `limit_name` is RPM, TPM, RPD, TPD, or another window.

## Security

- The OAuth access token stays in process memory and is never written to the report.
- API keys, access tokens, refresh tokens, ID tokens, authorization values, private keys, passwords, and similarly named fields are redacted.
- Project IDs and project numbers become `[PROJECT]` unless `--include-project-identifiers` is set. The default output name uses a short SHA-256 fingerprint, not the project ID.
- The report is created with owner-only permissions where the system honors POSIX file modes.
- `gemini-quota-probe-*.json` is gitignored. Inspect a report before sharing it.

Do not save `GOOGLE_OAUTH_ACCESS_TOKEN` in a repository file, command argument, URL, log, or diagnostic export.

## Authenticate

Application Default Credentials:

```bash
gcloud auth application-default login \
  --scopes=https://www.googleapis.com/auth/cloud-platform
```

The probe reads a token with `gcloud auth application-default print-access-token` and the same scope. A service-account or Workload Identity file can be pointed at with `GOOGLE_APPLICATION_CREDENTIALS`. An AI Studio API key cannot query Cloud Monitoring.

Enable `monitoring.googleapis.com`, `serviceusage.googleapis.com`, and `generativelanguage.googleapis.com` on the project. The principal needs read access, typically `roles/monitoring.viewer` and `roles/serviceusage.serviceUsageViewer` (`serviceusage.quotas.get`).

## Run

From the repository root:

```bash
npm run probe:gemini-quota -- \
  --project YOUR_PROJECT_ID \
  --project-number YOUR_PROJECT_NUMBER \
  --output ./gemini-quota-probe.json
```

`--project` is required and is what Cloud Monitoring queries. `--project-number` is recommended for Service Usage. Other options: `--output`, `--lookback-hours` (1–744, default 48), `--include-project-identifiers`, `--skip-service-usage`, `-h`.

The registry covers request, input-token, limit, usage, and exceeded variants of:

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

The descriptor report also lists other `generativelanguage.googleapis.com/` metrics the project can see.

## Tests

`npm run test:gemini-quota-probe` checks redaction, project id and number validation, non-reversible fingerprints, known request and token metric registration, and argument parsing. The tests make no network calls. The script stays wired into `package.json`, `.github/workflows/validate.yml`, and `scripts/preflight.sh`.

## References

- [Gemini API rate limits](https://ai.google.dev/gemini-api/docs/rate-limits)
- [Google Cloud Monitoring Gemini metric catalog](https://cloud.google.com/monitoring/api/metrics_gcp_d_h)
- [Metric descriptor listing](https://cloud.google.com/monitoring/api/ref_v3/rest/v3/projects.metricDescriptors/list)
- [Time-series listing](https://cloud.google.com/monitoring/api/ref_v3/rest/v3/projects.timeSeries/list)
- [Monitoring filters](https://cloud.google.com/monitoring/api/v3/filters)
- [Service Usage consumer quota metrics](https://cloud.google.com/service-usage/docs/reference/rest/v1beta1/services.consumerQuotaMetrics/list)
- [Service Usage IAM roles](https://cloud.google.com/iam/docs/roles-permissions/serviceusage)
- [Application Default Credentials](https://cloud.google.com/docs/authentication/provide-credentials-adc)

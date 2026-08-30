import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const METRIC_PREFIX = "generativelanguage.googleapis.com/";
const DEFAULT_LOOKBACK_HOURS = 48;
const REPORT_SCHEMA_VERSION = 1;
const QUOTA_SUFFIXES = ["usage", "limit", "exceeded"];

export const KNOWN_QUOTA_FAMILIES = [
  "quota/generate_content_free_tier_requests",
  "quota/generate_content_free_tier_input_token_count",
  "quota/generate_requests_per_model",
  "quota/generate_content_paid_tier_input_token_count",
  "quota/generate_content_paid_tier_2_requests",
  "quota/generate_content_paid_tier_2_input_token_count",
  "quota/generate_content_paid_tier_3_requests",
  "quota/generate_content_paid_tier_3_input_token_count",
];

export function knownMetricTypes() {
  return new Set(
    KNOWN_QUOTA_FAMILIES.flatMap((family) =>
      QUOTA_SUFFIXES.map((suffix) => `${METRIC_PREFIX}${family}/${suffix}`),
    ),
  );
}

export function fingerprint(value) {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16);
}

export function validateProjectId(value) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 128 ||
    !/^[A-Za-z0-9_.:-]+$/.test(value)
  ) {
    throw new Error("Project ID contains unsupported characters.");
  }
  return value;
}

export function validateProjectNumber(value) {
  if (typeof value !== "string" || !/^\d{1,32}$/.test(value)) {
    throw new Error("Project number must contain digits only.");
  }
  return value;
}

function normalizeSensitiveKey(key) {
  return key.toLowerCase().replaceAll("_", "").replaceAll("-", "");
}

function isSensitiveKey(key) {
  const normalized = normalizeSensitiveKey(key);
  return (
    normalized.includes("apikey") ||
    normalized.includes("accesstoken") ||
    normalized.includes("refreshtoken") ||
    normalized.includes("idtoken") ||
    normalized.includes("privatekey") ||
    normalized.includes("authorization") ||
    normalized === "token" ||
    normalized === "secret" ||
    normalized === "password"
  );
}

export function sanitizeJson(value, projectIdentifiers, includeProjectIdentifiers = false) {
  if (Array.isArray(value)) {
    return value.map((item) =>
      sanitizeJson(item, projectIdentifiers, includeProjectIdentifiers),
    );
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => [
        key,
        isSensitiveKey(key)
          ? "[REDACTED]"
          : sanitizeJson(
              nestedValue,
              projectIdentifiers,
              includeProjectIdentifiers,
            ),
      ]),
    );
  }

  if (typeof value === "string" && !includeProjectIdentifiers) {
    return projectIdentifiers
      .filter(Boolean)
      .reduce(
        (sanitized, identifier) => sanitized.replaceAll(identifier, "[PROJECT]"),
        value,
      );
  }

  return value;
}

export function parseArgs(argv) {
  const options = {
    projectId: null,
    projectNumber: null,
    output: null,
    lookbackHours: DEFAULT_LOOKBACK_HOURS,
    includeProjectIdentifiers: false,
    skipServiceUsage: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const nextValue = () => {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${argument} requires a value.`);
      }
      index += 1;
      return value;
    };

    switch (argument) {
      case "--project":
        options.projectId = validateProjectId(nextValue());
        break;
      case "--project-number":
        options.projectNumber = validateProjectNumber(nextValue());
        break;
      case "--output":
        options.output = nextValue();
        break;
      case "--lookback-hours": {
        const parsed = Number.parseInt(nextValue(), 10);
        if (!Number.isInteger(parsed) || parsed < 1 || parsed > 744) {
          throw new Error("--lookback-hours must be between 1 and 744.");
        }
        options.lookbackHours = parsed;
        break;
      }
      case "--include-project-identifiers":
        options.includeProjectIdentifiers = true;
        break;
      case "--skip-service-usage":
        options.skipServiceUsage = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${argument}. Run with --help for usage.`);
    }
  }

  if (!options.help && !options.projectId) {
    throw new Error("Missing required --project PROJECT_ID argument.");
  }

  return options;
}

export function helpText() {
  return `Gemini quota metric discovery probe

Usage:
  npm run probe:gemini-quota -- --project PROJECT_ID [options]

Options:
  --project PROJECT_ID              Google Cloud project ID (required)
  --project-number NUMBER           Project number for Service Usage quota discovery
  --output PATH                     JSON report path
  --lookback-hours HOURS            Raw Monitoring lookback, 1-744 (default: 48)
  --include-project-identifiers     Include project ID and number in the report
  --skip-service-usage              Skip Service Usage limit discovery
  -h, --help                        Show this help

Authentication order:
  1. GOOGLE_OAUTH_ACCESS_TOKEN
  2. gcloud auth application-default print-access-token

The probe never writes the OAuth token to its report.`;
}

function acquireAccessToken() {
  const environmentToken = process.env.GOOGLE_OAUTH_ACCESS_TOKEN?.trim();
  if (environmentToken) {
    return { token: environmentToken, source: "environment" };
  }

  try {
    const token = execFileSync(
      "gcloud",
      [
        "auth",
        "application-default",
        "print-access-token",
        "--scopes=https://www.googleapis.com/auth/cloud-platform",
        "--quiet",
      ],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    ).trim();

    if (!token) {
      throw new Error("gcloud returned an empty access token.");
    }

    return { token, source: "gcloud_adc" };
  } catch (error) {
    const stderr = error?.stderr?.toString?.().trim();
    const detail = stderr || error?.message || String(error);
    throw new Error(
      `GOOGLE_OAUTH_ACCESS_TOKEN is unset and gcloud ADC token generation failed: ${truncate(detail, 500)}`,
    );
  }
}

async function googleFetchJson(url, token, quotaProjectId) {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "X-Goog-User-Project": quotaProjectId,
      "User-Agent": "ai-usage-tracker-gemini-quota-probe/1",
    },
  });

  if (!response.ok) {
    const body = await response.text();
    let message = `Google API returned HTTP ${response.status}.`;
    try {
      const parsed = JSON.parse(body);
      message = parsed?.error?.message || message;
    } catch {
      if (body.trim()) {
        message = `Google API returned HTTP ${response.status}: ${truncate(body.trim(), 1000)}`;
      }
    }
    throw Object.assign(new Error(message), { status: response.status });
  }

  return response.json();
}

function apiErrorReport(error) {
  return {
    status: Number.isInteger(error?.status) ? error.status : null,
    message: truncate(error?.message || String(error), 1000),
  };
}

async function listMetricDescriptors(token, projectId, knownMetrics) {
  const descriptors = [];
  let pageToken = null;

  do {
    const url = new URL(
      `https://monitoring.googleapis.com/v3/projects/${projectId}/metricDescriptors`,
    );
    url.searchParams.set(
      "filter",
      `metric.type = starts_with("${METRIC_PREFIX}")`,
    );
    url.searchParams.set("pageSize", "10000");
    url.searchParams.set("activeOnly", "false");
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const page = await googleFetchJson(url, token, projectId);
    for (const descriptor of page.metricDescriptors || []) {
      descriptors.push({
        metricType: descriptor.type,
        displayName: descriptor.displayName ?? null,
        description: descriptor.description ?? null,
        metricKind: descriptor.metricKind ?? null,
        valueType: descriptor.valueType ?? null,
        unit: descriptor.unit ?? null,
        launchStage: descriptor.launchStage ?? null,
        labels: (descriptor.labels || []).map((label) => ({
          key: label.key,
          valueType: label.valueType ?? null,
          description: label.description ?? null,
        })),
        monitoredResourceTypes: descriptor.monitoredResourceTypes || [],
        knownRegistryEntry: knownMetrics.has(descriptor.type),
      });
    }

    pageToken = page.nextPageToken || null;
  } while (pageToken);

  descriptors.sort((left, right) =>
    left.metricType.localeCompare(right.metricType),
  );
  return descriptors;
}

async function queryTimeSeries(
  token,
  projectId,
  metricType,
  startTime,
  endTime,
) {
  const timeSeries = [];
  let pageToken = null;

  do {
    const url = new URL(
      `https://monitoring.googleapis.com/v3/projects/${projectId}/timeSeries`,
    );
    url.searchParams.set("filter", `metric.type = "${metricType}"`);
    url.searchParams.set("interval.startTime", startTime);
    url.searchParams.set("interval.endTime", endTime);
    url.searchParams.set("view", "FULL");
    url.searchParams.set("pageSize", "100000");
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const page = await googleFetchJson(url, token, projectId);
    for (const series of page.timeSeries || []) {
      const metricLabels = series.metric?.labels || {};
      timeSeries.push({
        model: metricLabels.model ?? null,
        limitName: metricLabels.limit_name ?? null,
        method: metricLabels.method ?? null,
        metricLabels,
        resourceType: series.resource?.type ?? null,
        resourceLabels: series.resource?.labels || {},
        metricKind: series.metricKind ?? null,
        valueType: series.valueType ?? null,
        points: (series.points || []).map((point) => ({
          startTime: point.interval?.startTime ?? null,
          endTime: point.interval?.endTime ?? null,
          value: point.value ?? null,
        })),
      });
    }

    pageToken = page.nextPageToken || null;
  } while (pageToken);

  return timeSeries;
}

async function queryServiceUsage(token, projectId, projectConsumer) {
  const metrics = [];
  let pageToken = null;

  do {
    const url = new URL(
      `https://serviceusage.googleapis.com/v1beta1/projects/${projectConsumer}/services/generativelanguage.googleapis.com/consumerQuotaMetrics`,
    );
    url.searchParams.set("view", "FULL");
    url.searchParams.set("pageSize", "200");
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const page = await googleFetchJson(url, token, projectId);
    metrics.push(...(page.metrics || []));
    pageToken = page.nextPageToken || null;
  } while (pageToken);

  return { metrics };
}

function truncate(value, maxCharacters) {
  const characters = [...String(value)];
  return characters.length <= maxCharacters
    ? characters.join("")
    : `${characters.slice(0, maxCharacters).join("")}…`;
}

export async function runProbe(options) {
  const { token, source: authenticationSource } = acquireAccessToken();
  const endTime = new Date();
  const startTime = new Date(
    endTime.getTime() - options.lookbackHours * 60 * 60 * 1000,
  );
  const knownMetrics = knownMetricTypes();
  const warnings = [];

  let descriptors = [];
  let descriptorDiscovery = null;
  try {
    descriptors = await listMetricDescriptors(
      token,
      options.projectId,
      knownMetrics,
    );
    descriptorDiscovery = {
      status: "successful",
      descriptorCount: descriptors.length,
      descriptors,
      error: null,
    };
  } catch (error) {
    warnings.push(
      "Metric descriptor discovery failed; known metric queries were still attempted.",
    );
    descriptorDiscovery = {
      status: "failed",
      descriptorCount: 0,
      descriptors: [],
      error: apiErrorReport(error),
    };
  }

  const descriptorIndex = new Map(
    descriptors.map((descriptor) => [descriptor.metricType, descriptor]),
  );
  const descriptorTypes = new Set(descriptorIndex.keys());
  const metricQueries = [];

  for (const metricType of [...knownMetrics].sort()) {
    const descriptorAvailable = descriptorTypes.has(metricType);
    const descriptor = descriptorIndex.get(metricType);

    if (!descriptorAvailable && descriptors.length > 0) {
      metricQueries.push({
        metricType,
        status: "descriptor_not_available",
        descriptorAvailable: false,
        metricKind: null,
        valueType: null,
        seriesCount: 0,
        timeSeries: [],
        error: null,
      });
      continue;
    }

    try {
      const timeSeries = await queryTimeSeries(
        token,
        options.projectId,
        metricType,
        startTime.toISOString(),
        endTime.toISOString(),
      );
      metricQueries.push({
        metricType,
        status: timeSeries.length ? "successful" : "no_series",
        descriptorAvailable,
        metricKind: descriptor?.metricKind ?? null,
        valueType: descriptor?.valueType ?? null,
        seriesCount: timeSeries.length,
        timeSeries,
        error: null,
      });
    } catch (error) {
      metricQueries.push({
        metricType,
        status: "failed",
        descriptorAvailable,
        metricKind: descriptor?.metricKind ?? null,
        valueType: descriptor?.valueType ?? null,
        seriesCount: 0,
        timeSeries: [],
        error: apiErrorReport(error),
      });
    }
  }

  let serviceUsage;
  if (options.skipServiceUsage) {
    serviceUsage = { status: "skipped", response: null, error: null };
  } else {
    try {
      serviceUsage = {
        status: "successful",
        response: await queryServiceUsage(
          token,
          options.projectId,
          options.projectNumber || options.projectId,
        ),
        error: null,
      };
    } catch (error) {
      warnings.push(
        "Service Usage quota discovery failed. Confirm serviceusage.googleapis.com is enabled, provide --project-number when required, and grant serviceusage.quotas.get.",
      );
      serviceUsage = {
        status: "failed",
        response: null,
        error: apiErrorReport(error),
      };
    }
  }

  const report = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    project: {
      projectId: options.includeProjectIdentifiers ? options.projectId : null,
      projectNumber: options.includeProjectIdentifiers
        ? options.projectNumber
        : null,
      projectFingerprint: fingerprint(options.projectId),
      projectNumberFingerprint: options.projectNumber
        ? fingerprint(options.projectNumber)
        : null,
    },
    interval: {
      startTime: startTime.toISOString(),
      endTime: endTime.toISOString(),
      lookbackHours: options.lookbackHours,
    },
    authentication: {
      source: authenticationSource,
      tokenIncluded: false,
    },
    descriptorDiscovery,
    metricQueries,
    serviceUsage,
    validation: {
      status: "not_run",
      required: true,
      requirements: [
        "Make representative Gemini API calls to at least two models before running this probe.",
        "Compare request and token usage, limits, model labels, limit names, and reset behavior with the AI Studio Usage and Rate Limits screens.",
        "Do not promote discovered Alpha or Beta metrics into production routing or authoritative UI until their aggregation semantics are validated.",
      ],
    },
    warnings,
  };

  const identifiers = [options.projectId, options.projectNumber].filter(Boolean);
  const sanitizedReport = sanitizeJson(
    report,
    identifiers,
    options.includeProjectIdentifiers,
  );
  const outputPath = resolve(
    options.output ||
      `gemini-quota-probe-${fingerprint(options.projectId)}-${new Date()
        .toISOString()
        .replaceAll(/[-:.]/g, "")}.json`,
  );

  writeFileSync(outputPath, `${JSON.stringify(sanitizedReport, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });

  return { outputPath, report: sanitizedReport };
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log(helpText());
      return;
    }

    const { outputPath } = await runProbe(options);
    console.log(`Wrote sanitized Gemini quota probe report to ${outputPath}`);
    console.log(
      "AI Studio comparison is still required before production quota calculations are considered validated.",
    );
  } catch (error) {
    console.error(`Gemini quota discovery probe failed: ${error.message}`);
    process.exitCode = 1;
  }
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === currentFile) {
  await main();
}

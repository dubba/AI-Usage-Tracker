import assert from "node:assert/strict";
import test from "node:test";
import {
  fingerprint,
  knownMetricTypes,
  parseArgs,
  sanitizeJson,
  validateProjectId,
  validateProjectNumber,
} from "./gemini-quota-probe.mjs";

test("sanitizes nested credentials and project identifiers", () => {
  const sanitized = sanitizeJson(
    {
      accessToken: "secret-token",
      resource: "projects/example-project/locations/global",
      nested: {
        private_key: "secret-key",
        limit: 500,
        model: "gemini-test",
      },
    },
    ["example-project"],
    false,
  );

  assert.equal(sanitized.accessToken, "[REDACTED]");
  assert.equal(sanitized.resource, "projects/[PROJECT]/locations/global");
  assert.equal(sanitized.nested.private_key, "[REDACTED]");
  assert.equal(sanitized.nested.limit, 500);
  assert.equal(sanitized.nested.model, "gemini-test");
});

test("validates project identifiers without accepting paths or URLs", () => {
  assert.equal(validateProjectId("example-project-123"), "example-project-123");
  assert.equal(validateProjectId("1234567890"), "1234567890");
  assert.throws(() => validateProjectId("../../credentials.json"));
  assert.throws(() => validateProjectId("https://example.com"));
  assert.equal(validateProjectNumber("1234567890"), "1234567890");
  assert.throws(() => validateProjectNumber("project-123"));
});

test("project fingerprint is stable and does not reveal the identifier", () => {
  const first = fingerprint("example-project");
  const second = fingerprint("example-project");

  assert.equal(first, second);
  assert.equal(first.length, 16);
  assert.notEqual(first, "example-project");
});

test("known registry contains request and token usage and limit metrics", () => {
  const metrics = knownMetricTypes();

  assert(
    metrics.has(
      "generativelanguage.googleapis.com/quota/generate_content_free_tier_requests/usage",
    ),
  );
  assert(
    metrics.has(
      "generativelanguage.googleapis.com/quota/generate_content_free_tier_requests/limit",
    ),
  );
  assert(
    metrics.has(
      "generativelanguage.googleapis.com/quota/generate_content_free_tier_input_token_count/usage",
    ),
  );
  assert(
    metrics.has(
      "generativelanguage.googleapis.com/quota/generate_content_free_tier_input_token_count/limit",
    ),
  );
});

test("parses safe probe arguments", () => {
  const options = parseArgs([
    "--project",
    "example-project",
    "--project-number",
    "1234567890",
    "--lookback-hours",
    "72",
    "--skip-service-usage",
  ]);

  assert.equal(options.projectId, "example-project");
  assert.equal(options.projectNumber, "1234567890");
  assert.equal(options.lookbackHours, 72);
  assert.equal(options.skipServiceUsage, true);
});

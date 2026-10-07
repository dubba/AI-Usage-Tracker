import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseSemver,
  computeBasePatch,
  findNextBetaNumber,
  resolveReleaseVersion,
  applyVersionToFiles,
} from "./resolve-release-version.mjs";

test("parseSemver parses standard and prerelease semver versions", () => {
  assert.deepEqual(parseSemver("0.3.16"), {
    major: 0,
    minor: 3,
    patch: 16,
    prerelease: null,
  });

  assert.deepEqual(parseSemver("v0.3.16"), {
    major: 0,
    minor: 3,
    patch: 16,
    prerelease: null,
  });

  assert.deepEqual(parseSemver("0.3.17-beta.1"), {
    major: 0,
    minor: 3,
    patch: 17,
    prerelease: "beta.1",
  });

  assert.throws(() => parseSemver("invalid-semver"));
});

test("computeBasePatch determines next patch for stable and retains patch for prerelease", () => {
  assert.equal(computeBasePatch("0.3.16"), "0.3.17");
  assert.equal(computeBasePatch("v0.3.16"), "0.3.17");
  assert.equal(computeBasePatch("0.3.17-beta.1"), "0.3.17");
  assert.equal(computeBasePatch("1.0.0"), "1.0.1");
});

test("findNextBetaNumber increments beta sequence accurately", () => {
  // No existing beta tags
  assert.equal(findNextBetaNumber("0.3.17", ["v0.3.16", "v0.3.15"]), "0.3.17-beta.1");

  // Single existing beta tag
  assert.equal(findNextBetaNumber("0.3.17", ["v0.3.16", "v0.3.17-beta.1"]), "0.3.17-beta.2");

  // Multiple existing beta tags (including non-consecutive or mixed tags)
  assert.equal(
    findNextBetaNumber("0.3.17", [
      "v0.3.16",
      "v0.3.17-beta.1",
      "v0.3.17-beta.2",
      "v0.3.17-beta.5",
      "v0.3.18-beta.1",
    ]),
    "0.3.17-beta.6"
  );

  // Handles multi-digit numbers (numeric sort vs lexical sort check)
  assert.equal(
    findNextBetaNumber("0.3.17", [
      "v0.3.17-beta.1",
      "v0.3.17-beta.9",
      "v0.3.17-beta.10",
    ]),
    "0.3.17-beta.11"
  );
});

test("resolveReleaseVersion keeps version if not yet released", () => {
  const result = resolveReleaseVersion({
    currentVersion: "0.3.17",
    existingTags: ["v0.3.16", "v0.3.15"],
  });

  assert.equal(result.version, "0.3.17");
  assert.equal(result.isBeta, false);
  assert.equal(result.autoBumped, false);
});

test("resolveReleaseVersion keeps manual beta if not yet released", () => {
  const result = resolveReleaseVersion({
    currentVersion: "0.3.17-beta.1",
    existingTags: ["v0.3.16", "v0.3.15"],
  });

  assert.equal(result.version, "0.3.17-beta.1");
  assert.equal(result.isBeta, true);
  assert.equal(result.autoBumped, false);
});

test("resolveReleaseVersion auto-bumps to beta.1 when stable version is already released", () => {
  const result = resolveReleaseVersion({
    currentVersion: "0.3.16",
    existingTags: ["v0.3.16", "v0.3.15"],
  });

  assert.equal(result.version, "0.3.17-beta.1");
  assert.equal(result.isBeta, true);
  assert.equal(result.autoBumped, true);
});

test("resolveReleaseVersion auto-bumps to beta.2 when beta.1 was already released", () => {
  const result = resolveReleaseVersion({
    currentVersion: "0.3.16",
    existingTags: ["v0.3.16", "v0.3.17-beta.1"],
  });

  assert.equal(result.version, "0.3.17-beta.2");
  assert.equal(result.isBeta, true);
  assert.equal(result.autoBumped, true);
});

test("applyVersionToFiles correctly updates package.json, tauri.conf.json, Cargo.toml, and Cargo.lock", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "version-test-"));
  try {
    const pkgPath = join(tempDir, "package.json");
    const tauriDir = join(tempDir, "src-tauri");
    const tauriPath = join(tauriDir, "tauri.conf.json");
    const cargoPath = join(tauriDir, "Cargo.toml");
    const lockPath = join(tauriDir, "Cargo.lock");

    mkdirSync(tauriDir, { recursive: true });

    writeFileSync(pkgPath, JSON.stringify({ name: "test", version: "0.3.16" }, null, 2), "utf-8");
    writeFileSync(tauriPath, JSON.stringify({ productName: "test", version: "0.3.16" }, null, 2), "utf-8");
    writeFileSync(
      cargoPath,
      `[package]\nname = "test"\nversion = "0.3.16"\nedition = "2021"\n\n[dependencies]\naxum = "0.8"\n`,
      "utf-8"
    );
    writeFileSync(
      lockPath,
      `[[package]]\nname = "ai-usage-tracker"\nversion = "0.3.16"\ndependencies = []\n`,
      "utf-8"
    );

    applyVersionToFiles(tempDir, "0.3.17-beta.1");

    const updatedPkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    const updatedTauri = JSON.parse(readFileSync(tauriPath, "utf-8"));
    const updatedCargo = readFileSync(cargoPath, "utf-8");
    const updatedLock = readFileSync(lockPath, "utf-8");

    assert.equal(updatedPkg.version, "0.3.17-beta.1");
    assert.equal(updatedTauri.version, "0.3.17-beta.1");
    assert.match(updatedCargo, /^version = "0\.3\.17-beta\.1"$/m);
    assert.match(updatedLock, /name = "ai-usage-tracker"\r?\nversion = "0\.3\.17-beta\.1"/m);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

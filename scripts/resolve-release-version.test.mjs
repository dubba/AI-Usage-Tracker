import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseSemver,
  computeBasePatch,
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

test("resolveReleaseVersion auto-bumps to the next stable patch when the version is already released", () => {
  const result = resolveReleaseVersion({
    currentVersion: "0.3.16",
    existingTags: ["v0.3.16", "v0.3.15"],
  });

  assert.equal(result.version, "0.3.17");
  assert.equal(result.isBeta, false);
  assert.equal(result.autoBumped, true);
});

test("resolveReleaseVersion skips patch numbers that are already tagged", () => {
  const result = resolveReleaseVersion({
    currentVersion: "0.3.16",
    existingTags: ["v0.3.16", "v0.3.17", "v0.3.18"],
  });

  assert.equal(result.version, "0.3.19");
  assert.equal(result.isBeta, false);
  assert.equal(result.autoBumped, true);
});

test("resolveReleaseVersion ignores old beta tags and never produces a beta on auto-bump", () => {
  const result = resolveReleaseVersion({
    currentVersion: "0.4.0",
    existingTags: ["v0.4.0", "v0.4.1-beta.1", "v0.4.1-beta.2"],
  });

  assert.equal(result.version, "0.4.1");
  assert.equal(result.isBeta, false);
  assert.equal(result.autoBumped, true);
});

test("resolveReleaseVersion graduates a released beta to its stable patch", () => {
  const result = resolveReleaseVersion({
    currentVersion: "0.4.2-beta.1",
    existingTags: ["v0.4.1", "v0.4.2-beta.1"],
  });

  assert.equal(result.version, "0.4.2");
  assert.equal(result.isBeta, false);
  assert.equal(result.autoBumped, true);
});

test("resolveReleaseVersion matches tags with or without a leading v", () => {
  const result = resolveReleaseVersion({
    currentVersion: "0.3.16",
    existingTags: ["0.3.16"],
  });

  assert.equal(result.version, "0.3.17");
  assert.equal(result.autoBumped, true);
});

test("applyVersionToFiles correctly updates package.json, package-lock.json, tauri.conf.json, Cargo.toml, and Cargo.lock", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "version-test-"));
  try {
    const pkgPath = join(tempDir, "package.json");
    const tauriDir = join(tempDir, "src-tauri");
    const tauriPath = join(tauriDir, "tauri.conf.json");
    const cargoPath = join(tauriDir, "Cargo.toml");
    const lockPath = join(tauriDir, "Cargo.lock");
    const npmLockPath = join(tempDir, "package-lock.json");

    mkdirSync(tauriDir, { recursive: true });

    writeFileSync(pkgPath, JSON.stringify({ name: "test", version: "0.3.16" }, null, 2), "utf-8");
    writeFileSync(tauriPath, JSON.stringify({ productName: "test", version: "0.3.16" }, null, 2), "utf-8");
    writeFileSync(
      npmLockPath,
      JSON.stringify(
        { name: "test", version: "0.3.16", lockfileVersion: 3, packages: { "": { name: "test", version: "0.3.16" } } },
        null,
        2
      ) + "\n",
      "utf-8"
    );
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
    const updatedNpmLock = JSON.parse(readFileSync(npmLockPath, "utf-8"));
    assert.equal(updatedNpmLock.version, "0.3.17-beta.1");
    assert.equal(updatedNpmLock.packages[""].version, "0.3.17-beta.1");
    assert.match(updatedCargo, /^version = "0\.3\.17-beta\.1"$/m);
    assert.match(updatedLock, /name = "ai-usage-tracker"\r?\nversion = "0\.3\.17-beta\.1"/m);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  isPrerelease,
  extractChangelogNotes,
  applyRelease,
  validateSource,
  SOURCE_URL,
} from "./update-sidestore-source.mjs";

const script = fileURLToPath(new URL("./update-sidestore-source.mjs", import.meta.url));

const baseSource = () => ({
  name: "AI Usage Tracker",
  identifier: "com.example.source",
  apps: [{ name: "App", bundleIdentifier: "com.example.app", version: "0.0.1", size: 0, downloadURL: "x" }],
});

test("isPrerelease detects beta suffixes", () => {
  assert.equal(isPrerelease("0.3.17"), false);
  assert.equal(isPrerelease("v0.3.17"), false);
  assert.equal(isPrerelease("0.3.17-beta.1"), true);
});

test("extractChangelogNotes reads the matching version section", () => {
  const changelog = "# Changelog\n\n## Unreleased (1 items)\n\n- next thing\n\n## 0.3.16 - 2026-10-06 (2 items)\n\n### Added\n\n- one\n- two\n\n## 0.3.15 - x\n\n- old\n";
  assert.equal(extractChangelogNotes(changelog, "0.3.16"), "one\ntwo");
  assert.equal(extractChangelogNotes(changelog, "9.9.9"), "next thing");
});

test("applyRelease sets version, exact size, minOSVersion and sourceURL", () => {
  const source = applyRelease(baseSource(), { version: "v0.3.17", size: 12345, date: "2026-10-07T00:00:00Z", notes: "" });
  const app = source.apps[0];
  assert.equal(source.sourceURL, SOURCE_URL);
  assert.equal(app.version, "0.3.17");
  assert.equal(app.size, 12345);
  assert.equal(app.minOSVersion, "16.0");
  assert.equal(app.versionDescription, "Release v0.3.17");
  assert.match(app.downloadURL, /\/releases\/download\/v0\.3\.17\/AI-Usage-Tracker\.ipa$/);
  assert.deepEqual(validateSource(source), []);
});

test("validateSource rejects a zero size", () => {
  const source = applyRelease(baseSource(), { version: "0.3.17", size: 0, date: "d", notes: "" });
  assert.ok(validateSource(source).some((e) => e.includes("size")));
});

test("CLI measures the IPA and leaves the file untouched for pre-releases", () => {
  const dir = mkdtempSync(join(tmpdir(), "sidestore-"));
  try {
    const file = join(dir, "source.json");
    const ipa = join(dir, "App.ipa");
    writeFileSync(file, JSON.stringify(baseSource()));
    writeFileSync(ipa, Buffer.alloc(4321));

    execFileSync("node", [script, "--file", file, "--ipa", ipa, "--version", "0.3.17"]);
    assert.equal(JSON.parse(readFileSync(file, "utf-8")).apps[0].size, 4321);

    const before = readFileSync(file, "utf-8");
    execFileSync("node", [script, "--file", file, "--ipa", ipa, "--version", "0.3.18-beta.1"]);
    assert.equal(readFileSync(file, "utf-8"), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildTauriDevArgs, DEV_IDENTITY_CONFIG } from "./tauri-dev.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("the dev app has its own identifier and name, so it shares no data folder or launch-at-startup entry", () => {
  const dev = JSON.parse(readFileSync(resolve(root, DEV_IDENTITY_CONFIG), "utf-8"));
  const main = JSON.parse(readFileSync(resolve(root, "src-tauri/tauri.conf.json"), "utf-8"));
  // The identifier picks the data folder.
  assert.equal(dev.identifier, `${main.identifier}.dev`);
  // The name picks the launch-at-startup entry (the macOS LaunchAgent and the
  // Windows Run value), which "Delete local app data" turns off.
  assert.equal(dev.productName, `${main.productName} Dev`);
  assert.deepEqual(Object.keys(dev).sort(), ["identifier", "productName"], "the dev config changes nothing else");
});

test("every dev run passes the dev identity first", () => {
  for (const [args, portInUse] of [[[], false], [[], true], [["--verbose"], true], [["--config", "x.json"], true]]) {
    assert.deepEqual(buildTauriDevArgs(args, portInUse).slice(0, 3), ["dev", "--config", DEV_IDENTITY_CONFIG]);
  }
});

test("a running dev server is reused unless the caller passes its own --config", () => {
  assert.deepEqual(buildTauriDevArgs([], false), ["dev", "--config", DEV_IDENTITY_CONFIG]);
  assert.deepEqual(buildTauriDevArgs([], true), [
    "dev", "--config", DEV_IDENTITY_CONFIG, "--config", '{"build":{"beforeDevCommand":""}}',
  ]);
  assert.deepEqual(buildTauriDevArgs(["--config", "x.json"], true), [
    "dev", "--config", DEV_IDENTITY_CONFIG, "--config", "x.json",
  ]);
});

test("the shell launcher passes the same dev identity", () => {
  const sh = readFileSync(resolve(root, "scripts/tauri-dev.sh"), "utf-8");
  assert.ok(sh.includes(`DEV_CONFIG="${DEV_IDENTITY_CONFIG}"`));
  for (const line of sh.split("\n").filter((l) => /npx tauri dev/.test(l))) {
    assert.match(line, /--config "\$DEV_CONFIG"/, line.trim());
  }
});

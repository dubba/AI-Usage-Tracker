import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getMacosDataDirectories,
  isAllowedMacosDataPath,
  isTempProfileName,
  loadUninstallRules,
  rulesPath,
  scriptPath,
} from "./macos-uninstall-targets.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("macOS uninstall rules match tauri config and repository constants", () => {
  assert.ok(existsSync(rulesPath), "uninstall-rules.json exists");
  assert.ok(existsSync(scriptPath), "uninstall-macos.sh exists");

  const rules = loadUninstallRules();
  const tauriConf = JSON.parse(readFileSync(join(root, "src-tauri/tauri.conf.json"), "utf8"));

  assert.equal(rules.bundleId, tauriConf.identifier);

  const keyringSource = readFileSync(
    join(root, "src-tauri/src/store/credentials/keyring_store.rs"),
    "utf8"
  );
  assert.ok(keyringSource.includes(`"${rules.credentialServices[0]}"`));
  assert.ok(keyringSource.includes(`"${rules.credentialServices[1]}"`));

  const scriptText = readFileSync(scriptPath, "utf8");
  assert.ok(scriptText.includes(`BUNDLE_ID="${rules.bundleId}"`));
  assert.ok(scriptText.includes(`SERVICES=("${rules.credentialServices[0]}" "${rules.credentialServices[1]}")`));
  assert.ok(scriptText.includes("security delete-generic-password"));
  assert.ok(scriptText.includes("defaults delete"));
});

test("getMacosDataDirectories produces all required Library subdirectories", () => {
  const home = "/Users/testuser";
  const bundleId = "com.dubba.ai.usage.tracker";
  const targets = getMacosDataDirectories(home, bundleId);

  assert.equal(targets.length, 6);
  assert.ok(targets.includes(join(home, "Library/Application Support", bundleId)));
  assert.ok(targets.includes(join(home, "Library/Caches", bundleId)));
  assert.ok(targets.includes(join(home, "Library/WebKit", bundleId)));
  assert.ok(targets.includes(join(home, "Library/HTTPStorages", bundleId)));
  assert.ok(targets.includes(join(home, "Library/Saved Application State", `${bundleId}.savedState`)));
  assert.ok(targets.includes(join(home, "Library/Preferences", `${bundleId}.plist`)));
});

test("isAllowedMacosDataPath strictly validates allowed paths and rejects traversal", () => {
  const home = "/Users/testuser";
  const bundleId = "com.dubba.ai.usage.tracker";

  // Valid paths
  assert.equal(
    isAllowedMacosDataPath(join(home, "Library/Application Support", bundleId), home, bundleId),
    true
  );
  assert.equal(
    isAllowedMacosDataPath(join(home, "Library/WebKit", bundleId), home, bundleId),
    true
  );
  assert.equal(
    isAllowedMacosDataPath(join(home, "Library/Preferences", `${bundleId}.plist`), home, bundleId),
    true
  );

  // Traversal attempts
  assert.equal(
    isAllowedMacosDataPath(join(home, "Library/Application Support/../escape"), home, bundleId),
    false
  );
  assert.equal(
    isAllowedMacosDataPath(join(home, "Library/Application Support", `${bundleId}/../other`), home, bundleId),
    false
  );
  assert.equal(
    isAllowedMacosDataPath("/Users/otheruser/Library/Application Support/com.dubba.ai.usage.tracker", home, bundleId),
    false
  );
  assert.equal(
    isAllowedMacosDataPath(join(home, "Documents"), home, bundleId),
    false
  );
  assert.equal(
    isAllowedMacosDataPath(join(home, "Library/Application Support/other.app"), home, bundleId),
    false
  );
});

test("isTempProfileName matches profile directories and rejects traversal", () => {
  const rules = loadUninstallRules();

  // Valid temporary login profiles
  assert.equal(isTempProfileName("ai-usage-grok-uuid-1", rules), true);
  assert.equal(isTempProfileName("ai-usage-oauth-uuid-2", rules), true);
  assert.equal(isTempProfileName("ai-usage-opencode-uuid-3", rules), true);

  // Traversal and separator rejection
  assert.equal(isTempProfileName("ai-usage-grok-../escape", rules), false);
  assert.equal(isTempProfileName("ai-usage-grok-a/b", rules), false);
  assert.equal(isTempProfileName("ai-usage-grok-a\\b", rules), false);
  assert.equal(isTempProfileName("ai-usage-grok-.", rules), false);
  assert.equal(isTempProfileName("ai-usage-grok-..", rules), false);

  // Empty attempt id
  assert.equal(isTempProfileName("ai-usage-grok-", rules), false);

  // Other prefixes
  assert.equal(isTempProfileName("chrome-profile-uuid-1", rules), false);
  assert.equal(isTempProfileName("ai-usage-other-uuid-1", rules), false);

  // Length limits
  assert.equal(isTempProfileName(`ai-usage-grok-${"a".repeat(200)}`, rules), false);
});

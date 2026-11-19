import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
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

// Runs the real script against a throwaway HOME, with stand-ins for the macOS
// commands it calls. `security` deletes `deletions` entries, then exits with
// `finalStatus` (44 is errSecItemNotFound: nothing left).
function runUninstaller({ finalStatus = 44, deletions = 0 } = {}) {
  const sandbox = mkdtempSync(join(tmpdir(), "uninstall-macos-test-"));
  const home = join(sandbox, "home");
  const bin = join(sandbox, "bin");
  const agents = join(home, "Library", "LaunchAgents");
  mkdirSync(agents, { recursive: true });
  mkdirSync(bin);
  const log = join(sandbox, "calls.log");
  const stub = (name, body) => {
    writeFileSync(join(bin, name), `#!/bin/bash\necho "${name} $*" >> "${log}"\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  stub(
    "security",
    `n=$(cat "${sandbox}/deleted" 2>/dev/null || echo 0)
if [ "$n" -lt ${deletions} ]; then echo $((n + 1)) > "${sandbox}/deleted"; exit 0; fi
exit ${finalStatus}`
  );
  stub("launchctl", "exit 0");
  stub("pgrep", "exit 1");
  stub("defaults", "exit 0");
  const ours = join(agents, "AI Usage Tracker.plist");
  const other = join(agents, "com.example.other.plist");
  writeFileSync(ours, "<plist/>");
  writeFileSync(other, "<plist/>");
  const result = spawnSync("bash", [scriptPath, "--yes"], {
    encoding: "utf8",
    env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, TMPDIR: join(sandbox, "tmp") },
  });
  const calls = existsSync(log) ? readFileSync(log, "utf8") : "";
  const state = { result, calls, ourPlistLeft: existsSync(ours), otherPlistLeft: existsSync(other) };
  rmSync(sandbox, { recursive: true, force: true });
  return state;
}

test("the uninstaller removes this app's launch-at-startup entry and nothing else", () => {
  const { result, calls, ourPlistLeft, otherPlistLeft } = runUninstaller();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(ourPlistLeft, false);
  assert.equal(otherPlistLeft, true);
  assert.match(calls, /^launchctl bootout gui\/\d+\/AI Usage Tracker$/m);
  assert.match(result.stdout, /All data and credentials cleared/);
});

test("the uninstaller reports success when the Keychain has nothing left to delete", () => {
  const { result } = runUninstaller({ deletions: 3 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Removed 3 Keychain entry\(ies\) for 'ai-usage-tracker'/);
  assert.match(result.stdout, /All data and credentials cleared/);
});

test("the uninstaller does not claim success when a Keychain delete fails", () => {
  // 51 is errSecAuthFailed, e.g. the user denied access.
  const { result } = runUninstaller({ deletions: 1, finalStatus: 51 });
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stdout, /All data and credentials cleared/);
  assert.match(result.stderr, /only partly uninstalled/);
  assert.match(result.stderr, /Keychain credentials for service 'ai-usage-tracker' \(security exit 51\)/);
});

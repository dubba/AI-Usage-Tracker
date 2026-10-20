import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  hookPath,
  isCredentialTarget,
  isTempProfileName,
  loadUninstallRules,
  rulesPath,
  scriptPath,
} from "./windows-uninstall-targets.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("uninstall rules match the tauri config and repository constants", () => {
  assert.ok(existsSync(rulesPath), "uninstall-rules.json exists");
  assert.ok(existsSync(hookPath), "hooks.nsh exists");
  assert.ok(existsSync(scriptPath), "remove-windows-credentials.ps1 exists");

  const rules = loadUninstallRules();
  const tauriConf = JSON.parse(readFileSync(join(root, "src-tauri/tauri.conf.json"), "utf8"));

  assert.equal(tauriConf.bundle?.windows?.nsis?.installerHooks, "windows/hooks.nsh");
  assert.equal(rules.bundleId, tauriConf.identifier);

  const keyringSource = readFileSync(
    join(root, "src-tauri/src/store/credentials/keyring_store.rs"),
    "utf8"
  );
  assert.ok(keyringSource.includes(`"${rules.credentialServices[0]}"`));
  assert.ok(keyringSource.includes(`"${rules.credentialServices[1]}"`));
  assert.ok(keyringSource.includes(`"${rules.bridgeTokenUser}"`));
  assert.ok(keyringSource.includes(`"${rules.accountUserPrefix}`));
  assert.ok(keyringSource.includes(rules.chunkMarker));

  const hookText = readFileSync(hookPath, "utf8");
  assert.ok(hookText.includes("NSIS_HOOK_POSTUNINSTALL"));
  assert.ok(hookText.includes("remove-windows-credentials.ps1"));
  assert.ok(hookText.includes("uninstall-rules.json"));
  assert.ok(hookText.includes("AIUT_RemoveBundleDir"));
  assert.ok(hookText.includes("InitPluginsDir"));
});

test("isCredentialTarget identifies unchunked and chunked account targets", () => {
  const rules = loadUninstallRules();

  // Valid account targets on current and legacy services
  assert.equal(isCredentialTarget("account:acc-1.ai-usage-tracker", rules), true);
  assert.equal(isCredentialTarget("account:acc-1.paseo-usage-bridge", rules), true);
  assert.equal(isCredentialTarget("account:uuid_1234-abcd.ai-usage-tracker", rules), true);

  // Valid chunked account targets
  const validGen = "A1b2C3d4E5f6G7h8";
  assert.equal(
    isCredentialTarget(`account:acc-1:chunk:${validGen}:0.ai-usage-tracker`, rules),
    true
  );
  assert.equal(
    isCredentialTarget(`account:acc-1:chunk:${validGen}:31.ai-usage-tracker`, rules),
    true
  );
  assert.equal(
    isCredentialTarget(`account:acc-1:chunk:${validGen}:5.paseo-usage-bridge`, rules),
    true
  );

  // Valid bridge tokens
  assert.equal(isCredentialTarget("bridge-api-token.ai-usage-tracker", rules), true);
  assert.equal(isCredentialTarget("bridge-api-token.paseo-usage-bridge", rules), true);
});

test("isCredentialTarget rejects invalid or unrelated targets", () => {
  const rules = loadUninstallRules();
  const validGen = "A1b2C3d4E5f6G7h8";

  // Other services
  assert.equal(isCredentialTarget("account:acc-1.other-service", rules), false);
  assert.equal(isCredentialTarget("bridge-api-token.discord", rules), false);

  // Chunk index out of range
  assert.equal(
    isCredentialTarget(`account:acc-1:chunk:${validGen}:32.ai-usage-tracker`, rules),
    false
  );
  assert.equal(
    isCredentialTarget(`account:acc-1:chunk:${validGen}:-1.ai-usage-tracker`, rules),
    false
  );
  assert.equal(
    isCredentialTarget(`account:acc-1:chunk:${validGen}:abc.ai-usage-tracker`, rules),
    false
  );

  // Generation length must be 16
  assert.equal(
    isCredentialTarget("account:acc-1:chunk:tooshort:0.ai-usage-tracker", rules),
    false
  );
  assert.equal(
    isCredentialTarget(`account:acc-1:chunk:${validGen}extra:0.ai-usage-tracker`, rules),
    false
  );

  // Malformed account ID
  assert.equal(isCredentialTarget("account:../traversal.ai-usage-tracker", rules), false);
  assert.equal(isCredentialTarget("account:has spaces.ai-usage-tracker", rules), false);
  assert.equal(isCredentialTarget("account:.ai-usage-tracker", rules), false);

  // Whitespace / null bytes / slashes
  assert.equal(isCredentialTarget(" account:acc-1.ai-usage-tracker", rules), false);
  assert.equal(isCredentialTarget("account:acc-1.ai-usage-tracker\0", rules), false);
  assert.equal(isCredentialTarget("account:acc-1/extra.ai-usage-tracker", rules), false);

  // Over max target length
  assert.equal(
    isCredentialTarget(`account:${"a".repeat(250)}.ai-usage-tracker`, rules),
    false
  );

  // Non-strings or empty
  assert.equal(isCredentialTarget("", rules), false);
  assert.equal(isCredentialTarget(null, rules), false);
  assert.equal(isCredentialTarget(undefined, rules), false);
  assert.equal(isCredentialTarget(12345, rules), false);
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

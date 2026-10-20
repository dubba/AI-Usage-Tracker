import { readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export const rulesPath = join(root, "src-tauri/windows/uninstall-rules.json");
export const scriptPath = join(root, "scripts/uninstall-macos.sh");

export function loadUninstallRules() {
  return JSON.parse(readFileSync(rulesPath, "utf8"));
}

/**
 * Standard macOS user library target locations for an application bundle ID.
 */
export function getMacosDataDirectories(homeDir, bundleId) {
  if (typeof homeDir !== "string" || !homeDir || typeof bundleId !== "string" || !bundleId) {
    return [];
  }
  return [
    join(homeDir, "Library", "Application Support", bundleId),
    join(homeDir, "Library", "Caches", bundleId),
    join(homeDir, "Library", "WebKit", bundleId),
    join(homeDir, "Library", "HTTPStorages", bundleId),
    join(homeDir, "Library", "Saved Application State", `${bundleId}.savedState`),
    join(homeDir, "Library", "Preferences", `${bundleId}.plist`),
  ];
}

/**
 * Validates that candidate target path strictly belongs to the user's Library
 * and matches the app bundle ID, rejecting any path traversal or out-of-scope targets.
 */
export function isAllowedMacosDataPath(candidatePath, homeDir, bundleId) {
  if (typeof candidatePath !== "string" || typeof homeDir !== "string" || typeof bundleId !== "string") {
    return false;
  }
  const cleanCandidate = normalize(candidatePath);
  const cleanHome = normalize(homeDir);

  if (!cleanCandidate.startsWith(join(cleanHome, "Library"))) {
    return false;
  }
  const allowed = getMacosDataDirectories(cleanHome, bundleId).map((p) => normalize(p));
  return allowed.includes(cleanCandidate);
}

/** A temp login-profile directory name. One path segment, never `..`. */
export function isTempProfileName(name, rules = loadUninstallRules()) {
  if (typeof name !== "string" || name.length === 0 || name.length > 160) return false;
  if (name.includes("\\") || name.includes("/") || name.includes("..") || name.includes(".")) {
    return false;
  }
  const prefixes = Array.isArray(rules.tempProfilePrefixes) ? rules.tempProfilePrefixes : [];
  const attemptId = new RegExp(rules.attemptIdPattern);
  for (const prefix of prefixes) {
    if (!/^ai-usage-[a-z]+-$/.test(prefix)) continue;
    if (!name.startsWith(prefix)) continue;
    if (attemptId.test(name.slice(prefix.length))) return true;
  }
  return false;
}

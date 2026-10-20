import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export const rulesPath = join(root, "src-tauri/windows/uninstall-rules.json");
export const hookPath = join(root, "src-tauri/windows/hooks.nsh");
export const scriptPath = join(root, "src-tauri/windows/remove-windows-credentials.ps1");

export function loadUninstallRules() {
  return JSON.parse(readFileSync(rulesPath, "utf8"));
}

function text(value) {
  return typeof value === "string" ? value : "";
}

/**
 * Windows Credential Manager target written by keyring 3:
 * `{user}.{service}` (user first). Only this app's services and user shapes match.
 */
export function isCredentialTarget(target, rules = loadUninstallRules()) {
  if (typeof target !== "string" || target.length === 0 || target.length > rules.maxTargetLength) {
    return false;
  }
  if (/[\s\u0000\\/]/.test(target)) return false;
  const services = Array.isArray(rules.credentialServices) ? rules.credentialServices : [];
  for (const service of services) {
    if (!/^[a-z0-9-]+$/.test(service)) continue;
    const suffix = `.${service}`;
    if (!target.endsWith(suffix)) continue;
    const user = target.slice(0, -suffix.length);
    if (isCredentialUser(user, rules)) return true;
  }
  return false;
}

function isCredentialUser(user, rules) {
  if (user === text(rules.bridgeTokenUser) && user.length > 0) return true;
  const prefix = text(rules.accountUserPrefix);
  if (prefix.length === 0 || !user.startsWith(prefix)) return false;
  const rest = user.slice(prefix.length);
  const accountId = new RegExp(rules.accountIdPattern);
  const marker = text(rules.chunkMarker);
  const chunkAt = marker.length === 0 ? -1 : rest.indexOf(marker);
  if (chunkAt < 0) return accountId.test(rest);
  const id = rest.slice(0, chunkAt);
  const after = rest.slice(chunkAt + marker.length);
  const colon = after.lastIndexOf(":");
  if (colon <= 0) return false;
  const generation = after.slice(0, colon);
  const indexText = after.slice(colon + 1);
  if (!accountId.test(id) || !new RegExp(rules.generationPattern).test(generation)) return false;
  if (!/^[0-9]{1,2}$/.test(indexText)) return false;
  const index = Number(indexText);
  return Number.isInteger(index) && index >= 0 && index <= rules.maxChunkIndex;
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

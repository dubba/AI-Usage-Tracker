#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "..");
const defaultPackageJsonPath = resolve(rootDir, "package.json");
const defaultTauriConfPath = resolve(rootDir, "src-tauri/tauri.conf.json");
const defaultCargoTomlPath = resolve(rootDir, "src-tauri/Cargo.toml");

export function parseSemver(versionStr) {
  const clean = versionStr.trim().replace(/^v/i, "");
  const match = clean.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) {
    throw new Error(`Invalid SemVer version string: "${versionStr}"`);
  }
  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10),
    prerelease: match[4] || null,
  };
}

export function computeBasePatch(versionStr) {
  const semver = parseSemver(versionStr);
  if (semver.prerelease) {
    return `${semver.major}.${semver.minor}.${semver.patch}`;
  }
  return `${semver.major}.${semver.minor}.${semver.patch + 1}`;
}

/**
 * Picks the version to release.
 *
 * A version that has no tag yet ships as written, so a manual beta such as
 * "0.5.0-beta.1" still releases as a pre-release. A version that already has a
 * tag is bumped to the next unreleased stable patch (0.4.1 -> 0.4.2), skipping
 * any patch numbers that are already tagged.
 */
export function resolveReleaseVersion({ currentVersion, existingTags = [] }) {
  const cleanVersion = currentVersion.trim().replace(/^v/i, "");
  const releasedVersions = new Set(existingTags.map((tag) => tag.trim().replace(/^v/i, "")));

  if (!releasedVersions.has(cleanVersion)) {
    return {
      version: cleanVersion,
      isBeta: cleanVersion.includes("-"),
      autoBumped: false,
      basePatch: cleanVersion.split("-")[0],
    };
  }

  const { major, minor, patch } = parseSemver(computeBasePatch(cleanVersion));
  let nextPatch = patch;
  while (releasedVersions.has(`${major}.${minor}.${nextPatch}`)) {
    nextPatch += 1;
  }
  const version = `${major}.${minor}.${nextPatch}`;

  return {
    version,
    isBeta: false,
    autoBumped: true,
    basePatch: version,
  };
}

export function applyVersionToFiles(
  baseDir = rootDir,
  targetVersion,
  {
    updatePackage = true,
    updateTauri = true,
    updateCargo = true,
    updateLock = true,
    updateNpmLock = true,
  } = {}
) {
  const clean = targetVersion.trim().replace(/^v/i, "");
  const pkgPath = resolve(baseDir, "package.json");
  const npmLockPath = resolve(baseDir, "package-lock.json");
  const tauriPath = resolve(baseDir, "src-tauri/tauri.conf.json");
  const cargoPath = resolve(baseDir, "src-tauri/Cargo.toml");
  const lockPath = resolve(baseDir, "src-tauri/Cargo.lock");

  if (updatePackage && existsSync(pkgPath)) {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    pkg.version = clean;
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf-8");
  }

  if (updateNpmLock && existsSync(npmLockPath)) {
    const npmLock = JSON.parse(readFileSync(npmLockPath, "utf-8"));
    npmLock.version = clean;
    if (npmLock.packages && npmLock.packages[""]) {
      npmLock.packages[""].version = clean;
    }
    writeFileSync(npmLockPath, JSON.stringify(npmLock, null, 2) + "\n", "utf-8");
  }

  if (updateTauri && existsSync(tauriPath)) {
    const conf = JSON.parse(readFileSync(tauriPath, "utf-8"));
    conf.version = clean;
    writeFileSync(tauriPath, JSON.stringify(conf, null, 2) + "\n", "utf-8");
  }

  if (updateCargo && existsSync(cargoPath)) {
    let cargo = readFileSync(cargoPath, "utf-8");
    cargo = cargo.replace(
      /(\[package\][\s\S]*?^version\s*=\s*")[^"]*(")/m,
      `$1${clean}$2`
    );
    writeFileSync(cargoPath, cargo, "utf-8");
  }

  if (updateLock && existsSync(lockPath)) {
    let lock = readFileSync(lockPath, "utf-8");
    lock = lock.replace(
      /(\[\[package\]\]\r?\nname\s*=\s*"ai-usage-tracker"\r?\nversion\s*=\s*")[^"]*(")/m,
      `$1${clean}$2`
    );
    writeFileSync(lockPath, lock, "utf-8");
  }
}

export function fetchExistingTags(customTags = null) {
  if (customTags && customTags.length > 0) {
    return customTags;
  }

  const tags = new Set();

  try {
    const gitTags = execSync("git tag -l", { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
    for (const tag of gitTags.split("\n")) {
      const trimmed = tag.trim();
      if (trimmed) tags.add(trimmed);
    }
  } catch {
    // Ignore git failure if not in git repo or git missing
  }

  try {
    const ghReleases = execSync("gh release list --limit 100 --json tagName -q '.[].tagName'", {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    for (const tag of ghReleases.split("\n")) {
      const trimmed = tag.trim();
      if (trimmed) tags.add(trimmed);
    }
  } catch {
    // Ignore gh failure if gh not authenticated or absent
  }

  return Array.from(tags);
}

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    apply: false,
    explicitVersion: null,
    tags: null,
    githubOutput: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--apply") {
      options.apply = true;
    } else if (arg === "--version" && i + 1 < args.length) {
      options.explicitVersion = args[++i];
    } else if (arg === "--tags" && i + 1 < args.length) {
      options.tags = args[++i].split(",").map((s) => s.trim()).filter(Boolean);
    } else if (arg === "--github-output") {
      options.githubOutput = true;
    }
  }

  return options;
}

function main() {
  const options = parseArgs();

  let targetVersion = options.explicitVersion;
  let isBeta = false;
  let autoBumped = false;

  if (targetVersion) {
    targetVersion = targetVersion.replace(/^v/i, "");
    isBeta = targetVersion.includes("-");
  } else {
    let currentVersion = "0.0.0";
    if (existsSync(defaultPackageJsonPath)) {
      const pkg = JSON.parse(readFileSync(defaultPackageJsonPath, "utf-8"));
      currentVersion = pkg.version;
    }
    const tags = fetchExistingTags(options.tags);
    const resolved = resolveReleaseVersion({ currentVersion, existingTags: tags });
    targetVersion = resolved.version;
    isBeta = resolved.isBeta;
    autoBumped = resolved.autoBumped;
  }

  console.log(`Resolved release version: ${targetVersion} (is_beta: ${isBeta}, auto_bumped: ${autoBumped})`);

  if (options.apply) {
    applyVersionToFiles(rootDir, targetVersion);
    console.log(
      `Applied version ${targetVersion} to package.json, package-lock.json, tauri.conf.json, Cargo.toml, and Cargo.lock`
    );
  }

  if (options.githubOutput || process.env.GITHUB_OUTPUT) {
    const outputPath = process.env.GITHUB_OUTPUT;
    if (outputPath && existsSync(outputPath)) {
      const content = [
        `version=${targetVersion}`,
        `tag_name=v${targetVersion}`,
        `is_beta=${isBeta ? "true" : "false"}`,
        `auto_bumped=${autoBumped ? "true" : "false"}`,
        "",
      ].join("\n");
      writeFileSync(outputPath, content, { flag: "a", encoding: "utf-8" });
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}

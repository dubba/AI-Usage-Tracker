#!/usr/bin/env node
import { readFileSync, writeFileSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "..");
const defaultSourcePath = resolve(rootDir, "sidestore-source.json");
const packageJsonPath = resolve(rootDir, "package.json");
const changelogPath = resolve(rootDir, "CHANGELOG.md");

const REPO = "dubba/AI-Usage-Tracker";
export const SOURCE_URL = `https://raw.githubusercontent.com/${REPO}/main/sidestore-source.json`;
export const MIN_OS_VERSION = "16.0";

export function normalizeVersion(version) {
  return String(version).trim().replace(/^v/i, "");
}

export function isPrerelease(version) {
  return normalizeVersion(version).includes("-");
}

/** Bullet text of a changelog section ("Unreleased" or a version), or "" when absent. */
export function extractChangelogNotes(changelog, version) {
  const lines = changelog.split(/\r?\n/);
  const heading = (line) => /^## /.test(line);
  const find = (prefix) => lines.findIndex((line) => heading(line) && line.startsWith(prefix));
  let start = find(`## ${normalizeVersion(version)} `);
  if (start === -1) start = find("## Unreleased");
  if (start === -1) return "";
  const notes = [];
  for (let i = start + 1; i < lines.length && !heading(lines[i]); i++) {
    if (lines[i].startsWith("- ")) notes.push(lines[i].slice(2).trim());
  }
  return notes.join("\n");
}

export function applyRelease(source, { version, size, date, notes, downloadUrl }) {
  const clean = normalizeVersion(version);
  const app = source.apps?.[0];
  if (!app) throw new Error("No apps defined in source json");
  source.sourceURL = SOURCE_URL;
  app.version = clean;
  app.versionDate = date;
  app.versionDescription = notes || `Release v${clean}`;
  app.downloadURL = downloadUrl || `https://github.com/${REPO}/releases/download/v${clean}/AI-Usage-Tracker.ipa`;
  app.minOSVersion = MIN_OS_VERSION;
  if (typeof size === "number" && Number.isInteger(size) && size > 0) app.size = size;
  return source;
}

export function validateSource(source) {
  const errors = [];
  if (!source.name || !source.identifier || !Array.isArray(source.apps) || !source.apps.length) {
    errors.push("missing name, identifier or apps");
    return errors;
  }
  const app = source.apps[0];
  if (!source.sourceURL) errors.push("missing sourceURL");
  if (!app.bundleIdentifier) errors.push("missing bundleIdentifier");
  if (!app.downloadURL) errors.push("missing downloadURL");
  if (!app.minOSVersion) errors.push("missing minOSVersion");
  if (!Number.isInteger(app.size) || app.size <= 0) errors.push("size must be the IPA's exact byte count (> 0)");
  return errors;
}

function parseArgs(args) {
  const options = { sourcePath: defaultSourcePath, version: null, size: null, ipaPath: null, downloadUrl: null, date: null, check: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--file") options.sourcePath = resolve(process.cwd(), args[++i]);
    else if (arg === "--ipa") options.ipaPath = resolve(process.cwd(), args[++i]);
    else if (arg === "--version") options.version = args[++i];
    else if (arg === "--size") options.size = parseInt(args[++i], 10);
    else if (arg === "--download-url") options.downloadUrl = args[++i];
    else if (arg === "--date") options.date = args[++i];
    else if (arg === "--check") options.check = true;
  }
  return options;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const source = JSON.parse(readFileSync(opts.sourcePath, "utf-8"));

  if (opts.check) {
    const errors = validateSource(source);
    if (errors.length) {
      console.error(`Invalid SideStore source ${opts.sourcePath}: ${errors.join("; ")}`);
      process.exit(1);
    }
    console.log(`SideStore source valid: ${source.apps[0].name} v${source.apps[0].version}`);
    return;
  }

  const version = normalizeVersion(opts.version || JSON.parse(readFileSync(packageJsonPath, "utf-8")).version);
  if (isPrerelease(version)) {
    console.log(`Skipping SideStore source update: ${version} is a pre-release and the main source lists stable releases only.`);
    return;
  }

  const size = opts.ipaPath ? statSync(opts.ipaPath).size : opts.size;
  let notes = "";
  try {
    notes = extractChangelogNotes(readFileSync(changelogPath, "utf-8"), version);
  } catch {
    // changelog is optional
  }

  applyRelease(source, {
    version,
    size,
    date: opts.date || new Date().toISOString(),
    notes,
    downloadUrl: opts.downloadUrl,
  });
  writeFileSync(opts.sourcePath, JSON.stringify(source, null, 2) + "\n", "utf-8");
  console.log(`Updated SideStore source ${opts.sourcePath}: v${version}, size: ${source.apps[0].size} bytes`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

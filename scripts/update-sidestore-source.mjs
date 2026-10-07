#!/usr/bin/env node
import { readFileSync, writeFileSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "..");
const defaultSourcePath = resolve(rootDir, "sidestore-source.json");
const packageJsonPath = resolve(rootDir, "package.json");

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    sourcePath: defaultSourcePath,
    version: null,
    size: null,
    ipaPath: null,
    downloadUrl: null,
    date: null,
    check: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--file" && i + 1 < args.length) {
      options.sourcePath = resolve(process.cwd(), args[++i]);
    } else if (arg === "--ipa" && i + 1 < args.length) {
      options.ipaPath = resolve(process.cwd(), args[++i]);
    } else if (arg === "--version" && i + 1 < args.length) {
      options.version = args[++i];
    } else if (arg === "--size" && i + 1 < args.length) {
      options.size = parseInt(args[++i], 10);
    } else if (arg === "--download-url" && i + 1 < args.length) {
      options.downloadUrl = args[++i];
    } else if (arg === "--date" && i + 1 < args.length) {
      options.date = args[++i];
    } else if (arg === "--check") {
      options.check = true;
    }
  }

  return options;
}

function main() {
  const opts = parseArgs();
  const sourceRaw = readFileSync(opts.sourcePath, "utf-8");
  const source = JSON.parse(sourceRaw);

  if (opts.check) {
    if (!source.name || !source.identifier || !Array.isArray(source.apps) || !source.apps.length) {
      console.error("Invalid SideStore source schema in", opts.sourcePath);
      process.exit(1);
    }
    console.log("SideStore source schema valid:", source.apps[0].name, "v" + source.apps[0].version);
    return;
  }

  let pkgVersion = "0.0.0";
  try {
    const pkg = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
    pkgVersion = pkg.version;
  } catch {
    // fallback
  }

  const version = (opts.version || pkgVersion).replace(/^v/i, "");
  const app = source.apps[0];
  if (!app) {
    console.error("No apps defined in source json");
    process.exit(1);
  }

  app.version = version;
  app.versionDate = opts.date || new Date().toISOString();
  app.versionDescription = `Release v${version}`;

  if (opts.downloadUrl) {
    app.downloadURL = opts.downloadUrl;
  } else {
    app.downloadURL = `https://github.com/dubba/AI-Usage-Tracker/releases/download/v${version}/AI-Usage-Tracker.ipa`;
  }

  if (opts.ipaPath) {
    const stats = statSync(opts.ipaPath);
    app.size = stats.size;
  } else if (typeof opts.size === "number" && !isNaN(opts.size)) {
    app.size = opts.size;
  }

  writeFileSync(opts.sourcePath, JSON.stringify(source, null, 2) + "\n", "utf-8");
  console.log(`Updated SideStore source ${opts.sourcePath}: v${version}, size: ${app.size} bytes`);
}

main();

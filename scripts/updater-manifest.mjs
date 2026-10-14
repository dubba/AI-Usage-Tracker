import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// The desktop updater's manifest (latest.json), written once after both desktop
// jobs finish. tauri-action can write it too, but each run downloads the
// release's latest.json, adds its own platform, and uploads it again, so the
// macOS and Windows jobs would have to take turns or one could drop the other's
// platform. Until this file exists the app ignores the release (desktop only
// installs releases that publish latest.json), so users never see a half-built one.
//
//   node scripts/updater-manifest.mjs --version 0.4.3 --assets assets.json --sigs dir --out latest.json
//
// assets.json is `gh release view <tag> --json assets`; dir holds the release's
// .sig files (`gh release download <tag> --pattern '*.sig'`).

// Asset name endings after "_<version>", and the manifest keys each one serves,
// matching what tauri-action wrote for v0.4.2.
const BUNDLES = [
  { ending: "_x64_en-US.msi", keys: ["windows-x86_64-msi"] },
  { ending: "_x64-setup.exe", keys: ["windows-x86_64-nsis"] },
  { ending: "_aarch64.app.tar.gz", keys: ["darwin-aarch64", "darwin-aarch64-app"] },
  { ending: "_x64.app.tar.gz", keys: ["darwin-x86_64", "darwin-x86_64-app"] },
];

/**
 * Builds latest.json from a release's assets. Each updater bundle needs its
 * signature (the text of "<asset>.sig"); a bundle without one is an error, not a
 * platform quietly left out. Plain "windows-x86_64" points at the MSI when there
 * is one and at the NSIS installer otherwise (beta builds ship NSIS only), as
 * tauri-action does.
 *
 * @param {{ version: string, assets: { name: string, apiUrl: string }[],
 *   signatures: Record<string, string>, pubDate: string }} input
 */
export function buildUpdaterManifest({ version, assets, signatures, pubDate }) {
  const platforms = {};
  for (const { ending, keys } of BUNDLES) {
    const asset = assets.find((item) => item.name.endsWith(`_${version}${ending}`));
    if (!asset) continue;
    const signature = signatures[`${asset.name}.sig`];
    if (!signature) throw new Error(`${asset.name} has no ${asset.name}.sig on the release`);
    for (const key of keys) platforms[key] = { signature: signature.trim(), url: asset.apiUrl };
  }
  if (Object.keys(platforms).length === 0) {
    throw new Error(`no desktop updater bundles for ${version} on the release`);
  }
  const windows = platforms["windows-x86_64-msi"] ?? platforms["windows-x86_64-nsis"];
  const ordered = windows ? { "windows-x86_64": windows, ...platforms } : platforms;
  return { version, notes: "", pub_date: pubDate, platforms: ordered };
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith("--") || argv[i + 1] === undefined) {
      throw new Error(`unexpected argument ${argv[i]}`);
    }
    args[argv[i].slice(2)] = argv[i + 1];
  }
  for (const name of ["version", "assets", "sigs", "out"]) {
    if (!args[name]) throw new Error(`--${name} is required`);
  }
  return args;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const assets = JSON.parse(readFileSync(args.assets, "utf-8")).assets;
  const signatures = {};
  for (const asset of assets) {
    if (!asset.name.endsWith(".sig")) continue;
    signatures[asset.name] = readFileSync(join(args.sigs, asset.name), "utf-8");
  }
  const manifest = buildUpdaterManifest({
    version: args.version,
    assets,
    signatures,
    pubDate: new Date().toISOString(),
  });
  writeFileSync(args.out, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Wrote ${args.out} for ${args.version}: ${Object.keys(manifest.platforms).join(", ")}`);
}

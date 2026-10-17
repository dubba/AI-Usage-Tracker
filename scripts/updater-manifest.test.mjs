import assert from "node:assert/strict";
import test from "node:test";
import { buildUpdaterManifest } from "./updater-manifest.mjs";

const api = (id) => `https://api.github.com/repos/dubba/AI-Usage-Tracker/releases/assets/${id}`;

// The v0.4.2 release's assets, as `gh release view --json assets` lists them.
const v042 = [
  ["AI-Usage-Tracker.ipa", 635811001],
  ["AI.Usage.Tracker_0.4.2.apk", 635811002],
  ["AI.Usage.Tracker_0.4.2_aarch64.app.tar.gz", 635809317],
  ["AI.Usage.Tracker_0.4.2_aarch64.app.tar.gz.sig", 635809371],
  ["AI.Usage.Tracker_0.4.2_aarch64.dmg", 635809300],
  ["AI.Usage.Tracker_0.4.2_x64-setup.exe", 635800460],
  ["AI.Usage.Tracker_0.4.2_x64-setup.exe.sig", 635800492],
  ["AI.Usage.Tracker_0.4.2_x64_en-US.msi", 635800397],
  ["AI.Usage.Tracker_0.4.2_x64_en-US.msi.sig", 635800439],
  ["latest.json", 635809400],
].map(([name, id]) => ({ name, apiUrl: api(id) }));

const signatures = {
  "AI.Usage.Tracker_0.4.2_aarch64.app.tar.gz.sig": "mac-sig\n",
  "AI.Usage.Tracker_0.4.2_x64-setup.exe.sig": "nsis-sig\n",
  "AI.Usage.Tracker_0.4.2_x64_en-US.msi.sig": "msi-sig\n",
};

test("rebuilds the platforms tauri-action wrote for v0.4.2", () => {
  const manifest = buildUpdaterManifest({
    version: "0.4.2",
    assets: v042,
    signatures,
    pubDate: "2026-10-13T03:51:42.039Z",
  });
  assert.deepEqual(manifest, {
    version: "0.4.2",
    notes: "",
    pub_date: "2026-10-13T03:51:42.039Z",
    platforms: {
      "windows-x86_64": { signature: "msi-sig", url: api(635800397) },
      "windows-x86_64-msi": { signature: "msi-sig", url: api(635800397) },
      "windows-x86_64-nsis": { signature: "nsis-sig", url: api(635800460) },
      "darwin-aarch64": { signature: "mac-sig", url: api(635809317) },
      "darwin-aarch64-app": { signature: "mac-sig", url: api(635809317) },
    },
  });
  assert.equal(Object.keys(manifest.platforms)[0], "windows-x86_64");
});

test("a beta's NSIS-only Windows build serves the plain Windows key", () => {
  const assets = [
    { name: "AI.Usage.Tracker_0.5.0-beta.1_x64-setup.exe", apiUrl: api(1) },
    { name: "AI.Usage.Tracker_0.5.0-beta.1_x64-setup.exe.sig", apiUrl: api(2) },
  ];
  const manifest = buildUpdaterManifest({
    version: "0.5.0-beta.1",
    assets,
    signatures: { "AI.Usage.Tracker_0.5.0-beta.1_x64-setup.exe.sig": "nsis-sig" },
    pubDate: "2026-10-14T00:00:00.000Z",
  });
  assert.deepEqual(Object.keys(manifest.platforms), ["windows-x86_64", "windows-x86_64-nsis"]);
  assert.equal(manifest.platforms["windows-x86_64"].url, api(1));
});

test("a failed platform is left out, and the other still ships", () => {
  const macOnly = v042.filter((asset) => !asset.name.includes("_x64"));
  const manifest = buildUpdaterManifest({ version: "0.4.2", assets: macOnly, signatures, pubDate: "x" });
  assert.deepEqual(Object.keys(manifest.platforms), ["darwin-aarch64", "darwin-aarch64-app"]);
});

test("a bundle without its signature fails instead of shipping unsigned", () => {
  const noMacSig = { ...signatures };
  delete noMacSig["AI.Usage.Tracker_0.4.2_aarch64.app.tar.gz.sig"];
  assert.throws(
    () => buildUpdaterManifest({ version: "0.4.2", assets: v042, signatures: noMacSig, pubDate: "x" }),
    /aarch64\.app\.tar\.gz has no .*\.sig/,
  );
});

test("assets from another version are ignored", () => {
  assert.throws(
    () => buildUpdaterManifest({ version: "0.4.3", assets: v042, signatures, pubDate: "x" }),
    /no desktop updater bundles for 0\.4\.3/,
  );
});

test("carries the release notes into latest.json for the app's What changed window", () => {
  const manifest = buildUpdaterManifest({
    version: "0.4.2",
    assets: v042,
    signatures,
    pubDate: "2026-10-13T03:51:42.039Z",
    notes: "## v0.4.2\n\n- One change.",
  });
  assert.equal(manifest.notes, "## v0.4.2\n\n- One change.");
});

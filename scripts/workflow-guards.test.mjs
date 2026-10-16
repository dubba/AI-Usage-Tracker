// Guards on the GitHub Actions workflows: things that are easy to reintroduce
// by accident and that CI would otherwise accept silently. Text-level checks,
// so no YAML dependency is needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const workflowsDir = resolve(dirname(fileURLToPath(import.meta.url)), "../.github/workflows");
const workflows = readdirSync(workflowsDir)
  .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
  .map((name) => ({ name, text: readFileSync(resolve(workflowsDir, name), "utf-8") }));

/**
 * Lines of `run:` scripts (inline or block) that contain a `${{ }}` expression.
 * GitHub substitutes those into the script text before the shell sees it, so a
 * value containing a quote, backtick, or newline becomes shell syntax. Values
 * belong in `env:` and are read as "$VAR" instead.
 */
export function interpolationsInRunScripts(text) {
  const hits = [];
  const lines = text.split("\n");
  let keyColumn = -1; // column of the `run:` key while inside its block scalar
  lines.forEach((line, index) => {
    if (keyColumn >= 0) {
      const indent = line.length - line.trimStart().length;
      if (line.trim() === "" || indent > keyColumn) {
        if (line.includes("${{")) hits.push({ line: index + 1, text: line.trim() });
        return;
      }
      keyColumn = -1;
    }
    const match = line.match(/^(\s*(?:-\s+)?)run:\s*(.*)$/);
    if (!match) return;
    const rest = match[2];
    if (/^[|>][+-]?\s*(#.*)?$/.test(rest)) {
      keyColumn = match[1].length;
    } else if (rest.includes("${{")) {
      hits.push({ line: index + 1, text: line.trim() });
    }
  });
  return hits;
}

test("the scanner finds expressions in inline and block run scripts only", () => {
  const fixture = [
    "jobs:",
    "  build:",
    "    steps:",
    "      - name: Inline",
    '        run: echo "${{ inputs.version }}"',
    "      - name: Block",
    "        if: ${{ inputs.flag }}",
    "        env:",
    "          VERSION: ${{ inputs.version }}",
    "        run: |",
    '          echo "$VERSION"',
    '          node apply.mjs --version "${{ inputs.version }}"',
    "      - run: echo safe",
  ].join("\n");
  assert.deepEqual(
    interpolationsInRunScripts(fixture).map((hit) => hit.line),
    [5, 12],
  );
});

test("no workflow pastes a ${{ }} expression into a run script", () => {
  for (const { name, text } of workflows) {
    assert.deepEqual(interpolationsInRunScripts(text), [], `${name}: use env: and "$VAR" instead`);
  }
});

test("installs use the committed lockfiles", () => {
  for (const { name, text } of workflows) {
    assert.doesNotMatch(text, /\bnpm install\b/, `${name}: use npm ci so package-lock.json is the source of truth`);
    for (const line of text.split("\n")) {
      if (/\bcargo (test|check|clippy|build)\b/.test(line)) {
        assert.match(line, /--locked/, `${name}: ${line.trim()}`);
      }
    }
  }
});

test("release builds pass --locked through to cargo", () => {
  const android = workflows.find((w) => w.name === "build-android.yml").text;
  assert.match(android, /npx tauri android build [^\n]*-- --locked/);
  const installers = workflows.find((w) => w.name === "build-installers.yml").text;
  const args = installers.split("\n").filter((line) => /^\s*args:/.test(line));
  assert.equal(args.length, 2, "one tauri-action per desktop platform");
  for (const line of args) assert.match(line, /-- --locked/, line.trim());
});

/** The block-scalar `run:` script of every step with this name, dedented. */
export function runScriptsOfStep(text, stepName) {
  const lines = text.split("\n");
  const scripts = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== `- name: ${stepName}`) continue;
    const stepIndent = lines[i].indexOf("-");
    for (let j = i + 1; j < lines.length; j++) {
      const indent = lines[j].length - lines[j].trimStart().length;
      if (lines[j].trim() !== "" && indent <= stepIndent) break;
      const match = lines[j].match(/^(\s*)run:\s*\|\s*$/);
      if (!match) continue;
      const body = [];
      for (let k = j + 1; k < lines.length; k++) {
        const bodyIndent = lines[k].length - lines[k].trimStart().length;
        if (lines[k].trim() !== "" && bodyIndent <= match[1].length) break;
        body.push(lines[k]);
      }
      const width = Math.min(
        ...body.filter((line) => line.trim()).map((line) => line.length - line.trimStart().length),
      );
      scripts.push(body.map((line) => line.slice(width)).join("\n"));
      break;
    }
  }
  return scripts;
}

test("a release without a valid updater signing key fails instead of publishing", async () => {
  const { spawnSync } = await import("node:child_process");
  const { mkdtempSync, writeFileSync: write, readFileSync: read } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const installers = workflows.find((w) => w.name === "build-installers.yml").text;
  const scripts = runScriptsOfStep(installers, "Normalize and verify updater signing key");
  assert.equal(scripts.length, 2, "one key check per desktop job");

  const dir = mkdtempSync(resolve(tmpdir(), "signing-key-"));
  const run = (script, key) => {
    const envFile = resolve(dir, "github_env");
    write(envFile, "");
    const result = spawnSync("python3", ["-c", script], {
      env: { ...process.env, RAW_TAURI_SIGNING_PRIVATE_KEY: key, GITHUB_ENV: envFile },
      encoding: "utf-8",
    });
    return { status: result.status, env: read(envFile, "utf-8"), out: result.stdout };
  };
  // A key-shaped value: base64 of a minisign secret-key header. Not a real key.
  const keyShaped = Buffer.from("untrusted comment: rsign encrypted secret key\nRWRTY0Iy\n").toString("base64");

  for (const script of scripts) {
    for (const bad of ["", "   ", "not base64 !!!", Buffer.from("just some text").toString("base64")]) {
      const result = run(script, bad);
      assert.equal(result.status, 1, `key ${JSON.stringify(bad)} should fail the job`);
      assert.equal(result.env, "", "nothing may be exported on failure");
      assert.match(result.out, /::error::/);
    }
    const ok = run(script, keyShaped);
    assert.equal(ok.status, 0, ok.out);
    assert.equal(ok.env, `TAURI_SIGNING_PRIVATE_KEY=${keyShaped}\n`);
  }
});

test("macOS builds sign and notarize with a full Apple secret set, ad-hoc with none, and fail on a partial set", async () => {
  const { spawnSync } = await import("node:child_process");
  const { mkdtempSync, writeFileSync: write, readFileSync: read } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const installers = workflows.find((w) => w.name === "build-installers.yml").text;
  const [script, ...extra] = runScriptsOfStep(installers, "Configure macOS code signing");
  assert.ok(script, "signing step found");
  assert.equal(extra.length, 0, "one signing step");

  // A step-level env value would override what the signing step exports.
  const tauriAction = installers.slice(installers.indexOf("- name: Configure macOS code signing"));
  const actionEnv = tauriAction.slice(tauriAction.indexOf("tauri-apps/tauri-action"), tauriAction.indexOf("with:"));
  assert.doesNotMatch(actionEnv, /APPLE_/, "tauri-action must take Apple settings from GITHUB_ENV");

  const names = ["APPLE_CERTIFICATE", "APPLE_CERTIFICATE_PASSWORD", "APPLE_SIGNING_IDENTITY",
    "APPLE_ID", "APPLE_PASSWORD", "APPLE_TEAM_ID"];
  const dir = mkdtempSync(resolve(tmpdir(), "apple-signing-"));
  const run = (secrets) => {
    const envFile = resolve(dir, "github_env");
    write(envFile, "");
    const env = { ...process.env, GITHUB_ENV: envFile };
    for (const name of names) delete env[name];
    const result = spawnSync("python3", ["-c", script], { env: { ...env, ...secrets }, encoding: "utf-8" });
    return { status: result.status, env: read(envFile, "utf-8"), out: result.stdout };
  };
  // Placeholder values, not real credentials.
  const full = {
    APPLE_CERTIFICATE: "TUlJQ2Zh\nZWtlUDEy\n",
    APPLE_CERTIFICATE_PASSWORD: "p12-pass",
    APPLE_SIGNING_IDENTITY: "Developer ID Application: Example (TEAM123456)",
    APPLE_ID: "dev@example.com",
    APPLE_PASSWORD: "abcd-efgh-ijkl-mnop",
    APPLE_TEAM_ID: "TEAM123456",
  };

  const none = run({ APPLE_ID: "  " });
  assert.equal(none.status, 0, none.out);
  assert.equal(none.env, "APPLE_SIGNING_IDENTITY=-\n");
  assert.match(none.out, /::warning::/);

  for (const name of names) {
    const partial = run({ ...full, [name]: "" });
    assert.equal(partial.status, 1, `missing ${name} should fail the job`);
    assert.equal(partial.env, "", "nothing may be exported on failure");
    assert.match(partial.out, new RegExp(`::error::.*${name}`));
  }

  const signed = run(full);
  assert.equal(signed.status, 0, signed.out);
  const exported = Object.fromEntries(signed.env.trim().split("\n").map((line) => line.split(/=(.*)/s).slice(0, 2)));
  assert.deepEqual(exported, { ...full, APPLE_CERTIFICATE: "TUlJQ2ZhZWtlUDEy" });
});

test("the Android signing step signs release APKs only and refuses debug ones", async () => {
  const { spawnSync } = await import("node:child_process");
  const fs = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const android = workflows.find((w) => w.name === "build-android.yml").text;
  const [script] = runScriptsOfStep(android, "Sign and align Android APK");
  assert.ok(script, "signing step found");

  const sandbox = (apks) => {
    const root = fs.mkdtempSync(resolve(tmpdir(), "apk-sign-"));
    const tools = resolve(root, "sdk/build-tools/34.0.0");
    fs.mkdirSync(tools, { recursive: true });
    // Stand-ins that copy files and log what was signed, so no Android SDK is needed.
    fs.writeFileSync(resolve(tools, "zipalign"), '#!/bin/sh\ncp "$4" "$5"\n', { mode: 0o755 });
    fs.writeFileSync(
      resolve(tools, "apksigner"),
      '#!/bin/sh\n[ "$1" = sign ] || exit 0\nout=""; prev=""; for a in "$@"; do [ "$prev" = "--out" ] && out="$a"; prev="$a"; last="$a"; done\ncp "$last" "$out"\necho "$out" >> "$SIGNED_LOG"\n',
      { mode: 0o755 },
    );
    fs.writeFileSync(resolve(root, "package.json"), '{"version":"9.9.9"}');
    for (const apk of apks) {
      const path = resolve(root, "src-tauri/gen/android/app/build/outputs/apk", apk);
      fs.mkdirSync(dirname(path), { recursive: true });
      fs.writeFileSync(path, "apk bytes");
    }
    const temp = resolve(root, "runner-temp");
    fs.mkdirSync(temp);
    const signedLog = resolve(root, "signed.log");
    fs.writeFileSync(signedLog, "");
    const result = spawnSync("bash", ["-c", script], {
      cwd: root,
      encoding: "utf-8",
      env: {
        ...process.env,
        ANDROID_HOME: resolve(root, "sdk"),
        RUNNER_TEMP: temp,
        SIGNED_LOG: signedLog,
        ANDROID_KEYSTORE_BASE64: Buffer.from("not a real keystore").toString("base64"),
        ANDROID_KEYSTORE_PASSWORD: "test",
        ANDROID_KEY_ALIAS: "test",
        ANDROID_KEY_PASSWORD: "test",
      },
    });
    return {
      status: result.status,
      output: result.stdout + result.stderr,
      signed: fs.readFileSync(signedLog, "utf-8").trim().split("\n").filter(Boolean),
      keystoreLeft: fs.existsSync(resolve(temp, "android-sideload.p12")),
    };
  };

  const releaseOnly = sandbox(["universal/release/app-universal-release-unsigned.apk"]);
  assert.equal(releaseOnly.status, 0, releaseOnly.output);
  assert.deepEqual(releaseOnly.signed, ["release-apks/AI Usage Tracker_9.9.9.apk"]);
  assert.equal(releaseOnly.keystoreLeft, false);

  const withDebug = sandbox([
    "universal/release/app-universal-release-unsigned.apk",
    "universal/debug/app-universal-debug.apk",
  ]);
  assert.equal(withDebug.status, 1, "a debug APK in the output must stop the job");
  assert.ok(withDebug.signed.every((path) => !/debug/i.test(path)), withDebug.signed.join(", "));
  assert.equal(withDebug.keystoreLeft, false, "keystore removed on the error exit too");

  const noRelease = sandbox(["universal/app-universal-unsigned.apk"]);
  assert.equal(noRelease.status, 1, "no release APK means nothing to publish");
  assert.deepEqual(noRelease.signed, []);
});

test("the release notes tell users what to do about the first-launch security warnings", () => {
  // Desktop builds are not signed with a paid developer certificate (accepted in the
  // audit ledger as L-21), so users have to be told how to get past the warnings.
  const guide = readFileSync(resolve(workflowsDir, "../release-notes/download-guide.md"), "utf-8");
  assert.match(guide, /Run anyway/, "Windows SmartScreen step");
  assert.match(guide, /Open Anyway/, "macOS Gatekeeper step");

  // The guide reaches the release page through the notes job, not a per-platform body.
  const installers = workflows.find((w) => w.name === "build-installers.yml").text;
  assert.doesNotMatch(installers, /releaseBody:/, "no platform job sets its own body");
  assert.match(installers, /scripts\/release-notes\.mjs/, "the notes job runs the generator");
  assert.match(installers, /gh release edit "v\$VERSION" --notes-file/, "the notes job sets the body");
});

test("the Windows release job runs its version step under bash", () => {
  // On windows-latest a step with no `shell:` runs PowerShell, which leaves
  // "$RELEASE_VERSION" empty; the script then numbers the build from package.json
  // and the installers land on the previous release (v0.4.1 shipped that way).
  const installers = workflows.find((w) => w.name === "build-installers.yml").text;
  const job = /^  publish-windows:\n([\s\S]*?)(?=^  \S+:\n)/m.exec(installers);
  assert.ok(job, "publish-windows job found");
  assert.match(job[1], /runs-on: windows-/);
  const step = /- name: Apply release version\n([\s\S]*?)(?=\n      - )/.exec(job[1]);
  assert.ok(step, "version step found");
  assert.match(step[1], /shell: bash/, "version step must not use the Windows default shell");
});


test("no release job can run unless the Validate gate passed or was skipped on purpose", () => {
  const validate = workflows.find((w) => w.name === "validate.yml").text;
  assert.match(validate, /^  workflow_call:/m, "validate.yml must be callable by the release");

  const installers = workflows.find((w) => w.name === "build-installers.yml").text;
  assert.match(installers, /^      skip_validate:/m, "manual override input");

  const gate = /^  validate:\n([\s\S]*?)(?=^  \S+:\n)/m.exec(installers);
  assert.ok(gate, "validate gate job found");
  assert.match(gate[1], /uses: \.\/\.github\/workflows\/validate\.yml/);
  assert.match(gate[1], /inputs\.skip_validate != true/, "only the override may skip the gate");

  // create-release is the root of every build job (they all need it), so gating
  // it gates the Windows, macOS, iOS, Android and version-bump jobs too.
  const root = /^  create-release:\n([\s\S]*?)(?=^  \S+:\n)/m.exec(installers);
  assert.ok(root, "create-release found");
  assert.match(root[1], /needs: \[check-changes, validate\]/);
  assert.match(root[1], /needs\.validate\.result == 'success' \|\| needs\.validate\.result == 'skipped'/);
  for (const job of ["commit-version-bump", "build-android", "publish-macos", "build-ios", "publish-windows", "updater-manifest"]) {
    const m = new RegExp(`^  ${job}:\\n([\\s\\S]*?)(?=^  \\S+:\\n)`, "m").exec(installers);
    assert.ok(m, `${job} found`);
    assert.match(m[1], /needs: \[[^\]]*create-release[^\]]*\]/, `${job} must wait for the gated root job`);
    assert.doesNotMatch(m[1], /always\(\)/, `${job} must not bypass the gate with always()`);
  }
  // updater-manifest runs after a failed desktop job (!cancelled()), so it must
  // check the gated root itself.
  const manifest = /^  updater-manifest:\n([\s\S]*?)(?=^  \S+:\n)/m.exec(installers);
  assert.match(manifest[1], /needs\.create-release\.result == 'success'/);

  // release-notes runs after failures on purpose, so it needs its own check.
  const notes = /^  release-notes:\n([\s\S]*?)(?=^  \S+:\n|$(?![\s\S]))/m.exec(installers);
  assert.ok(notes, "release-notes found");
  assert.match(notes[1], /needs\.validate\.result == 'success' \|\| needs\.validate\.result == 'skipped'/);
  assert.match(notes[1], /needs\.create-release\.result == 'success'/);
});

test("latest.json is written once, after both desktop jobs", () => {
  // Each tauri-action run that uploads latest.json downloads it, adds its own
  // platform, and uploads it again. Run side by side, the later upload can drop
  // the other platform, and that platform's users would get no update. So the
  // desktop jobs leave it to updater-manifest, which runs after both.
  const installers = workflows.find((w) => w.name === "build-installers.yml").text;
  assert.doesNotMatch(installers, /uploadUpdaterJson: true/, "tauri-action must not write latest.json");
  assert.equal((installers.match(/uploadUpdaterJson: false/g) ?? []).length, 2);
  const job = /^  updater-manifest:\n([\s\S]*?)(?=^  \S+:\n)/m.exec(installers);
  assert.ok(job, "updater-manifest found");
  assert.match(job[1], /needs: \[[^\]]*publish-windows[^\]]*\]/);
  assert.match(job[1], /needs: \[[^\]]*publish-macos[^\]]*\]/);
  assert.match(job[1], /node scripts\/updater-manifest\.mjs/);
});

test("only runs on main save Rust caches", () => {
  // The repo has 10 GB of Actions cache. PR runs saving their own Rust caches
  // pushed out main's, and the v0.4.3 release rebuilt from cold (37 minutes).
  for (const { name, text } of workflows) {
    const steps = text.split(/\n(?=\s*- )/).filter((step) => /uses: Swatinem\/rust-cache@/.test(step));
    for (const step of steps) {
      assert.match(step, /save-if: \$\{\{ github\.ref == 'refs\/heads\/main' \}\}/, `${name}: rust-cache must only save on main`);
    }
  }
});

test("the release is scheduled for Thursday and Sunday at 11:30 PM Eastern, with a fallback that cannot double-publish", () => {
  // No scheduled run was created for the Thursday 2026-10-15 slot (or the UTC
  // slots before it), so each night has a second, plain-UTC entry. The pair is
  // only safe because a scheduled run skips itself after a recent release and
  // runs wait for each other instead of building side by side.
  const installers = workflows.find((w) => w.name === "build-installers.yml").text;
  const block = /^  schedule:\n((?: {4}.*\n)+)/m.exec(installers);
  assert.ok(block, "schedule block found");
  const entries = block[1]
    .split(/\n(?= {4}- )/)
    .map((entry) => ({
      cron: /cron: '([^']+)'/.exec(entry)?.[1],
      timezone: /timezone: (\S+)/.exec(entry)?.[1] ?? null,
    }));
  assert.deepEqual(entries, [
    { cron: "30 23 * * 4", timezone: "America/New_York" },
    { cron: "30 23 * * 0", timezone: "America/New_York" },
    // Before 05:00 UTC, so releaseDateEastern (UTC-5) still dates it the night before.
    { cron: "55 4 * * 5", timezone: null },
    { cron: "55 4 * * 1", timezone: null },
  ]);

  assert.match(installers, /^concurrency:\n {2}group: publish-release\n {2}cancel-in-progress: false\n/m);
  const check = /- name: Inspect commits and schedule day\n([\s\S]*?)(?=\n      - )/.exec(installers);
  assert.ok(check, "check step found");
  assert.match(check[1], /RECENT_RELEASE_MINUTES: "\d+"/);
  assert.match(check[1], /if \[ "\$GITHUB_EVENT_NAME" = "schedule" \]; then\n\s+LAST_CREATED=\$\(gh release list/);
  assert.ok(
    check[1].indexOf("RECENT_RELEASE_MINUTES\" ]") < check[1].indexOf("LATEST_TAG=$(gh release view"),
    "the recent-release check must run before the new-commits check",
  );
});

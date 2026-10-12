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

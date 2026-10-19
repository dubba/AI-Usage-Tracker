import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import fixture from "./backend-samples.fixture.json";

/**
 * The JSON the Rust backend sends (`backend-samples.fixture.json`, kept current by
 * `src-tauri/src/type_contract.rs`) must satisfy the types in `src/types.ts`. Each sample is
 * assigned to its type in a generated source file and checked by the TypeScript compiler, so a
 * missing or extra field, a `null` where the type says it cannot be, or a string outside a union
 * all fail here.
 */
const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const samples = fixture as Record<string, unknown[]>;
const entries = Object.entries(samples)
  .flatMap(([type, values]) => values.map((value, index) => ({ type, name: `${type} #${index + 1}`, value })))
  .map((entry, position) => ({ ...entry, position }));

/** Compiler messages per entry index. */
function check(): Map<number, string[]> {
  const directory = mkdtempSync(join(tmpdir(), "types-contract-"));
  try {
    const file = join(directory, "samples.ts");
    const lines = [`import type * as T from ${JSON.stringify(join(projectRoot, "src", "types"))};`];
    for (const entry of entries) {
      lines.push(`const sample${entry.position}: T.${entry.type} = ${JSON.stringify(entry.value)};`);
    }
    writeFileSync(file, lines.join("\n"));
    const tsc = join(projectRoot, "node_modules", "typescript", "lib", "tsc.js");
    let output = "";
    try {
      execFileSync(
        process.execPath,
        [
          tsc, "--noEmit", "--strict", "--skipLibCheck", "--target", "es2022", "--module", "esnext",
          "--moduleResolution", "bundler", "--types", "", "--pretty", "false", file,
        ],
        { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
    } catch (error) {
      output = String((error as { stdout?: string }).stdout ?? error);
    }
    const found = new Map<number, string[]>();
    for (const message of output.split("\n")) {
      const match = /samples\.ts\((\d+),\d+\): (.*)$/.exec(message);
      if (!match) {
        // Anything else the compiler says (a bad option, a missing file) must not read as a pass.
        if (/error TS/.test(message)) throw new Error(`The compiler could not check the samples: ${message}`);
        continue;
      }
      // Line 1 is the import; entry `n` is on line `n + 2`.
      const position = Number(match[1]) - 2;
      found.set(position, [...(found.get(position) ?? []), match[2]]);
    }
    return found;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const problems = check();

describe("backend JSON against src/types.ts", () => {
  it("has samples for the types the dashboard, settings, sign-in and pairing code rely on", () => {
    expect(Object.keys(samples)).toEqual(
      expect.arrayContaining(["Account", "DashboardSnapshot", "PairingStatus", "AppSettings"]),
    );
  });

  it.each(entries)("$name", ({ position }) => {
    expect(problems.get(position) ?? []).toEqual([]);
  });
});

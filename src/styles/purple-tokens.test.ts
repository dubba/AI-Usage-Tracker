/// <reference types="node" />
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The app's purple is three tokens (--purple-fill, --purple-accent, --purple-text, defined in
 * tokens.css) plus the tint triplets next to them. This keeps a new stylesheet from adding a
 * fourth shade by pasting a hex, and keeps the one place CSS cannot reach (the native title bar
 * in src-tauri/src/tray.rs) on the same value.
 */
const STYLES = __dirname;
const SRC = join(__dirname, "..");
const TOKENS = readFileSync(join(STYLES, "tokens.css"), "utf8");

function cssFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name: string) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return cssFiles(path);
    return path.endsWith(".css") ? [path] : [];
  });
}

function token(name: string): string {
  const match = TOKENS.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`));
  if (!match) throw new Error(`${name} is not a hex color in tokens.css`);
  return match[1].toLowerCase();
}

function rgbOf(hex: string): [number, number, number] {
  const value = hex.length === 4 ? [...hex.slice(1)].map((c) => c + c).join("") : hex.slice(1);
  return [0, 2, 4].map((i) => parseInt(value.slice(i, i + 2), 16)) as [number, number, number];
}

/** A mid-to-bright, clearly colored purple: the family the app's brand purples sit in. */
function isPurple([r, g, b]: [number, number, number]): boolean {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === 0 || max !== b) return false;
  const saturation = (max - min) / max;
  const hue = max === r || max === min ? 0 : (60 * (4 + (r - g) / (max - min)) + 360) % 360;
  return saturation >= 0.35 && max / 255 >= 0.45 && hue >= 250 && hue <= 290;
}

function purpleLiterals(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/g)) {
    if (isPurple(rgbOf(match[0]))) found.push(match[0]);
  }
  for (const match of source.matchAll(/rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})/g)) {
    if (isPurple([Number(match[1]), Number(match[2]), Number(match[3])])) found.push(match[0]);
  }
  return found;
}

describe("purple tokens", () => {
  it("keeps raw purple colors in tokens.css and the generated theme palette", () => {
    const offenders = cssFiles(SRC)
      .filter((file) => !/[\\/](tokens|theme-palette)\.css$/.test(file))
      .flatMap((file) =>
        purpleLiterals(readFileSync(file, "utf8")).map((literal) => `${file.slice(SRC.length + 1)}: ${literal}`),
      );
    expect(offenders).toEqual([]);
  });

  it("defines the wash and fill triplets from the token values", () => {
    const triplet = (name: string) => {
      const match = TOKENS.match(new RegExp(`${name}:\\s*(\\d+) (\\d+) (\\d+);`));
      if (!match) throw new Error(`${name} is not an r g b triplet in tokens.css`);
      return [Number(match[1]), Number(match[2]), Number(match[3])];
    };
    expect(triplet("--purple-fill-rgb")).toEqual(rgbOf(token("--purple-fill")));
    expect(triplet("--purple-wash-rgb")).toEqual(rgbOf(token("--purple-accent")));
  });

  it("paints the native title bar with --purple-fill", () => {
    const tray = readFileSync(join(SRC, "..", "src-tauri", "src", "tray.rs"), "utf8");
    const match = tray.match(/TITLE_BAR_PURPLE_RGB: \(u8, u8, u8\) = \(0x([0-9a-f]{2}), 0x([0-9a-f]{2}), 0x([0-9a-f]{2})\)/i);
    expect(match, "TITLE_BAR_PURPLE_RGB not found in tray.rs").not.toBeNull();
    expect(`#${match![1]}${match![2]}${match![3]}`.toLowerCase()).toBe(token("--purple-fill"));
  });

  it("keeps Rust-rendered pages on the token values", () => {
    const allowed = new Set([token("--purple-fill"), token("--purple-accent")]);
    const rustDir = join(SRC, "..", "src-tauri", "src");
    const offenders = readdirSync(rustDir)
      .filter((name) => name.endsWith(".rs"))
      .flatMap((name) =>
        purpleLiterals(readFileSync(join(rustDir, name), "utf8"))
          .filter((literal) => !allowed.has(literal.toLowerCase()))
          .map((literal) => `${name}: ${literal}`),
      );
    expect(offenders).toEqual([]);
  });
});

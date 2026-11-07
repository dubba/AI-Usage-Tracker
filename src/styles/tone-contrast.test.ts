/// <reference types="node" />
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The quota percentages (sidebar meters, account cards, the Usage totals) are colored by tone with
 * the --tone-*-text tokens. Each must clear WCAG AA for normal text (4.5:1) on every surface it
 * sits on, in both themes. The bars keep the saturated --obsidian-* fills, which only need to be
 * seen, not read.
 */
const TOKENS = readFileSync(join(__dirname, "tokens.css"), "utf8");
const LIGHT_START = TOKENS.indexOf(':root[data-theme="light"]');
const DARK = TOKENS.slice(0, LIGHT_START);
const LIGHT = TOKENS.slice(LIGHT_START);

function hexIn(block: string, name: string): string {
  const match = block.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})\\b`));
  if (!match) throw new Error(`${name} is not a hex color in this theme's block of tokens.css`);
  return match[1];
}

function luminance(hex: string): number {
  const channel = (offset: number) => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const TONES = ["--tone-healthy-text", "--tone-warning-text", "--tone-critical-text"];
const SURFACES = [
  "--obsidian-canvas",
  "--obsidian-surface-low",
  "--obsidian-surface-container",
  "--obsidian-surface-container-high",
];
/**
 * Rendered backgrounds measured in the app that are blends, not tokens of their own: the sidebar,
 * and a selected sidebar row (a purple tint), where the lowest percentages sit most of the time.
 */
const MEASURED = {
  dark: [["sidebar", "#171616"], ["selected sidebar row", "#28213a"]],
  light: [["sidebar", "#f1eff4"], ["selected sidebar row", "#ebe6f8"]],
} as const;

describe.each([
  ["dark", DARK, MEASURED.dark],
  ["light", LIGHT, MEASURED.light],
] as const)("quota tone text in the %s theme", (_theme, block, measured) => {
  const surfaces = [...SURFACES.map((name) => [name, hexIn(block, name)] as const), ...measured];

  it.each(TONES)("%s clears 4.5:1 on every surface", (tone) => {
    const color = hexIn(block, tone);
    for (const [name, surface] of surfaces) {
      expect(contrast(color, surface), `${tone} ${color} on ${name} ${surface}`).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe("quota tone text colors in the stylesheets", () => {
  it("are never the old hardcoded red, which failed on the dark sidebar", () => {
    for (const file of ["sidebar-list.css", "account-card-responsive.css", "obsidian-dashboard.css"]) {
      const source = readFileSync(join(__dirname, file), "utf8");
      for (const rule of source.matchAll(/\.tone-critical[^{]*\{([^}]*)\}/g)) {
        expect(rule[1], `${file}: ${rule[0].slice(0, 80)}`).not.toMatch(/(^|[^-])color:\s*#c53131/);
      }
    }
  });
});

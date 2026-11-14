/// <reference types="node" />
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const TOKENS = readFileSync(join(__dirname, "tokens.css"), "utf8");
const NAV = readFileSync(join(__dirname, "..", "app", "bottom-nav.css"), "utf8");
const TOP_BAR = readFileSync(join(__dirname, "..", "app", "top-bar.css"), "utf8");
const LIGHT = TOKENS.slice(TOKENS.indexOf(':root[data-theme="light"]'));

type Rgb = [number, number, number];

function luminance([r, g, b]: Rgb): number {
  const [lr, lg, lb] = [r, g, b].map((channel) => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
}

function contrast(a: Rgb, b: Rgb): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

function hexIn(source: string, name: string): Rgb {
  const match = source.match(new RegExp(`${name}:\\s*#([0-9a-fA-F]{6})`));
  if (!match) throw new Error(`${name} is not a hex color in that theme`);
  return [0, 2, 4].map((i) => parseInt(match[1].slice(i, i + 2), 16)) as Rgb;
}

describe("bottom bar colors", () => {
  const THEMES = [["dark", TOKENS], ["light", LIGHT]] as const;

  it("is a neutral floating pill, not the title bar purple", () => {
    expect(NAV).toContain("background: var(--bottom-nav-surface);");
    expect(NAV).not.toMatch(/\.bottom-nav \{[^}]*var\(--purple/);
    expect(NAV).toMatch(/\.bottom-nav \{[^}]*border-radius: 999px;/);
    expect(NAV).toMatch(/\.bottom-nav \{[^}]*width: fit-content;\s*margin: 0 auto;/);
    for (const [theme, source] of THEMES) {
      const [r, g, b] = hexIn(source, "--bottom-nav-surface");
      expect(Math.max(r, g, b) - Math.min(r, g, b), theme).toBeLessThanOrEqual(8);
    }
  });

  it("marks the current page in the desktop top bar with the purple fill and white label", () => {
    expect(TOP_BAR).toMatch(/\.top-bar-nav-item\.is-active \{\s*border-color: var\(--purple-fill\);\s*background: var\(--purple-fill\);\s*color: #ffffff !important;/);
  });

  it("keeps the selected and unselected labels readable in both themes (4.5:1)", () => {
    for (const [theme, source] of THEMES) {
      const surface = hexIn(source, "--bottom-nav-surface");
      const hover = hexIn(source, "--bottom-nav-line");
      expect(contrast(hexIn(source, "--bottom-nav-label"), surface), theme).toBeGreaterThanOrEqual(4.5);
      // The current page: the on-fill label on the purple pill, the same in both themes.
      expect(contrast(hexIn(TOKENS, "--purple-on-fill"), hexIn(TOKENS, "--purple-fill")), theme).toBeGreaterThanOrEqual(4.5);
      // Hovered or pressed: the brighter label on the line color.
      expect(contrast(hexIn(source, "--bottom-nav-label-active"), hover), theme).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("marks the current page with a purple pill, the on-fill label and a heavier weight", () => {
    expect(NAV).toMatch(/\.bottom-nav-item\.is-active \{\s*background: var\(--purple-fill\);\s*color: var\(--purple-on-fill\) !important;\s*font-weight: 750 !important;/);
    // The light theme does not recolor the pill or its label.
    for (const name of ["--purple-fill", "--purple-on-fill"]) {
      expect(LIGHT, name).not.toContain(`${name}:`);
    }
    for (const [theme, source] of THEMES) {
      expect(contrast(hexIn(TOKENS, "--purple-fill"), hexIn(source, "--bottom-nav-surface")), theme).toBeGreaterThan(1.5);
    }
  });

  it("floats above the system area and tells the shell how much room it takes", () => {
    expect(NAV).toContain("--bottom-nav-offset: max(12px, calc(var(--safe-area-bottom, 0px) + 6px));");
    expect(NAV).toContain("--bottom-nav-height: calc(62px + var(--bottom-nav-offset));");
    expect(NAV).toContain("bottom: var(--bottom-nav-offset, 12px);");
  });
});

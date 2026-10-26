/// <reference types="node" />
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const TOKENS = readFileSync(join(__dirname, "tokens.css"), "utf8");
const NAV = readFileSync(join(__dirname, "..", "app", "bottom-nav.css"), "utf8");
const SIDEBAR_NAV = readFileSync(join(__dirname, "..", "app", "sidebar-nav.css"), "utf8");
const LIGHT = TOKENS.slice(TOKENS.indexOf(':root[data-theme="light"]'));

type Rgb = [number, number, number];

function hex(name: string): Rgb {
  const match = TOKENS.match(new RegExp(`${name}:\\s*#([0-9a-fA-F]{6})`));
  if (!match) throw new Error(`${name} is not a hex color in tokens.css`);
  return [0, 2, 4].map((i) => parseInt(match[1].slice(i, i + 2), 16)) as Rgb;
}

/** `--name: rgb(r g b / alpha)` laid over `under`. */
function veil(name: string, under: Rgb): Rgb {
  const match = TOKENS.match(new RegExp(`${name}:\\s*rgb\\((\\d+) (\\d+) (\\d+) / ([\\d.]+)\\)`));
  if (!match) throw new Error(`${name} is not an rgb() with an alpha in tokens.css`);
  const alpha = Number(match[4]);
  return [1, 2, 3].map((i) => Math.round(Number(match[i]) * alpha + under[i - 1] * (1 - alpha))) as Rgb;
}

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

describe("bottom bar colors", () => {
  const fill = hex("--purple-fill");
  const hoverVeil: Rgb = [0.1, 0.1, 0.1].map((alpha, i) => Math.round(255 * alpha + fill[i] * (1 - alpha))) as Rgb;

  it("sits on the title bar purple and uses only the on-fill colors for its labels", () => {
    expect(NAV).toContain("background: var(--purple-fill);");
    expect(NAV).toContain("color: var(--purple-on-fill-muted) !important;");
    expect(NAV).toContain("color: var(--purple-on-fill) !important;");
  });

  it("paints the desktop sidebar nav with the same purple fill and line, extending flush to the edges", () => {
    expect(SIDEBAR_NAV).toContain("background: var(--purple-fill);");
    expect(SIDEBAR_NAV).toContain("border-top: 1px solid var(--purple-fill-line);");
    expect(SIDEBAR_NAV).toContain("margin: 0 -12px -12px -12px;");
  });

  it("keeps the selected and unselected labels readable on the purple (4.5:1)", () => {
    expect(contrast(hex("--purple-on-fill"), fill)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(veil("--purple-on-fill-muted", fill), fill)).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps the selected label readable while pressed or hovered", () => {
    expect(contrast(hex("--purple-on-fill"), hoverVeil)).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps the two states apart: the selected one is brighter and has its own marker", () => {
    expect(luminance(hex("--purple-on-fill"))).toBeGreaterThan(luminance(veil("--purple-on-fill-muted", fill)));
    expect(NAV).toContain(".bottom-nav-item.is-active::before");
  });

  it("is the same in the light theme: the light theme does not recolor the purple or its labels", () => {
    for (const name of ["--purple-fill", "--purple-on-fill", "--purple-on-fill-muted", "--purple-fill-line"]) {
      expect(LIGHT, name).not.toContain(`${name}:`);
    }
  });

  it("works out the gap below the labels from the system area, so it matches the gap above the icons", () => {
    // 10px above the icons. Below: the buttons' area counts as occupied (full 12px above it); a gesture
    // handle or home indicator sits about 14px above the edge, so 26px less that area, within 2px..12px.
    expect(NAV).toContain("padding: 10px 0 0;");
    expect(NAV).toContain(
      "--bottom-nav-gesture-zone: calc(var(--safe-area-bottom, 0px) - var(--android-nav-buttons, 0px));",
    );
    expect(NAV).toContain("--bottom-nav-below: clamp(2px, calc(26px - var(--bottom-nav-gesture-zone)), 12px);");
    expect(NAV).toContain("--bottom-nav-height: calc(46px + var(--bottom-nav-below) + var(--safe-area-bottom, 0px));");
    expect(NAV).toContain("justify-content: flex-start;");
  });

  it("is told about the navigation buttons by the Android activity", () => {
    const activity = readFileSync(
      join(__dirname, "../../src-tauri/gen/android/app/src/main/java/com/dubba/ai/usage/tracker/MainActivity.kt"),
      "utf8",
    );
    expect(activity).toContain("'--android-nav-buttons', '${navButtonsDp}px'");
    expect(activity).toContain("WindowInsetsCompat.Type.tappableElement()");
  });
});

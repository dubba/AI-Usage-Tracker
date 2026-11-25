import { bridgeApi } from "./api";
import { logIgnored } from "./log";
import { createPreferenceStore } from "./preference-store";
import { STORAGE_KEYS } from "./storage";
import type { ResolvedTheme } from "./theme";

/** The app's default accent color (`--purple-fill` in `src/styles/tokens.css`). */
export const DEFAULT_ACCENT_COLOR = "#6d3bd7";

export interface AccentPreset {
  id: string;
  label: string;
  hex: string;
}

/** Curated quick-select accent presets shown inline in Settings (Purple is the default). */
export const ACCENT_PRESETS: readonly AccentPreset[] = [
  { id: "purple", label: "Purple", hex: DEFAULT_ACCENT_COLOR },
  { id: "blue", label: "Blue", hex: "#2563eb" },
  { id: "teal", label: "Teal", hex: "#0f766e" },
  { id: "rose", label: "Rose", hex: "#e11d48" },
  { id: "amber", label: "Amber", hex: "#b45309" },
] as const;

/** Extended 11-color grid shown inside the custom "Pick a theme color" modal (plus the custom + wheel). */
export const MODAL_ACCENT_PRESETS: readonly AccentPreset[] = [
  { id: "emerald", label: "Emerald", hex: "#0ea472" },
  { id: "blue", label: "Blue", hex: "#2563eb" },
  { id: "sky", label: "Sky", hex: "#56b6c2" },
  { id: "lavender", label: "Lavender", hex: "#a78bfa" },
  { id: "forest", label: "Forest", hex: "#3f5940" },
  { id: "burgundy", label: "Burgundy", hex: "#7c2d52" },
  { id: "teal", label: "Teal", hex: "#0f766e" },
  { id: "purple", label: "Purple", hex: DEFAULT_ACCENT_COLOR },
  { id: "coral", label: "Coral", hex: "#f96b59" },
  { id: "rose", label: "Rose", hex: "#e11d48" },
  { id: "amber", label: "Amber", hex: "#b45309" },
] as const;

const HEX_COLOR_RE = /^#[0-9a-f]{6}$/;

/** Lowercase `#rrggbb` validation; rejects short hex, alpha, or arbitrary CSS values. */
export function normalizeAccentColor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  return HEX_COLOR_RE.test(trimmed) ? trimmed : null;
}

export function isAccentColor(value: unknown): value is string {
  return typeof value === "string" && HEX_COLOR_RE.test(value);
}

type Rgb = [number, number, number];
type Hsl = [number, number, number];
export type Hsv = { h: number; s: number; v: number };

function hexToRgb(hex: string): Rgb {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}

/** Converts a valid `#rrggbb` hex color to HSV (`h` in `[0, 360)`, `s` and `v` in `[0, 1]`). */
export function hexToHsv(hex: string): Hsv {
  const normalized = normalizeAccentColor(hex) ?? DEFAULT_ACCENT_COLOR;
  const [r, g, b] = hexToRgb(normalized).map((c) => c / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  const s = max === 0 ? 0 : d / max;
  const v = max;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
    else if (max === g) h = ((b - r) / d + 2) * 60;
    else h = ((r - g) / d + 4) * 60;
  }
  return { h: h % 360, s, v };
}

/** Converts HSV (`h` in `[0, 360]`, `s` and `v` in `[0, 1]`) to lowercase `#rrggbb`. */
export function hsvToHex({ h, s, v }: Hsv): string {
  const hn = ((h % 360) + 360) % 360;
  const sc = Math.max(0, Math.min(1, s));
  const vc = Math.max(0, Math.min(1, v));
  const c = vc * sc;
  const x = c * (1 - Math.abs(((hn / 60) % 2) - 1));
  const m = vc - c;
  let r = 0;
  let g = 0;
  let b = 0;
  if (hn < 60) [r, g, b] = [c, x, 0];
  else if (hn < 120) [r, g, b] = [x, c, 0];
  else if (hn < 180) [r, g, b] = [0, c, x];
  else if (hn < 240) [r, g, b] = [0, x, c];
  else if (hn < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return rgbToHex([(r + m) * 255, (g + m) * 255, (b + m) * 255]);
}

function clampByte(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
}

function rgbToHex([r, g, b]: Rgb): string {
  return `#${[r, g, b].map((v) => clampByte(v).toString(16).padStart(2, "0")).join("")}`;
}

function rgbTriplet([r, g, b]: Rgb): string {
  return `${clampByte(r)} ${clampByte(g)} ${clampByte(b)}`;
}

function rgbToHsl([r, g, b]: Rgb): Hsl {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0);
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  return [h * 60, s, l];
}

function hslToRgb([h, s, l]: Hsl): Rgb {
  const hn = ((h % 360) + 360) % 360;
  const sc = Math.max(0, Math.min(1, s));
  const lc = Math.max(0, Math.min(1, l));
  const c = (1 - Math.abs(2 * lc - 1)) * sc;
  const x = c * (1 - Math.abs(((hn / 60) % 2) - 1));
  const m = lc - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (hn < 60) [r, g, b] = [c, x, 0];
  else if (hn < 120) [r, g, b] = [x, c, 0];
  else if (hn < 180) [r, g, b] = [0, c, x];
  else if (hn < 240) [r, g, b] = [0, x, c];
  else if (hn < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [clampByte((r + m) * 255), clampByte((g + m) * 255), clampByte((b + m) * 255)];
}

function relativeLuminance([r, g, b]: Rgb): number {
  const channel = (v: number) => {
    const n = v / 255;
    return n <= 0.03928 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

/** Picks a tinted light or dark foreground that maximizes contrast against `fillHex`. */
export function contrastingTextOnFill(fillHex: string): string {
  const fillRgb = hexToRgb(fillHex);
  const [h, s] = rgbToHsl(fillRgb);
  const light = hslToRgb([h, Math.min(s, 0.3), 0.99]);
  const dark = hslToRgb([h, Math.min(s, 0.35), 0.05]);
  return contrastRatio(fillRgb, light) >= contrastRatio(fillRgb, dark) ? rgbToHex(light) : rgbToHex(dark);
}

/** Adjusts lightness in `direction` (+1 lighter, -1 darker) until `minRatio` vs `bg` is met. */
function ensureContrast(
  h: number,
  s: number,
  startL: number,
  bg: Rgb,
  minRatio: number,
  direction: 1 | -1,
): Rgb {
  let l = Math.max(0.05, Math.min(0.96, startL));
  let rgb = hslToRgb([h, s, l]);
  for (let step = 0; step < 30 && contrastRatio(rgb, bg) < minRatio; step += 1) {
    l = Math.max(0.05, Math.min(0.96, l + direction * 0.03));
    rgb = hslToRgb([h, s, l]);
  }
  return rgb;
}

/** The 15 `--purple-*` tokens in `tokens.css` that control the app's accent color. */
export const ACCENT_CSS_TOKENS = [
  "--purple-fill",
  "--purple-fill-hover",
  "--purple-fill-line",
  "--purple-fill-rgb",
  "--purple-on-fill",
  "--purple-accent",
  "--purple-accent-rgb",
  "--purple-text",
  "--purple-text-rgb",
  "--purple-on-text",
  "--purple-ink",
  "--purple-chip",
  "--purple-chip-active",
  "--purple-surface",
  "--purple-surface-active",
] as const;

export type AccentCssToken = (typeof ACCENT_CSS_TOKENS)[number];

const DARK_CARD_BG: Rgb = [28, 27, 27]; // --obsidian-surface-low (#1c1b1b)
const LIGHT_CARD_BG: Rgb = [255, 255, 255]; // --obsidian-surface-low (#ffffff)

/**
 * Derives the complete accent token set for a given `#rrggbb` base fill and resolved theme,
 * keeping labels, borders, surfaces, and focus rings WCAG-legible across dark, OLED, and light themes.
 */
export function deriveAccentTokens(hex: string, theme: ResolvedTheme): Record<AccentCssToken, string> {
  const fillRgb = hexToRgb(hex);
  const [h, s, l] = rgbToHsl(fillRgb);
  const isLight = theme === "light";

  const hoverDelta = l > 0.62 ? -0.08 : 0.08;
  const lineDelta = l > 0.62 ? -0.15 : 0.16;
  const fillHoverRgb = hslToRgb([h, Math.min(1, s * 1.02), Math.max(0.12, Math.min(0.92, l + hoverDelta))]);
  const fillLineRgb = hslToRgb([h, Math.min(1, s * 0.96), Math.max(0.18, Math.min(0.95, l + lineDelta))]);
  const onFillHex = contrastingTextOnFill(hex);

  if (isLight) {
    const accentSat = s > 0.08 ? Math.max(s, 0.58) : s;
    const accentRgb = ensureContrast(h, accentSat, Math.min(l, 0.48), LIGHT_CARD_BG, 4.5, -1);
    const surfaceRgb = hslToRgb([h, Math.min(s, 0.52), 0.94]);
    const surfaceActiveRgb = hslToRgb([h, Math.min(s, 0.56), 0.89]);
    const textRgb = ensureContrast(h, accentSat, Math.min(l, 0.44), surfaceRgb, 4.5, -1);
    const inkRgb = ensureContrast(h, Math.min(s, 0.65), 0.28, LIGHT_CARD_BG, 7, -1);
    const chipRgb = ensureContrast(h, Math.min(s, 0.65), 0.3, LIGHT_CARD_BG, 6.5, -1);
    const chipActiveRgb = ensureContrast(h, Math.min(s, 0.68), 0.26, LIGHT_CARD_BG, 7, -1);
    const onTextHex = contrastingTextOnFill(rgbToHex(textRgb));

    return {
      "--purple-fill": hex,
      "--purple-fill-hover": rgbToHex(fillHoverRgb),
      "--purple-fill-line": rgbToHex(fillLineRgb),
      "--purple-fill-rgb": rgbTriplet(fillRgb),
      "--purple-on-fill": onFillHex,
      "--purple-accent": rgbToHex(accentRgb),
      "--purple-accent-rgb": rgbTriplet(accentRgb),
      "--purple-text": rgbToHex(textRgb),
      "--purple-text-rgb": rgbTriplet(textRgb),
      "--purple-on-text": onTextHex,
      "--purple-ink": rgbToHex(inkRgb),
      "--purple-chip": rgbToHex(chipRgb),
      "--purple-chip-active": rgbToHex(chipActiveRgb),
      "--purple-surface": rgbToHex(surfaceRgb),
      "--purple-surface-active": rgbToHex(surfaceActiveRgb),
    };
  }

  const accentSat = s > 0.08 ? Math.min(1, Math.max(s, 0.65)) : s;
  const surfaceRgb = hslToRgb([h, Math.min(s, 0.28), 0.18]);
  const surfaceActiveRgb = hslToRgb([h, Math.min(s, 0.36), 0.23]);
  const accentRgb = ensureContrast(h, accentSat, Math.max(l, 0.68), DARK_CARD_BG, 4.5, 1);
  const textRgb = ensureContrast(h, Math.min(s, 0.85), 0.84, surfaceRgb, 7, 1);
  const onTextHex = contrastingTextOnFill(rgbToHex(textRgb));
  const inkRgb = hslToRgb([h, Math.min(s, 0.45), 0.97]);
  const chipRgb = hslToRgb([h, Math.min(s, 0.85), 0.89]);
  const chipActiveRgb = hslToRgb([h, Math.min(s, 0.85), 0.81]);

  return {
    "--purple-fill": hex,
    "--purple-fill-hover": rgbToHex(fillHoverRgb),
    "--purple-fill-line": rgbToHex(fillLineRgb),
    "--purple-fill-rgb": rgbTriplet(fillRgb),
    "--purple-on-fill": onFillHex,
    "--purple-accent": rgbToHex(accentRgb),
    "--purple-accent-rgb": rgbTriplet(accentRgb),
    "--purple-text": rgbToHex(textRgb),
    "--purple-text-rgb": rgbTriplet(textRgb),
    "--purple-on-text": onTextHex,
    "--purple-ink": rgbToHex(inkRgb),
    "--purple-chip": rgbToHex(chipRgb),
    "--purple-chip-active": rgbToHex(chipActiveRgb),
    "--purple-surface": rgbToHex(surfaceRgb),
    "--purple-surface-active": rgbToHex(surfaceActiveRgb),
  };
}

const store = createPreferenceStore<string>(STORAGE_KEYS.accentColor, DEFAULT_ACCENT_COLOR, isAccentColor);

export const readAccentColor = store.readStored;
export const getAccentColor = store.get;
export const subscribeAccentColor = store.subscribe;

function currentResolvedTheme(): ResolvedTheme {
  if (typeof document === "undefined") return "dark";
  const attr = document.documentElement.getAttribute("data-theme");
  if (attr === "light" || attr === "oled") return attr;
  return "dark";
}

/** Applies the current accent color tokens to `document.documentElement` for `resolvedTheme`. */
export function applyAccentColorToDocument(resolvedTheme: ResolvedTheme = currentResolvedTheme()): void {
  if (typeof document === "undefined") return;
  const style = document.documentElement.style;
  const hex = store.get();
  if (hex === DEFAULT_ACCENT_COLOR) {
    for (const token of ACCENT_CSS_TOKENS) style.removeProperty?.(token);
    return;
  }
  const tokens = deriveAccentTokens(hex, resolvedTheme);
  for (const token of ACCENT_CSS_TOKENS) {
    style.setProperty(token, tokens[token]);
  }
}

async function applyAccentColorToWindow(): Promise<void> {
  try {
    await bridgeApi.setTitleBarColor(store.get());
  } catch (cause) {
    // Mobile, secondary windows without the command, and test environments have no title bar to set.
    logIgnored("window title bar color", cause);
  }
}

// Keep the document CSS tokens in sync before any component listener runs.
store.subscribe(() => applyAccentColorToDocument());

/** Saves the accent color, applies it to the page and desktop title bar, and syncs other windows. */
export function setAccentColor(next: string): void {
  const normalized = normalizeAccentColor(next);
  if (!normalized) return;
  store.set(normalized);
  void applyAccentColorToWindow();
}

/** Loads the saved accent color, applies it, and follows updates from other windows. */
export function initAccentColor(resolvedTheme?: ResolvedTheme): void {
  store.refresh();
  applyAccentColorToDocument(resolvedTheme);
  void applyAccentColorToWindow();
  store.followOtherWindows();
}

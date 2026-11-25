import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installFakeWindow } from "../../test-utils/fakeWindow";
import {
  ACCENT_CSS_TOKENS,
  ACCENT_PRESETS,
  DEFAULT_ACCENT_COLOR,
  MODAL_ACCENT_PRESETS,
  contrastRatio,
  deriveAccentTokens,
  getAccentColor,
  hexToHsv,
  hsvToHex,
  initAccentColor,
  isAccentColor,
  normalizeAccentColor,
  readAccentColor,
  setAccentColor,
} from "./accent-color";
import { STORAGE_KEYS } from "./storage";

let env: ReturnType<typeof installFakeWindow>;

function hexToRgb(hex: string): [number, number, number] {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}

beforeEach(() => {
  env = installFakeWindow();
  setAccentColor(DEFAULT_ACCENT_COLOR);
});

afterEach(() => {
  setAccentColor(DEFAULT_ACCENT_COLOR);
  vi.unstubAllGlobals();
});

describe("accent color", () => {
  it("offers five distinct curated presets starting with default Purple", () => {
    expect(ACCENT_PRESETS).toHaveLength(5);
    expect(ACCENT_PRESETS[0]).toEqual({ id: "purple", label: "Purple", hex: DEFAULT_ACCENT_COLOR });
    const uniqueHexes = new Set(ACCENT_PRESETS.map((p) => p.hex));
    expect(uniqueHexes.size).toBe(5);
  });

  it("offers eleven distinct modal presets that include every quick preset", () => {
    expect(MODAL_ACCENT_PRESETS).toHaveLength(11);
    const modalHexes = new Set(MODAL_ACCENT_PRESETS.map((p) => p.hex));
    expect(modalHexes.size).toBe(11);
    for (const preset of ACCENT_PRESETS) {
      expect(modalHexes.has(preset.hex)).toBe(true);
    }
  });

  it("round-trips hex <-> HSV cleanly", () => {
    for (const hex of [DEFAULT_ACCENT_COLOR, "#2563eb", "#0ea472", "#e11d48", "#ffffff", "#000000"]) {
      expect(hsvToHex(hexToHsv(hex))).toBe(hex);
    }
  });

  it("validates and normalizes 6-digit hex colors strictly", () => {
    expect(normalizeAccentColor(" #2563EB ")).toBe("#2563eb");
    expect(isAccentColor("#0d9488")).toBe(true);
    expect(normalizeAccentColor("#fff")).toBeNull();
    expect(normalizeAccentColor("red")).toBeNull();
    expect(normalizeAccentColor("#12345678")).toBeNull();
    expect(normalizeAccentColor("rgb(1,2,3)")).toBeNull();
    expect(normalizeAccentColor(null)).toBeNull();
  });

  it("defaults to Purple when storage is empty or invalid", () => {
    expect(readAccentColor()).toBe(DEFAULT_ACCENT_COLOR);
    window.localStorage.setItem(STORAGE_KEYS.accentColor, "not-a-color");
    expect(readAccentColor()).toBe(DEFAULT_ACCENT_COLOR);
  });

  it("saves a chosen color, applies all accent CSS tokens, and retains it across reload", () => {
    setAccentColor("#2563EB");
    expect(window.localStorage.getItem(STORAGE_KEYS.accentColor)).toBe("#2563eb");
    expect(getAccentColor()).toBe("#2563eb");
    expect(env.cssVars.get("--purple-fill")).toBe("#2563eb");
    expect(env.cssVars.get("--purple-fill-rgb")).toBe("37 99 235");

    // Simulate reload: clear inline vars and re-initialize from localStorage.
    env.cssVars.clear();
    initAccentColor("dark");
    expect(getAccentColor()).toBe("#2563eb");
    expect(env.cssVars.get("--purple-fill")).toBe("#2563eb");
  });

  it("clears inline overrides when returning to the default Purple", () => {
    setAccentColor("#0d9488");
    expect(env.cssVars.size).toBe(ACCENT_CSS_TOKENS.length);
    setAccentColor(DEFAULT_ACCENT_COLOR);
    for (const token of ACCENT_CSS_TOKENS) {
      expect(env.cssVars.has(token)).toBe(false);
    }
  });

  it("maintains WCAG AA contrast (>= 4.5:1) for presets and extreme custom colors in both themes", () => {
    const samples = [
      ...MODAL_ACCENT_PRESETS.map((p) => p.hex),
      "#ffee00",
      "#00ffcc",
      "#12183a",
      "#ffffff",
      "#000000",
      "#808080",
    ];
    for (const theme of ["dark", "oled", "light"] as const) {
      const cardBg: [number, number, number] = theme === "light" ? [255, 255, 255] : [28, 27, 27];
      for (const hex of samples) {
        const tokens = deriveAccentTokens(hex, theme);
        expect(contrastRatio(hexToRgb(tokens["--purple-on-fill"]), hexToRgb(tokens["--purple-fill"])), `${theme} on-fill ${hex}`).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(hexToRgb(tokens["--purple-accent"]), cardBg), `${theme} accent ${hex}`).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(hexToRgb(tokens["--purple-text"]), hexToRgb(tokens["--purple-surface"])), `${theme} text ${hex}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});

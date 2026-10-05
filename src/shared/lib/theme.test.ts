import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installFakeWindow } from "../../test-utils/fakeWindow";
import { STORAGE_KEYS } from "./storage";
import { isThemePreference, readThemePreference, resolveTheme } from "./theme";

beforeEach(() => {
  installFakeWindow();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("theme preference", () => {
  it("resolves explicit choices regardless of the system setting", () => {
    expect(resolveTheme("dark", true)).toBe("dark");
    expect(resolveTheme("light", false)).toBe("light");
  });

  it("follows the system setting when set to system", () => {
    expect(resolveTheme("system", true)).toBe("light");
    expect(resolveTheme("system", false)).toBe("dark");
  });

  it("validates stored values", () => {
    expect(isThemePreference("light")).toBe(true);
    expect(isThemePreference("sepia")).toBe(false);
    expect(isThemePreference(null)).toBe(false);
  });

  it("defaults to dark when nothing valid is stored", () => {
    expect(readThemePreference()).toBe("dark");
    window.localStorage.setItem(STORAGE_KEYS.theme, "sepia");
    expect(readThemePreference()).toBe("dark");
  });

  it("reads a saved preference", () => {
    window.localStorage.setItem(STORAGE_KEYS.theme, "system");
    expect(readThemePreference()).toBe("system");
  });
});

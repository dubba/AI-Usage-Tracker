import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installFakeWindow } from "../../test-utils/fakeWindow";
import { readSettingsAdvancedOpen, writeSettingsAdvancedOpen } from "./settings-view-state";
import { STORAGE_KEYS, storageGet } from "../../shared/lib/storage";

beforeEach(() => {
  installFakeWindow();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("settings-view-state", () => {
  it("defaults to false when storage is empty", () => {
    expect(readSettingsAdvancedOpen()).toBe(false);
  });

  it("stores true when expanded and removes it when collapsed", () => {
    writeSettingsAdvancedOpen(true);
    expect(storageGet(STORAGE_KEYS.settingsAdvancedOpen)).toBe("true");
    expect(readSettingsAdvancedOpen()).toBe(true);

    writeSettingsAdvancedOpen(false);
    expect(storageGet(STORAGE_KEYS.settingsAdvancedOpen)).toBeNull();
    expect(readSettingsAdvancedOpen()).toBe(false);
  });
});

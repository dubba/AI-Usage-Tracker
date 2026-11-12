import { describe, expect, it } from "vitest";
import { matchShortcut, shortcutLabel, type ShortcutKeyEvent } from "./shortcuts";

const press = (key: string, extra: Partial<ShortcutKeyEvent> = {}): ShortcutKeyEvent => ({
  key,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...extra,
});

describe("matchShortcut", () => {
  it("uses Ctrl on Windows and Linux", () => {
    expect(matchShortcut(press("r", { ctrlKey: true }), false)).toBe("refreshAll");
    expect(matchShortcut(press("n", { ctrlKey: true }), false)).toBe("addAccount");
    expect(matchShortcut(press("a", { ctrlKey: true }), false)).toBe("addAccount");
    expect(matchShortcut(press(",", { ctrlKey: true }), false)).toBe("openSettings");
    expect(matchShortcut(press("s", { ctrlKey: true }), false)).toBe("cyclePages");
    expect(matchShortcut(press("g", { ctrlKey: true }), false)).toBe("addGroup");
    expect(matchShortcut(press("r", { metaKey: true }), false)).toBeNull();
  });

  it("uses Cmd on macOS", () => {
    expect(matchShortcut(press("r", { metaKey: true }), true)).toBe("refreshAll");
    expect(matchShortcut(press("n", { metaKey: true }), true)).toBe("addAccount");
    expect(matchShortcut(press("a", { metaKey: true }), true)).toBe("addAccount");
    expect(matchShortcut(press(",", { metaKey: true }), true)).toBe("openSettings");
    expect(matchShortcut(press("s", { metaKey: true }), true)).toBe("cyclePages");
    expect(matchShortcut(press("r", { ctrlKey: true }), true)).toBeNull();
  });

  it("ignores the key without the modifier", () => {
    expect(matchShortcut(press("r"), false)).toBeNull();
    expect(matchShortcut(press(","), true)).toBeNull();
  });

  it("is not case sensitive (caps lock)", () => {
    expect(matchShortcut(press("R", { ctrlKey: true }), false)).toBe("refreshAll");
  });

  it("leaves D and U alone", () => {
    expect(matchShortcut(press("d", { ctrlKey: true }), false)).toBeNull();
    expect(matchShortcut(press("u", { ctrlKey: true }), false)).toBeNull();
    expect(matchShortcut(press("d", { metaKey: true }), true)).toBeNull();
    expect(matchShortcut(press("u", { metaKey: true }), true)).toBeNull();
  });

  it("maps 1, 2 and 3 to the Dashboard, Usage and Settings pages, by character or by physical key", () => {
    const pages = { "1": "goAccounts", "2": "goActivity", "3": "openSettings" } as const;
    for (const [key, action] of Object.entries(pages)) {
      expect(matchShortcut(press(key, { ctrlKey: true }), false)).toBe(action);
      expect(matchShortcut(press(key, { metaKey: true }), true)).toBe(action);
      expect(matchShortcut(press("&", { metaKey: true, code: `Digit${key}` }), true)).toBe(action);
      expect(matchShortcut(press(key), false)).toBeNull();
      expect(matchShortcut(press(key, { metaKey: true, shiftKey: true }), true)).toBeNull();
    }
    expect(matchShortcut(press("4", { metaKey: true }), true)).toBeNull();
  });

  it("matches via physical event.code when key layout differs", () => {
    expect(matchShortcut(press("ф", { metaKey: true, code: "KeyA" }), true)).toBe("addAccount");
    expect(matchShortcut(press("т", { metaKey: true, code: "KeyN" }), true)).toBe("addAccount");
    expect(matchShortcut(press("ы", { metaKey: true, code: "KeyS" }), true)).toBe("cyclePages");
    expect(matchShortcut(press("?", { metaKey: true, code: "Comma" }), true)).toBe("openSettings");
  });

  it("leaves other modifier combinations alone", () => {
    expect(matchShortcut(press("r", { ctrlKey: true, shiftKey: true }), false)).toBeNull();
    expect(matchShortcut(press("r", { ctrlKey: true, altKey: true }), false)).toBeNull();
    expect(matchShortcut(press("r", { ctrlKey: true, metaKey: true }), false)).toBeNull();
    expect(matchShortcut(press("r", { metaKey: true, ctrlKey: true }), true)).toBeNull();
  });

  it("ignores held keys and IME composition", () => {
    expect(matchShortcut(press("r", { ctrlKey: true, repeat: true }), false)).toBeNull();
    expect(matchShortcut(press("r", { ctrlKey: true, isComposing: true }), false)).toBeNull();
  });

  it("ignores other keys", () => {
    expect(matchShortcut(press("x", { ctrlKey: true }), false)).toBeNull();
    expect(matchShortcut(press("q", { ctrlKey: true }), false)).toBeNull();
    expect(matchShortcut(press("ArrowUp", { ctrlKey: true }), false)).toBeNull();
  });
});

describe("shortcutLabel", () => {
  it("shows the platform's modifier", () => {
    expect(shortcutLabel("r", true)).toBe("⌘R");
    expect(shortcutLabel("r", false)).toBe("Ctrl+R");
    expect(shortcutLabel(",", false)).toBe("Ctrl+,");
  });

  it("formats multiple keys joined by commas", () => {
    expect(shortcutLabel(["n", "a"], true)).toBe("⌘N, ⌘A");
    expect(shortcutLabel(["n", "a"], false)).toBe("Ctrl+N, Ctrl+A");
  });
});

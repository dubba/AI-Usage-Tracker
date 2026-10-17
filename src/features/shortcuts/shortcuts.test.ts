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
    expect(matchShortcut(press("u", { ctrlKey: true }), false)).toBe("refreshAll");
    expect(matchShortcut(press("n", { ctrlKey: true }), false)).toBe("addAccount");
    expect(matchShortcut(press(",", { ctrlKey: true }), false)).toBe("openSettings");
    expect(matchShortcut(press("g", { ctrlKey: true }), false)).toBe("addGroup");
    expect(matchShortcut(press("u", { metaKey: true }), false)).toBeNull();
  });

  it("uses Cmd on macOS", () => {
    expect(matchShortcut(press("u", { metaKey: true }), true)).toBe("refreshAll");
    expect(matchShortcut(press(",", { metaKey: true }), true)).toBe("openSettings");
    expect(matchShortcut(press("u", { ctrlKey: true }), true)).toBeNull();
  });

  it("ignores the key without the modifier", () => {
    expect(matchShortcut(press("u"), false)).toBeNull();
    expect(matchShortcut(press(","), true)).toBeNull();
  });

  it("is not case sensitive (caps lock)", () => {
    expect(matchShortcut(press("U", { ctrlKey: true }), false)).toBe("refreshAll");
  });

  it("leaves other modifier combinations alone", () => {
    expect(matchShortcut(press("u", { ctrlKey: true, shiftKey: true }), false)).toBeNull();
    expect(matchShortcut(press("u", { ctrlKey: true, altKey: true }), false)).toBeNull();
    expect(matchShortcut(press("u", { ctrlKey: true, metaKey: true }), false)).toBeNull();
    expect(matchShortcut(press("u", { metaKey: true, ctrlKey: true }), true)).toBeNull();
  });

  it("ignores held keys and IME composition", () => {
    expect(matchShortcut(press("u", { ctrlKey: true, repeat: true }), false)).toBeNull();
    expect(matchShortcut(press("u", { ctrlKey: true, isComposing: true }), false)).toBeNull();
  });

  it("ignores other keys", () => {
    expect(matchShortcut(press("x", { ctrlKey: true }), false)).toBeNull();
    expect(matchShortcut(press("r", { ctrlKey: true }), false)).toBeNull();
    expect(matchShortcut(press("ArrowUp", { ctrlKey: true }), false)).toBeNull();
  });
});

describe("shortcutLabel", () => {
  it("shows the platform's modifier", () => {
    expect(shortcutLabel("u", true)).toBe("⌘U");
    expect(shortcutLabel("u", false)).toBe("Ctrl+U");
    expect(shortcutLabel(",", false)).toBe("Ctrl+,");
  });
});

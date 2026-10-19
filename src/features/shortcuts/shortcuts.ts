/** What a keyboard shortcut does. */
export type ShortcutAction = "refreshAll" | "openSettings" | "addAccount" | "addGroup";

export interface ShortcutKeyEvent {
  key: string;
  code?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  repeat?: boolean;
  isComposing?: boolean;
}

export interface ShortcutItem {
  action: ShortcutAction;
  key: string;
  keys: readonly string[];
  label: string;
}

/** The shortcuts, in the order they are listed in Settings. `key` is the lower-case `event.key`. */
export const SHORTCUTS: ReadonlyArray<ShortcutItem> = [
  { action: "refreshAll", key: "r", keys: ["r"], label: "Refresh all accounts" },
  { action: "addAccount", key: "n", keys: ["n", "a"], label: "Add an account" },
  { action: "addGroup", key: "g", keys: ["g"], label: "Add a group" },
  { action: "openSettings", key: ",", keys: [",", "s"], label: "Switch between Settings and Dashboard page" },
];

export function isMacPlatform(): boolean {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent);
}

/** "⌘R" on macOS, "Ctrl+R" elsewhere (for the refresh-all shortcut). */
export function shortcutLabel(key: string | readonly string[], mac: boolean): string {
  if (typeof key !== "string") {
    return key.map((k) => shortcutLabel(k, mac)).join(", ");
  }
  const shown = key.length === 1 ? key.toUpperCase() : key;
  return mac ? `⌘${shown}` : `Ctrl+${shown}`;
}

/**
 * The action for a key press, or null. The shortcut modifier is Cmd on macOS and Ctrl elsewhere, and
 * it must be the only modifier held, so combinations such as Ctrl+Shift+R or Alt+R are left alone.
 */
export function matchShortcut(event: ShortcutKeyEvent, mac: boolean): ShortcutAction | null {
  if (event.repeat || event.isComposing) return null;
  if (event.altKey || event.shiftKey) return null;
  const modifier = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (!modifier) return null;
  const key = event.key.toLowerCase();
  const codeKey = event.code?.startsWith("Key")
    ? event.code.slice(3).toLowerCase()
    : event.code === "Comma"
      ? ","
      : null;
  return (
    SHORTCUTS.find(
      (shortcut) =>
        shortcut.keys.includes(key) || (codeKey !== null && shortcut.keys.includes(codeKey)),
    )?.action ?? null
  );
}

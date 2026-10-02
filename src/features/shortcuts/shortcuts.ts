/** What a keyboard shortcut does. */
export type ShortcutAction = "refreshAll" | "openSettings" | "addAccount" | "addGroup";

export interface ShortcutKeyEvent {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  repeat?: boolean;
  isComposing?: boolean;
}

/** The shortcuts, in the order they are listed in Settings. `key` is the lower-case `event.key`. */
export const SHORTCUTS: ReadonlyArray<{ action: ShortcutAction; key: string; label: string }> = [
  { action: "refreshAll", key: "r", label: "Refresh all accounts" },
  { action: "addAccount", key: "n", label: "Add an account" },
  { action: "addGroup", key: "g", label: "Add a group" },
  { action: "openSettings", key: ",", label: "Open Settings" },
];

export function isMacPlatform(): boolean {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent);
}

/** "⌘R" on macOS, "Ctrl+R" elsewhere. */
export function shortcutLabel(key: string, mac: boolean): string {
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
  return SHORTCUTS.find((shortcut) => shortcut.key === key)?.action ?? null;
}

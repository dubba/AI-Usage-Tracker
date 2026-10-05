import { logIgnored } from "./log";
import { STORAGE_KEYS, storageGet, storageSet } from "./storage";

export type ThemePreference = "dark" | "light" | "system";
export type ResolvedTheme = "dark" | "light";

export const THEME_PREFERENCES: readonly ThemePreference[] = ["dark", "light", "system"];

const DEFAULT_PREFERENCE: ThemePreference = "dark";
const LIGHT_QUERY = "(prefers-color-scheme: light)";

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === "dark" || value === "light" || value === "system";
}

export function resolveTheme(preference: ThemePreference, systemPrefersLight: boolean): ResolvedTheme {
  if (preference === "system") return systemPrefersLight ? "light" : "dark";
  return preference;
}

function systemPrefersLight(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.(LIGHT_QUERY).matches === true;
}

export function readThemePreference(): ThemePreference {
  const saved = storageGet(STORAGE_KEYS.theme);
  return isThemePreference(saved) ? saved : DEFAULT_PREFERENCE;
}

let preference: ThemePreference = DEFAULT_PREFERENCE;
const listeners = new Set<() => void>();

function applyToDocument(): void {
  document.documentElement.setAttribute("data-theme", resolveTheme(preference, systemPrefersLight()));
}

// Keeps the native title bar in step with the page. `null` hands control back to the OS.
async function applyToWindow(): Promise<void> {
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().setTheme(preference === "system" ? null : preference);
  } catch (cause) {
    // Mobile and test environments have no window theme to set.
    logIgnored("window theme", cause);
  }
}

function setPreference(next: ThemePreference): void {
  if (next === preference) return;
  preference = next;
  applyToDocument();
  listeners.forEach((notify) => notify());
}

export function getThemePreference(): ThemePreference {
  return preference;
}

export function subscribeThemePreference(notify: () => void): () => void {
  listeners.add(notify);
  return () => listeners.delete(notify);
}

/** Saves the choice, applies it here, and (via the `storage` event) in the app's other windows. */
export function setThemePreference(next: ThemePreference): void {
  storageSet(STORAGE_KEYS.theme, next);
  setPreference(next);
  void applyToWindow();
}

/** Applies the saved theme and keeps it current. Call once per window, before the first render. */
export function initTheme(): void {
  preference = readThemePreference();
  applyToDocument();
  void applyToWindow();

  window.matchMedia?.(LIGHT_QUERY).addEventListener?.("change", () => {
    if (preference === "system") applyToDocument();
  });
  window.addEventListener("storage", (event) => {
    if (event.key === STORAGE_KEYS.theme) setPreference(readThemePreference());
  });
}

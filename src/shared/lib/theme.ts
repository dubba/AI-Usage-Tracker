import { logIgnored } from "./log";
import { createPreferenceStore } from "./preference-store";
import { STORAGE_KEYS } from "./storage";

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

const store = createPreferenceStore<ThemePreference>(STORAGE_KEYS.theme, DEFAULT_PREFERENCE, isThemePreference);

export const readThemePreference = store.readStored;
export const getThemePreference = store.get;
export const subscribeThemePreference = store.subscribe;

function applyToDocument(): void {
  document.documentElement.setAttribute("data-theme", resolveTheme(store.get(), systemPrefersLight()));
}

// Keeps the native title bar in step with the page. `null` hands control back to the OS.
async function applyToWindow(): Promise<void> {
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const preference = store.get();
    await getCurrentWindow().setTheme(preference === "system" ? null : preference);
  } catch (cause) {
    // Mobile and test environments have no window theme to set.
    logIgnored("window theme", cause);
  }
}

// The page follows the preference before any other listener hears about the change.
store.subscribe(applyToDocument);

/** Saves the choice, applies it here, and (via the `storage` event) in the app's other windows. */
export function setThemePreference(next: ThemePreference): void {
  store.set(next);
  void applyToWindow();
}

/** Applies the saved theme and keeps it current. Call once per window, before the first render. */
export function initTheme(): void {
  store.refresh();
  applyToDocument();
  void applyToWindow();

  window.matchMedia?.(LIGHT_QUERY).addEventListener?.("change", () => {
    if (store.get() === "system") applyToDocument();
  });
  store.followOtherWindows();
}

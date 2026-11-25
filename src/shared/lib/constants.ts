/** Id of the sidebar element, referenced by the menu buttons that open it. */
export const SIDEBAR_ID = "app-sidebar";

// Shown only until getVersion() resolves; getVersion() is the single source of truth.
// Derived from package.json so it cannot go stale between releases.
export { version as FALLBACK_APP_VERSION } from "../../../package.json";

/**
 * A test build's name (such as `0.7.1-unrel_2026-11-25_0340a`), set with `VITE_BUILD_LABEL` when
 * a test APK or IPA is built, so Settings shows which build is installed. The app's own version
 * stays a plain release number for the updater. Empty in release builds.
 */
export const BUILD_LABEL: string = import.meta.env.VITE_BUILD_LABEL?.trim() ?? "";

/**
 * Refresh interval assumed until settings load. Matches `DEFAULT_ACCOUNT_REFRESH_MINUTES` in
 * `settings.rs`; a test in `src-tauri` (`frontend_contract.rs`) checks that they agree.
 */
export const DEFAULT_ACCOUNT_REFRESH_MINUTES = 15;

/** What the Settings page is for: under its title. */
export const SETTINGS_DESCRIPTION = "Manage app preferences, updates, and sync devices";

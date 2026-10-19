/** Id of the sidebar element, referenced by the menu buttons that open it. */
export const SIDEBAR_ID = "app-sidebar";

// Shown only until getVersion() resolves; getVersion() is the single source of truth.
// Derived from package.json so it cannot go stale between releases.
export { version as FALLBACK_APP_VERSION } from "../../../package.json";

/**
 * Refresh interval assumed until settings load. Matches `DEFAULT_ACCOUNT_REFRESH_MINUTES` in
 * `settings.rs`; a test in `src-tauri` (`frontend_contract.rs`) checks that they agree.
 */
export const DEFAULT_ACCOUNT_REFRESH_MINUTES = 15;

/** Length of the 5-hour and weekly usage windows, as the backend reports them (`model.rs`). */
export const FIVE_HOUR_WINDOW_SECONDS = 18_000;
export const WEEKLY_WINDOW_SECONDS = 604_800;

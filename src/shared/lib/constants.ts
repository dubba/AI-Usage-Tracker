// Shown only until getVersion() resolves; getVersion() is the single source of truth.
// Derived from package.json so it cannot go stale between releases.
/** Id of the sidebar element, referenced by the menu buttons that open it. */
export const SIDEBAR_ID = "app-sidebar";

export { version as FALLBACK_APP_VERSION } from "../../../package.json";

/** Refresh interval assumed until settings load. */
export const DEFAULT_ACCOUNT_REFRESH_MINUTES = 15;

import type { Account } from "../../types";

/**
 * The `source` strings the backend puts on a usage snapshot. They are written by
 * `providers/google_ai_studio.rs` and checked against it by a test in `src-tauri`
 * (`frontend_contract.rs`), so change both together.
 */
export const USAGE_SOURCES = {
  /** An API key that works but has no quota data yet. */
  googleModelAccess: "google_ai_studio_model_access",
  /** Cloud Monitoring is set up and the first quota data is still on its way. */
  googleMonitoringWaiting: "google_ai_studio_monitoring_waiting",
  /** Quota windows read from Cloud Monitoring. */
  googleCloudMonitoring: "google_ai_studio_cloud_monitoring",
} as const;

/** Id of the Grok Bot usage window (`providers/grok.rs`). */
export const GROK_BOT_WINDOW_ID = "grok_bot";

function isGoogleWithSource(account: Account, source: string): boolean {
  return account.provider === "google_ai_studio" && account.lastUsage?.source === source;
}

/** A Google AI Studio account whose key works but which has no quota data (shown as "Key only"). */
export function isGoogleKeyOnly(account: Account): boolean {
  return isGoogleWithSource(account, USAGE_SOURCES.googleModelAccess);
}

/** A Google AI Studio account that is waiting for its first Cloud Monitoring data (shown as "Setup in progress"). */
export function isGoogleSetupPending(account: Account): boolean {
  return isGoogleWithSource(account, USAGE_SOURCES.googleMonitoringWaiting);
}

/** A Google AI Studio account whose usage was read from Cloud Monitoring. */
export function isGoogleCloudMonitored(account: Account): boolean {
  return isGoogleWithSource(account, USAGE_SOURCES.googleCloudMonitoring);
}

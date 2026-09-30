import { bridgeApi } from "./api";
import { errorMessage } from "./errors";
import { logIgnored } from "./log";
import type { StartupIssue } from "./types";

/**
 * Asks the backend whether it failed to start. Anything unexpected (running
 * outside Tauri, an older backend without the command) counts as "no problem":
 * the dashboard's own requests report real failures.
 */
export async function loadStartupIssue(): Promise<StartupIssue | null> {
  try {
    return (await bridgeApi.getStartupIssue()) ?? null;
  } catch (cause) {
    logIgnored("startup", cause);
    return null;
  }
}

/** Runs startup again. Resolves to what is still wrong, or `null` once it worked. */
export async function retryStartup(): Promise<StartupIssue | null> {
  try {
    return (await bridgeApi.retryStartup()) ?? null;
  } catch (cause) {
    return { message: `Retrying failed: ${errorMessage(cause)}`, dataDir: null };
  }
}

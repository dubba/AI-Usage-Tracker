import { bridgeApi } from "../../shared/lib/api";
import { recentErrorDetails } from "../../shared/lib/errors";

/**
 * Copies the redacted diagnostics report (versions, settings, per-account
 * status, recent log) to the clipboard, ready to paste into a bug report, followed by the technical
 * detail behind any recent error banners.
 * Rejects with a readable message when copying is not possible.
 */
export async function copyDiagnostics(): Promise<void> {
  const report = await bridgeApi.getDiagnostics();
  if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
    throw new Error("Copying to the clipboard is not available here.");
  }
  // The banners show plain sentences; the technical cause behind them goes here.
  const details = recentErrorDetails();
  const full = details.length ? `${report}\n\nRecent app errors (technical detail):\n${details.join("\n")}` : report;
  await navigator.clipboard.writeText(full);
}

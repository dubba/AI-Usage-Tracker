import { bridgeApi } from "../../shared/lib/api";
import { recentErrorDetails, redactDetail } from "../../shared/lib/errors";

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
  // Each line was redacted when it was recorded; redacting again here keeps the copied text safe
  // even if a line ever reaches the list another way.
  const details = recentErrorDetails().map(redactDetail);
  const full = details.length ? `${report}\n\nRecent app errors (technical detail):\n${details.join("\n")}` : report;
  await navigator.clipboard.writeText(full);
}

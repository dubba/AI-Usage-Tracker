import { bridgeApi } from "./api";
import { formatDragTrace } from "./drag-trace";

/**
 * Copies the redacted diagnostics report (versions, settings, per-account
 * status, recent log) plus the trace of the last few card drags to the
 * clipboard, ready to paste into a bug report.
 * Rejects with a readable message when copying is not possible.
 */
export async function copyDiagnostics(): Promise<void> {
  const report = await bridgeApi.getDiagnostics();
  if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
    throw new Error("Copying to the clipboard is not available here.");
  }
  await navigator.clipboard.writeText(`${report}\n\n${formatDragTrace()}`);
}

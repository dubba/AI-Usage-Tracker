/**
 * For failures that are deliberately not shown to the user (best-effort work,
 * optional platform features). Keeping a trace makes them findable in the
 * WebView console instead of disappearing entirely.
 */
export function logIgnored(scope: string, cause: unknown): void {
  console.warn(`[${scope}] ignored:`, cause);
}

/** Names of the window-level custom events the UI modules use to tell each other about changes. */
export const UI_EVENTS = {
  providerOrderChanged: "ai-subscription-tracker:provider-order-changed",
  groupOrderChanged: "ai-subscription-tracker:group-order-changed",
  pageOrderChanged: "ai-subscription-tracker:page-order-changed",
  loginStatus: "ai-usage-tracker:login-status",
  /** Something changed layout or data behind the scenes; re-read the snapshot and re-apply saved ordering. */
  dashboardResync: "ai-usage-tracker:dashboard-resync",
} as const;

export function requestDashboardResync(): void {
  window.dispatchEvent(new Event(UI_EVENTS.dashboardResync));
}

/**
 * Runs `handler` when a resync is requested and when the window regains focus
 * (the user may have changed things elsewhere). Returns an unsubscribe function.
 */
export function onDashboardResync(handler: () => void): () => void {
  window.addEventListener(UI_EVENTS.dashboardResync, handler);
  window.addEventListener("focus", handler);
  return () => {
    window.removeEventListener(UI_EVENTS.dashboardResync, handler);
    window.removeEventListener("focus", handler);
  };
}

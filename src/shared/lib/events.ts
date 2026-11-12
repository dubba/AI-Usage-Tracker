/** Names of the window-level custom events the UI modules use to tell each other about changes. */
export const UI_EVENTS = {
  providerOrderChanged: "ai-usage-tracker:provider-order-changed",
  groupOrderChanged: "ai-usage-tracker:group-order-changed",
  pageOrderChanged: "ai-usage-tracker:page-order-changed",
  loginStatus: "ai-usage-tracker:login-status",
  /** Something changed layout or data behind the scenes; re-read the snapshot and re-apply saved ordering. */
  dashboardResync: "ai-usage-tracker:dashboard-resync",
  /** The user moved a card or a sidebar group; the detail says which page it counts for. */
  reorderDone: "ai-usage-tracker:reorder-done",
} as const;

/** The pages whose "you can drag cards" hint a reorder can switch off. */
export type ReorderPage = "accounts" | "activity";

/**
 * Tells the hints the user reordered. A card moved on a page counts for that page only. A sidebar
 * group move counts for the page on screen (the sidebar orders both pages), and for none when
 * that page is Settings.
 */
export function announceReorder(source: ReorderPage | "sidebar"): void {
  const page = source === "sidebar"
    ? document.querySelector<HTMLElement>(".kept-page:not([hidden])")?.dataset.page
    : source;
  if (page !== "accounts" && page !== "activity") return;
  window.dispatchEvent(new CustomEvent<ReorderPage>(UI_EVENTS.reorderDone, { detail: page }));
}

/** Runs `handler` with the page each reorder counts for. Returns an unsubscribe function. */
export function onReorderDone(handler: (page: ReorderPage) => void): () => void {
  const listener = (event: Event) => handler((event as CustomEvent<ReorderPage>).detail);
  window.addEventListener(UI_EVENTS.reorderDone, listener);
  return () => window.removeEventListener(UI_EVENTS.reorderDone, listener);
}

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

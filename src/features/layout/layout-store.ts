import { useSyncExternalStore } from "react";
import { UI_EVENTS } from "../../shared/lib/events";
import type { Provider } from "../../types";
import { currentPageAccountOrders } from "./dashboard-page-state";
import { readSidebarGroupOrder, readDashboardProviderOrder, sidebarOrderLeadsAllPageNow } from "../sidebar/sidebar-order";

/**
 * The dashboard layout the screens follow: the provider order, the sidebar group order, each
 * page's account order, and whether the All page follows the sidebar.
 *
 * The writers (`storeSidebarGroupOrder`, `storePageAccountOrder`, `clearPendingAllOrder`, a layout
 * received from a paired device) keep the state and dispatch the `UI_EVENTS` events; this store
 * turns those events into a snapshot for `useSyncExternalStore`, so the screens need no listeners
 * or tick counters of their own, and what they compute from it has real dependencies. It listens
 * only while something subscribes.
 */
export type Layout = {
  providerOrder: readonly Provider[];
  groupOrder: readonly string[];
  /**
   * Account order by page id (see `currentPageAccountOrders`). A page without an entry shows its
   * accounts as given. Apply one with `orderAccounts`.
   */
  pageOrders: Readonly<Record<string, readonly string[]>>;
  /** A sidebar order was saved this session, so the All page follows the sidebar rows (see `sidebar-order`). */
  sidebarOrderLeadsAllPage: boolean;
};

let current: Layout | null = null;
const listeners = new Set<() => void>();
let detach: (() => void) | null = null;

const sameList = <T,>(a: readonly T[], b: readonly T[]) => a.length === b.length && a.every((value, index) => value === b[index]);

export function getLayout(): Layout {
  current ??= {
    providerOrder: readDashboardProviderOrder(),
    groupOrder: readSidebarGroupOrder(),
    pageOrders: currentPageAccountOrders(),
    sidebarOrderLeadsAllPage: sidebarOrderLeadsAllPageNow(),
  };
  return current;
}

function emit() {
  for (const notify of [...listeners]) notify();
}

/** Re-reads the provider and group order; the snapshot (and the subscribers) change only if they differ. */
function refreshOrders(): boolean {
  const before = getLayout();
  const providerOrder = readDashboardProviderOrder();
  const groupOrder = readSidebarGroupOrder();
  const sidebarOrderLeadsAllPage = sidebarOrderLeadsAllPageNow();
  if (
    sameList(before.providerOrder, providerOrder) &&
    sameList(before.groupOrder, groupOrder) &&
    before.sidebarOrderLeadsAllPage === sidebarOrderLeadsAllPage
  ) {
    return false;
  }
  current = { ...before, providerOrder, groupOrder, sidebarOrderLeadsAllPage };
  return true;
}

const samePageOrders = (a: Layout["pageOrders"], b: Layout["pageOrders"]) => {
  const pages = Object.keys(a);
  return pages.length === Object.keys(b).length && pages.every((page) => b[page] != null && sameList(a[page], b[page]));
};

/** Re-reads the page orders; the snapshot changes only if they differ. */
function refreshPageOrders(): boolean {
  const before = getLayout();
  const pageOrders = currentPageAccountOrders();
  if (samePageOrders(before.pageOrders, pageOrders)) return false;
  current = { ...before, pageOrders };
  return true;
}

function onOrdersChanged() {
  if (refreshOrders()) emit();
}

function onPageOrderChanged() {
  if (refreshPageOrders()) emit();
}

function attach() {
  // Anything saved while nobody was listening is picked up now.
  refreshOrders();
  refreshPageOrders();
  window.addEventListener(UI_EVENTS.groupOrderChanged, onOrdersChanged);
  window.addEventListener(UI_EVENTS.providerOrderChanged, onOrdersChanged);
  window.addEventListener(UI_EVENTS.pageOrderChanged, onPageOrderChanged);
  detach = () => {
    window.removeEventListener(UI_EVENTS.groupOrderChanged, onOrdersChanged);
    window.removeEventListener(UI_EVENTS.providerOrderChanged, onOrdersChanged);
    window.removeEventListener(UI_EVENTS.pageOrderChanged, onPageOrderChanged);
  };
}

export function subscribeLayout(notify: () => void): () => void {
  if (listeners.size === 0) attach();
  listeners.add(notify);
  return () => {
    listeners.delete(notify);
    if (listeners.size === 0) {
      detach?.();
      detach = null;
    }
  };
}

export function useLayout(): Layout {
  return useSyncExternalStore(subscribeLayout, getLayout, getLayout);
}

/** For tests: forget the snapshot and every subscriber. */
export function resetLayoutForTests(): void {
  detach?.();
  detach = null;
  listeners.clear();
  current = null;
}

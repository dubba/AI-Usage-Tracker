import { useSyncExternalStore } from "react";
import { UI_EVENTS } from "../../shared/lib/events";
import type { Provider } from "../../types";
import { readSidebarGroupOrder, readDashboardProviderOrder } from "./sidebar-order";

/**
 * The saved dashboard layout the screens follow: the provider order, the sidebar group order, and
 * a counter that moves whenever any page's account order was saved (the orders themselves are read
 * from storage by `applyPageAccountOrder`; the counter says to read again).
 *
 * The writers (`storeSidebarGroupOrder`, `storePageAccountOrder`, a layout received from a paired
 * device) save to storage and dispatch the `UI_EVENTS` events; this store turns those events into a
 * snapshot for `useSyncExternalStore`, so the screens need no listeners or tick counters of their
 * own. It listens only while something subscribes.
 */
export type Layout = {
  providerOrder: readonly Provider[];
  groupOrder: readonly string[];
  pageOrderVersion: number;
};

let current: Layout | null = null;
const listeners = new Set<() => void>();
let detach: (() => void) | null = null;

const sameList = <T,>(a: readonly T[], b: readonly T[]) => a.length === b.length && a.every((value, index) => value === b[index]);

export function getLayout(): Layout {
  current ??= {
    providerOrder: readDashboardProviderOrder(),
    groupOrder: readSidebarGroupOrder(),
    pageOrderVersion: 0,
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
  if (sameList(before.providerOrder, providerOrder) && sameList(before.groupOrder, groupOrder)) return false;
  current = { ...before, providerOrder, groupOrder };
  return true;
}

function onOrdersChanged() {
  if (refreshOrders()) emit();
}

function onPageOrderChanged() {
  const before = getLayout();
  current = { ...before, pageOrderVersion: before.pageOrderVersion + 1 };
  emit();
}

function attach() {
  // Anything saved while nobody was listening is picked up now.
  refreshOrders();
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

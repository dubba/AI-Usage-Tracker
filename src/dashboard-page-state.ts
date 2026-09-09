import type { Account } from "./types";

export const DASHBOARD_PAGE_ORDER_EVENT = "ai-subscription-tracker:page-order-changed";

const COLLAPSED_PREFIX = "ai-usage-tracker:card-collapsed:";
const PAGE_ORDER_PREFIX = "ai-usage-tracker:page-account-order:";

function isPageScopedCollapsedKey(rest: string): boolean {
  return rest.startsWith("all:") || rest.startsWith("provider:") || rest.startsWith("bucket:");
}

export function migrateLegacyCollapsedCards(): void {
  try {
    const keys: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (key && key.startsWith(COLLAPSED_PREFIX)) keys.push(key);
    }
    for (const key of keys) {
      const rest = key.slice(COLLAPSED_PREFIX.length);
      if (isPageScopedCollapsedKey(rest)) continue;
      if (window.localStorage.getItem(key) === "true") {
        window.localStorage.setItem(`${COLLAPSED_PREFIX}all:${rest}`, "true");
      }
      window.localStorage.removeItem(key);
    }
  } catch {
    // WebView storage may be unavailable.
  }
}

export function isCardCollapsedOnPage(pageId: string, accountId: string): boolean {
  try {
    return window.localStorage.getItem(`${COLLAPSED_PREFIX}${pageId}:${accountId}`) === "true";
  } catch {
    return false;
  }
}

export function setCardCollapsedOnPage(pageId: string, accountId: string, collapsed: boolean): void {
  try {
    const key = `${COLLAPSED_PREFIX}${pageId}:${accountId}`;
    if (collapsed) window.localStorage.setItem(key, "true");
    else window.localStorage.removeItem(key);
  } catch {
    // Ignore localStorage errors.
  }
}

export function readPageAccountOrder(pageId: string): string[] {
  try {
    const raw = window.localStorage.getItem(`${PAGE_ORDER_PREFIX}${pageId}`);
    const parsed = JSON.parse(raw ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === "string" && id.length > 0);
  } catch {
    return [];
  }
}

export function storePageAccountOrder(pageId: string, accountIds: string[]): void {
  try {
    window.localStorage.setItem(`${PAGE_ORDER_PREFIX}${pageId}`, JSON.stringify(accountIds));
  } catch {
    // Ordering remains usable for this session when storage is unavailable.
  }
  window.dispatchEvent(
    new CustomEvent(DASHBOARD_PAGE_ORDER_EVENT, { detail: { pageId, order: accountIds } }),
  );
}

export function applyPageAccountOrder(accounts: Account[], pageId: string): Account[] {
  const saved = readPageAccountOrder(pageId);
  if (!saved.length) return accounts;
  const remaining = new Map(accounts.map((account) => [account.id, account]));
  const ordered: Account[] = [];
  for (const id of saved) {
    const account = remaining.get(id);
    if (!account) continue;
    ordered.push(account);
    remaining.delete(id);
  }
  for (const account of accounts) {
    if (remaining.has(account.id)) ordered.push(account);
  }
  return ordered;
}

function collectCollapsedByPage(): Record<string, string[]> {
  const byPage: Record<string, string[]> = {};
  try {
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (!key || !key.startsWith(COLLAPSED_PREFIX)) continue;
      if (window.localStorage.getItem(key) !== "true") continue;
      const rest = key.slice(COLLAPSED_PREFIX.length);
      const split = rest.indexOf(":");
      if (split <= 0) continue;
      let pageId: string;
      let accountId: string;
      if (rest.startsWith("provider:") || rest.startsWith("bucket:")) {
        const second = rest.indexOf(":", rest.indexOf(":") + 1);
        if (second < 0) continue;
        pageId = rest.slice(0, second);
        accountId = rest.slice(second + 1);
      } else {
        pageId = rest.slice(0, split);
        accountId = rest.slice(split + 1);
      }
      if (!pageId || !accountId) continue;
      (byPage[pageId] ??= []).push(accountId);
    }
  } catch {
    // Ignore.
  }
  return byPage;
}

function collectPageOrders(): Record<string, string[]> {
  const orders: Record<string, string[]> = {};
  try {
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (!key || !key.startsWith(PAGE_ORDER_PREFIX)) continue;
      const pageId = key.slice(PAGE_ORDER_PREFIX.length);
      const order = readPageAccountOrder(pageId);
      if (pageId && order.length) orders[pageId] = order;
    }
  } catch {
    // Ignore.
  }
  return orders;
}

export function collectPageUiState(): {
  collapsed_account_ids?: string[];
  collapsed_cards?: Record<string, string[]>;
  page_account_order?: Record<string, string[]>;
} {
  const collapsedCards = collectCollapsedByPage();
  const pageOrder = collectPageOrders();
  const ui: {
    collapsed_account_ids?: string[];
    collapsed_cards?: Record<string, string[]>;
    page_account_order?: Record<string, string[]>;
  } = {};
  if (Object.keys(collapsedCards).length) ui.collapsed_cards = collapsedCards;
  if (collapsedCards.all?.length) ui.collapsed_account_ids = collapsedCards.all;
  if (Object.keys(pageOrder).length) ui.page_account_order = pageOrder;
  return ui;
}

function writeCollapsedMap(byPage: Record<string, string[]>): void {
  const existing: string[] = [];
  for (let i = 0; i < window.localStorage.length; i++) {
    const key = window.localStorage.key(i);
    if (key && key.startsWith(COLLAPSED_PREFIX)) existing.push(key);
  }
  for (const key of existing) window.localStorage.removeItem(key);
  for (const [pageId, ids] of Object.entries(byPage)) {
    for (const id of ids) {
      window.localStorage.setItem(`${COLLAPSED_PREFIX}${pageId}:${id}`, "true");
    }
  }
}

export function applyPageUiState(payload: Record<string, unknown>): void {
  try {
    if (payload.collapsed_cards && typeof payload.collapsed_cards === "object" && !Array.isArray(payload.collapsed_cards)) {
      writeCollapsedMap(payload.collapsed_cards as Record<string, string[]>);
    } else if (Array.isArray(payload.collapsed_account_ids)) {
      writeCollapsedMap({ all: payload.collapsed_account_ids as string[] });
    }
    if (payload.page_account_order && typeof payload.page_account_order === "object" && !Array.isArray(payload.page_account_order)) {
      const orders = payload.page_account_order as Record<string, unknown>;
      for (const [pageId, value] of Object.entries(orders)) {
        if (!Array.isArray(value)) continue;
        const ids = value.filter((id): id is string => typeof id === "string" && id.length > 0);
        storePageAccountOrder(pageId, ids);
      }
    }
  } catch {
    // Ignore storage failures during pairing apply.
  }
}

import { UI_EVENTS } from "./events";
import { readJson, storageGet, storageKeys, storageRemove, storageSet, STORAGE_PREFIXES, writeJson } from "./storage";
import type { Account } from "./types";

export const DASHBOARD_PAGE_ORDER_EVENT = UI_EVENTS.pageOrderChanged;

const COLLAPSED_PREFIX = STORAGE_PREFIXES.cardCollapsed;
const PAGE_ORDER_PREFIX = STORAGE_PREFIXES.pageAccountOrder;

function isPageScopedCollapsedKey(rest: string): boolean {
  return rest.startsWith("all:") || rest.startsWith("provider:") || rest.startsWith("bucket:");
}

/**
 * Splits the part of a collapsed-card key after the prefix into its page and
 * account ids. Page ids can themselves contain a colon ("provider:openai").
 */
export function parseCollapsedKey(rest: string): { pageId: string; accountId: string } | null {
  const split = rest.indexOf(":");
  if (split <= 0) return null;
  let pageId: string;
  let accountId: string;
  if (rest.startsWith("provider:") || rest.startsWith("bucket:")) {
    const second = rest.indexOf(":", split + 1);
    if (second < 0) return null;
    pageId = rest.slice(0, second);
    accountId = rest.slice(second + 1);
  } else {
    pageId = rest.slice(0, split);
    accountId = rest.slice(split + 1);
  }
  return pageId && accountId ? { pageId, accountId } : null;
}

/** Older versions stored collapsed cards without a page id; they now belong to the "all" page. */
export function migrateLegacyCollapsedCards(): void {
  for (const key of storageKeys(COLLAPSED_PREFIX)) {
    const rest = key.slice(COLLAPSED_PREFIX.length);
    if (isPageScopedCollapsedKey(rest)) continue;
    if (storageGet(key) === "true") {
      storageSet(`${COLLAPSED_PREFIX}all:${rest}`, "true");
    }
    storageRemove(key);
  }
}

export function isCardCollapsedOnPage(pageId: string, accountId: string): boolean {
  return storageGet(`${COLLAPSED_PREFIX}${pageId}:${accountId}`) === "true";
}

export function setCardCollapsedOnPage(pageId: string, accountId: string, collapsed: boolean): void {
  const key = `${COLLAPSED_PREFIX}${pageId}:${accountId}`;
  if (collapsed) storageSet(key, "true");
  else storageRemove(key);
}

export function readPageAccountOrder(pageId: string): string[] {
  return readJson<unknown[]>(`${PAGE_ORDER_PREFIX}${pageId}`, [], Array.isArray)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
}

export function storePageAccountOrder(pageId: string, accountIds: string[]): void {
  // If storage is unavailable the order still applies for this session via the event below.
  writeJson(`${PAGE_ORDER_PREFIX}${pageId}`, accountIds);
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
  for (const key of storageKeys(COLLAPSED_PREFIX)) {
    if (storageGet(key) !== "true") continue;
    const parsed = parseCollapsedKey(key.slice(COLLAPSED_PREFIX.length));
    if (parsed) (byPage[parsed.pageId] ??= []).push(parsed.accountId);
  }
  return byPage;
}

function collectPageOrders(): Record<string, string[]> {
  const orders: Record<string, string[]> = {};
  for (const key of storageKeys(PAGE_ORDER_PREFIX)) {
    const pageId = key.slice(PAGE_ORDER_PREFIX.length);
    const order = readPageAccountOrder(pageId);
    if (pageId && order.length) orders[pageId] = order;
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
  for (const key of storageKeys(COLLAPSED_PREFIX)) storageRemove(key);
  for (const [pageId, ids] of Object.entries(byPage)) {
    for (const id of ids) {
      storageSet(`${COLLAPSED_PREFIX}${pageId}:${id}`, "true");
    }
  }
}

export function applyPageUiState(payload: Record<string, unknown>): void {
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
}

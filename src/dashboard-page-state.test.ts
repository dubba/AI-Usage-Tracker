import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyPageAccountOrder,
  applyPageUiState,
  clearPendingAllOrder,
  collectPageUiState,
  DASHBOARD_PAGE_ORDER_EVENT,
  isCardCollapsedOnPage,
  migrateLegacyAllPageOrder,
  migrateLegacyCollapsedCards,
  parseCollapsedKey,
  readPageAccountOrder,
  setCardCollapsedOnPage,
  storePageAccountOrder,
} from "./dashboard-page-state";
import { STORAGE_PREFIXES } from "./storage";
import { captureEvents, installFakeWindow } from "./test-utils/fakeWindow";
import type { Account } from "./types";

let env: ReturnType<typeof installFakeWindow>;

beforeEach(() => {
  env = installFakeWindow();
  clearPendingAllOrder();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const account = (id: string) => ({ id }) as Account;

describe("parseCollapsedKey", () => {
  it("splits plain page ids", () => {
    expect(parseCollapsedKey("all:abc")).toEqual({ pageId: "all", accountId: "abc" });
  });

  it("keeps the colon in provider and bucket page ids", () => {
    expect(parseCollapsedKey("provider:openai:abc")).toEqual({ pageId: "provider:openai", accountId: "abc" });
    expect(parseCollapsedKey("bucket:b1:abc")).toEqual({ pageId: "bucket:b1", accountId: "abc" });
  });

  it("rejects malformed keys", () => {
    expect(parseCollapsedKey("nocolon")).toBeNull();
    expect(parseCollapsedKey(":abc")).toBeNull();
    expect(parseCollapsedKey("provider:openai")).toBeNull();
    expect(parseCollapsedKey("all:")).toBeNull();
  });
});

describe("collapsed cards", () => {
  it("remembers collapsed state per page", () => {
    setCardCollapsedOnPage("all", "a1", true);
    expect(isCardCollapsedOnPage("all", "a1")).toBe(true);
    expect(isCardCollapsedOnPage("provider:openai", "a1")).toBe(false);
    setCardCollapsedOnPage("all", "a1", false);
    expect(isCardCollapsedOnPage("all", "a1")).toBe(false);
  });

  it("moves legacy unscoped keys to the 'all' page", () => {
    env.localStorage.setItem(`${STORAGE_PREFIXES.cardCollapsed}a1`, "true");
    env.localStorage.setItem(`${STORAGE_PREFIXES.cardCollapsed}a2`, "false");
    migrateLegacyCollapsedCards();
    expect(isCardCollapsedOnPage("all", "a1")).toBe(true);
    expect(isCardCollapsedOnPage("all", "a2")).toBe(false);
    expect(env.localStorage.getItem(`${STORAGE_PREFIXES.cardCollapsed}a1`)).toBeNull();
  });
});

describe("page account order", () => {
  it("stores the order and announces the change", () => {
    const events = captureEvents(env.window, DASHBOARD_PAGE_ORDER_EVENT);
    storePageAccountOrder("bucket:b1", ["b", "a"]);
    expect(readPageAccountOrder("bucket:b1")).toEqual(["b", "a"]);
    expect(events).toEqual([{ pageId: "bucket:b1", order: ["b", "a"] }]);
  });

  it("ignores non-string or empty ids when reading", () => {
    env.localStorage.setItem(`${STORAGE_PREFIXES.pageAccountOrder}bucket:b1`, JSON.stringify(["a", 3, "", "b"]));
    expect(readPageAccountOrder("bucket:b1")).toEqual(["a", "b"]);
  });

  it("orders accounts by the saved order and appends unsaved ones", () => {
    storePageAccountOrder("bucket:b1", ["c", "gone", "a"]);
    const ordered = applyPageAccountOrder([account("a"), account("b"), account("c")], "bucket:b1");
    expect(ordered.map((a) => a.id)).toEqual(["c", "a", "b"]);
  });

  it("returns the accounts untouched without a saved order", () => {
    const accounts = [account("a"), account("b")];
    expect(applyPageAccountOrder(accounts, "bucket:b1")).toBe(accounts);
    expect(applyPageAccountOrder(accounts, "all")).toBe(accounts);
  });
});

describe("the all page follows the backend order", () => {
  it("shows a just-dragged order without saving it anywhere", () => {
    const events = captureEvents(env.window, DASHBOARD_PAGE_ORDER_EVENT);
    storePageAccountOrder("all", ["c", "a", "b"]);
    expect(events).toEqual([{ pageId: "all", order: ["c", "a", "b"] }]);
    expect(env.localStorage.getItem(`${STORAGE_PREFIXES.pageAccountOrder}all`)).toBeNull();
    const ordered = applyPageAccountOrder([account("a"), account("b"), account("c")], "all");
    expect(ordered.map((a) => a.id)).toEqual(["c", "a", "b"]);
  });

  it("goes back to the backend order as soon as a fresh snapshot arrives", () => {
    storePageAccountOrder("all", ["c", "a", "b"]);
    clearPendingAllOrder();
    const accounts = [account("b"), account("a"), account("c")];
    expect(applyPageAccountOrder(accounts, "all")).toBe(accounts);
  });

  it("does not hand the all page order to another device, or accept one from it", () => {
    storePageAccountOrder("all", ["b", "a"]);
    expect(collectPageUiState().page_account_order).toBeUndefined();
    applyPageUiState({ page_account_order: { all: ["b", "a"], "bucket:b1": ["x"] } });
    expect(env.localStorage.getItem(`${STORAGE_PREFIXES.pageAccountOrder}all`)).toBeNull();
    expect(readPageAccountOrder("bucket:b1")).toEqual(["x"]);
  });
});

describe("migrateLegacyAllPageOrder", () => {
  const key = `${STORAGE_PREFIXES.pageAccountOrder}all`;

  it("returns the order to save so the page looks the same, and removes the old copy", () => {
    env.localStorage.setItem(key, JSON.stringify(["c", "gone", "a"]));
    expect(migrateLegacyAllPageOrder(["a", "b", "c"])).toEqual(["c", "a", "b"]);
    expect(env.localStorage.getItem(key)).toBeNull();
  });

  it("returns null when the backend order already matches", () => {
    env.localStorage.setItem(key, JSON.stringify(["a", "b"]));
    expect(migrateLegacyAllPageOrder(["a", "b"])).toBeNull();
    expect(env.localStorage.getItem(key)).toBeNull();
  });

  it("does nothing when there was no old order", () => {
    expect(migrateLegacyAllPageOrder(["a", "b"])).toBeNull();
  });

  it("ignores duplicate ids in the old order", () => {
    env.localStorage.setItem(key, JSON.stringify(["b", "b", "a"]));
    expect(migrateLegacyAllPageOrder(["a", "b"])).toEqual(["b", "a"]);
  });
});

describe("page ui state transfer", () => {
  it("collects and re-applies collapsed cards and page order", () => {
    setCardCollapsedOnPage("all", "a1", true);
    setCardCollapsedOnPage("provider:openai", "a2", true);
    storePageAccountOrder("bucket:b1", ["x", "y"]);
    const collected = collectPageUiState();
    expect(collected).toEqual({
      collapsed_cards: { all: ["a1"], "provider:openai": ["a2"] },
      collapsed_account_ids: ["a1"],
      page_account_order: { "bucket:b1": ["x", "y"] },
    });

    env.localStorage.clear();
    applyPageUiState(collected);
    expect(isCardCollapsedOnPage("all", "a1")).toBe(true);
    expect(isCardCollapsedOnPage("provider:openai", "a2")).toBe(true);
    expect(readPageAccountOrder("bucket:b1")).toEqual(["x", "y"]);
  });

  it("replaces the previous collapsed set rather than merging", () => {
    setCardCollapsedOnPage("all", "old", true);
    applyPageUiState({ collapsed_cards: { all: ["new"] } });
    expect(isCardCollapsedOnPage("all", "old")).toBe(false);
    expect(isCardCollapsedOnPage("all", "new")).toBe(true);
  });

  it("accepts the older flat collapsed_account_ids form", () => {
    applyPageUiState({ collapsed_account_ids: ["a1"] });
    expect(isCardCollapsedOnPage("all", "a1")).toBe(true);
  });
});

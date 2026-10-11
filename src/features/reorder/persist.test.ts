// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  snapshot: vi.fn(),
  reorderAccounts: vi.fn(),
  saveBucket: vi.fn(),
}));
vi.mock("../../shared/lib/api", () => ({ bridgeApi: api }));
const resync = vi.hoisted(() => vi.fn());
vi.mock("../../shared/lib/events", () => ({ requestDashboardResync: resync }));
const latest = vi.hoisted(() => ({ snapshot: null as unknown }));
vi.mock("../dashboard/snapshot-store", () => ({ getLatestSnapshot: () => latest.snapshot }));
const sidebar = vi.hoisted(() => ({ saved: [] as string[], store: vi.fn() }));
vi.mock("../dashboard/sidebar-order", () => ({
  readDashboardProviderOrder: () => ["openai", "anthropic", "grok"],
  readSidebarGroupOrder: () => sidebar.saved,
  storeSidebarGroupOrder: sidebar.store,
}));
const pageOrder = vi.hoisted(() => vi.fn());
vi.mock("../dashboard/dashboard-page-state", () => ({
  storePageAccountOrder: pageOrder,
  whileSavingAllOrder: (save: () => Promise<unknown>) => save(),
}));

import { buildSidebarGroups, groupOrderForAccounts } from "../dashboard/sidebar-groups";
import { accountOrderForGroups, persistGroupOrder, persistVisibleAccountOrder } from "./persist";
import type { Account } from "../../types";

const accounts = [
  { id: "o1", provider: "openai" as const },
  { id: "a1", provider: "anthropic" as const },
  { id: "o2", provider: "openai" as const },
  { id: "g1", provider: "grok" as const },
];

beforeEach(() => {
  vi.clearAllMocks();
  latest.snapshot = null;
  sidebar.saved = [];
  api.reorderAccounts.mockResolvedValue(undefined);
  api.saveBucket.mockResolvedValue(undefined);
});

describe("accountOrderForGroups", () => {
  it("lists each provider's accounts in group order", () => {
    expect(accountOrderForGroups(["provider:grok", "provider:openai", "provider:anthropic"], accounts, [])).toEqual([
      "g1",
      "o1",
      "o2",
      "a1",
    ]);
  });

  it("places a bucket's members where the bucket sits and skips them later", () => {
    const buckets = [{ id: "b1", accountIds: ["o2", "g1"] }];
    expect(accountOrderForGroups(["bucket:b1", "provider:openai"], accounts, buckets)).toEqual(["o2", "g1", "o1", "a1"]);
  });

  it("keeps a bucket's members with the bucket even when their provider comes first", () => {
    const buckets = [{ id: "b1", accountIds: ["o2", "g1"] }];
    expect(accountOrderForGroups(["provider:openai", "provider:anthropic", "bucket:b1"], accounts, buckets)).toEqual([
      "o1",
      "a1",
      "o2",
      "g1",
    ]);
  });

  it("appends accounts no group mentions, and ignores the all page", () => {
    expect(accountOrderForGroups(["all", "provider:anthropic"], accounts, [])).toEqual(["a1", "o1", "o2", "g1"]);
  });

  it("never lists an account twice", () => {
    const buckets = [{ id: "b1", accountIds: ["o1", "o1"] }];
    const order = accountOrderForGroups(["bucket:b1", "bucket:b1", "provider:openai"], accounts, buckets);
    expect(new Set(order).size).toBe(order.length);
  });
});

describe("persistGroupOrder", () => {
  it("saves the derived account order and asks the app to resync", async () => {
    api.snapshot.mockResolvedValue({ accounts, buckets: [] });
    await persistGroupOrder(["provider:grok", "provider:openai", "provider:anthropic"]);
    expect(api.reorderAccounts).toHaveBeenCalledWith(["g1", "o1", "o2", "a1"]);
    expect(resync).toHaveBeenCalledTimes(1);
  });

  it("does not save an order that names accounts that no longer exist", async () => {
    api.snapshot.mockResolvedValue({ accounts, buckets: [{ id: "b1", accountIds: ["ghost"] }] });
    await persistGroupOrder(["bucket:b1"]);
    expect(api.reorderAccounts).not.toHaveBeenCalled();
    expect(resync).toHaveBeenCalledTimes(1);
  });

  it("rearranges the all page before the backend has answered", () => {
    latest.snapshot = { accounts, buckets: [] };
    api.snapshot.mockReturnValue(new Promise(() => {}));
    void persistGroupOrder(["provider:grok", "provider:openai", "provider:anthropic"]);
    expect(pageOrder).toHaveBeenCalledWith("all", ["g1", "o1", "o2", "a1"]);
    expect(api.reorderAccounts).not.toHaveBeenCalled();
  });

  it("does not show an order that names accounts that no longer exist", () => {
    latest.snapshot = { accounts, buckets: [{ id: "b1", accountIds: ["ghost"] }] };
    api.snapshot.mockReturnValue(new Promise(() => {}));
    void persistGroupOrder(["bucket:b1"]);
    expect(pageOrder).not.toHaveBeenCalled();
  });

  it("saves from a fresh snapshot, not the one on screen", async () => {
    latest.snapshot = { accounts: accounts.slice(0, 3), buckets: [] };
    api.snapshot.mockResolvedValue({ accounts, buckets: [] });
    await persistGroupOrder(["provider:grok", "provider:openai", "provider:anthropic"]);
    expect(api.reorderAccounts).toHaveBeenCalledWith(["g1", "o1", "o2", "a1"]);
  });

  it("still resyncs when the backend fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    api.snapshot.mockRejectedValue(new Error("offline"));
    await persistGroupOrder(["provider:openai"]);
    expect(resync).toHaveBeenCalledTimes(1);
  });
});

describe("persistVisibleAccountOrder", () => {
  it("saves the all page through the backend", async () => {
    await persistVisibleAccountOrder(["a1", "o1"], null);
    expect(pageOrder).toHaveBeenCalledWith("all", ["a1", "o1"]);
    expect(api.reorderAccounts).toHaveBeenCalledWith(["a1", "o1"]);
    expect(resync).toHaveBeenCalledTimes(1);
  });

  it("keeps a bucket's hidden members after the visible ones", async () => {
    api.snapshot.mockResolvedValue({
      accounts,
      buckets: [{ id: "b1", name: "Work", provider: null, accountIds: ["o1", "a1", "o2"] }],
    });
    await persistVisibleAccountOrder(["o2", "o1"], "bucket:b1");
    expect(api.saveBucket).toHaveBeenCalledWith("Work", null, ["o2", "o1", "a1"], "b1");
    expect(api.reorderAccounts).not.toHaveBeenCalled();
  });

  it("remembers a provider page's order locally without calling the backend", async () => {
    await persistVisibleAccountOrder(["o2", "o1"], "provider:openai");
    expect(pageOrder).toHaveBeenCalledWith("provider:openai", ["o2", "o1"]);
    expect(api.reorderAccounts).not.toHaveBeenCalled();
    expect(api.saveBucket).not.toHaveBeenCalled();
  });
});

describe("persistVisibleAccountOrder keeps the sidebar in step", () => {
  // Enough of an account for the sidebar to title its groups.
  const shown = accounts.map((account) => ({ ...account, label: account.id, email: null })) as unknown as Account[];

  it("moves the sidebar groups to match a card drag on the all page", async () => {
    latest.snapshot = { accounts: shown, buckets: [] };
    await persistVisibleAccountOrder(["g1", "o1", "a1", "o2"], null);
    expect(sidebar.store).toHaveBeenCalledWith(["provider:grok", "provider:openai", "provider:anthropic"]);
    expect(api.reorderAccounts).toHaveBeenCalledWith(["g1", "o1", "a1", "o2"]);
  });

  it("follows the card order even after the sidebar was dragged before", async () => {
    sidebar.saved = ["provider:anthropic", "provider:openai", "provider:grok"];
    latest.snapshot = { accounts: shown, buckets: [] };
    await persistVisibleAccountOrder(["o1", "o2", "a1", "g1"], "all");
    expect(sidebar.store).toHaveBeenCalledWith(["provider:openai", "provider:anthropic", "provider:grok"]);
  });

  it("leaves the sidebar alone when no group changed places", async () => {
    latest.snapshot = { accounts: shown, buckets: [] };
    await persistVisibleAccountOrder(["o2", "o1", "a1", "g1"], null);
    expect(sidebar.store).not.toHaveBeenCalled();
  });

  it("does not touch the sidebar when reordering inside one group's page", async () => {
    latest.snapshot = { accounts: shown, buckets: [] };
    await persistVisibleAccountOrder(["o2", "o1"], "provider:openai");
    expect(sidebar.store).not.toHaveBeenCalled();
  });

  it("round-trips with a sidebar drag, buckets included", () => {
    const buckets = [{ id: "b1", name: "Work", provider: null, accountIds: ["o2", "g1"], createdAt: "", updatedAt: "" }];
    const groups = buildSidebarGroups(shown, buckets, ["openai", "anthropic", "grok"], []);
    for (const order of [
      ["provider:anthropic", "bucket:b1", "provider:openai"],
      ["provider:openai", "provider:anthropic", "bucket:b1"],
    ]) {
      expect(groupOrderForAccounts(accountOrderForGroups(order, shown, buckets), groups)).toEqual(order);
    }
  });
});

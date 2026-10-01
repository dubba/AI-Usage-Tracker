// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  snapshot: vi.fn(),
  reorderAccounts: vi.fn(),
  saveBucket: vi.fn(),
}));
vi.mock("../api", () => ({ bridgeApi: api }));
const resync = vi.hoisted(() => vi.fn());
vi.mock("../events", () => ({ requestDashboardResync: resync }));
vi.mock("../snapshot-store", () => ({ getLatestSnapshot: () => null }));
const pageOrder = vi.hoisted(() => vi.fn());
vi.mock("../dashboard-page-state", () => ({ storePageAccountOrder: pageOrder }));

import { accountOrderForGroups, persistGroupOrder, persistVisibleAccountOrder } from "./persist";

const accounts = [
  { id: "o1", provider: "openai" as const },
  { id: "a1", provider: "anthropic" as const },
  { id: "o2", provider: "openai" as const },
  { id: "g1", provider: "grok" as const },
];

beforeEach(() => {
  vi.clearAllMocks();
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

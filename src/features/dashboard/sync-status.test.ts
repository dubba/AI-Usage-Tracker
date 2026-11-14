import { describe, expect, it } from "vitest";
import { computeSyncStatus, splitSyncLabel } from "./sync-status";
import type { Account, UsageSnapshot } from "../../types";

const NOW = new Date("2026-09-29T12:00:00.000Z").getTime();
const MIN = 60_000;

function account(id: string, fetchedMinutesAgo: number | null, overrides: Partial<Account> = {}): Account {
  const lastUsage = fetchedMinutesAgo == null
    ? null
    : ({ fetchedAt: new Date(NOW - fetchedMinutesAgo * MIN).toISOString(), freshness: "live", source: "test", windows: [] } as unknown as UsageSnapshot);
  return { id, label: id, provider: "openai", lastUsage, lastError: null, authRequired: false, ...overrides } as Account;
}

describe("computeSyncStatus", () => {
  it("says nothing has synced when no account has data", () => {
    expect(computeSyncStatus([], NOW, 15)).toEqual({ tone: "none", label: "Not synced yet" });
    expect(computeSyncStatus([account("a", null)], NOW, 15)).toEqual({ tone: "none", label: "Not synced yet" });
  });

  it("reports the oldest refresh, the moment every account had been synced", () => {
    const status = computeSyncStatus([account("a", 5), account("b", 2)], NOW, 15);
    expect(status).toEqual({ tone: "fresh", label: "All accounts updated: 5m ago" });
  });

  it("uses 'just now' inside the first minute", () => {
    expect(computeSyncStatus([account("a", 0)], NOW, 15).label).toBe("All accounts updated: just now");
  });

  it("flags accounts older than twice the refresh interval", () => {
    const status = computeSyncStatus([account("a", 1), account("b", 31)], NOW, 15);
    expect(status.tone).toBe("stale");
    expect(status.label).toBe("All accounts updated: 31m ago");
  });

  it("does not flag an account just under the threshold", () => {
    expect(computeSyncStatus([account("a", 29)], NOW, 15).tone).toBe("fresh");
    expect(computeSyncStatus([account("a", 30)], NOW, 15).tone).toBe("stale");
  });

  it("never treats data under ten minutes old as stale, even with a very short interval", () => {
    expect(computeSyncStatus([account("a", 9)], NOW, 1).tone).toBe("fresh");
    expect(computeSyncStatus([account("a", 10)], NOW, 1).tone).toBe("stale");
  });

  it("keeps the synced wording while accounts are out of date, timed from the oldest", () => {
    const status = computeSyncStatus([account("a", 60), account("b", 90)], NOW, 15);
    expect(status.tone).toBe("stale");
    expect(status.label).toBe("All accounts updated: 1h ago");
  });

  it("turns red when an account must sign in again, however fresh the rest are", () => {
    const status = computeSyncStatus([account("a", 1), account("b", 300, { authRequired: true })], NOW, 15);
    expect(status.tone).toBe("sign-in");
  });

  it("turns red for a signed-out account that never loaded any usage", () => {
    expect(computeSyncStatus([account("a", 1), account("b", null, { authRequired: true })], NOW, 15).tone).toBe("sign-in");
  });

  it("turns amber when a recent refresh failed or left older usage on screen", () => {
    expect(computeSyncStatus([account("a", 1), account("b", 1, { lastError: "boom" })], NOW, 15).tone).toBe("stale");
    const staleUsage = { ...account("b", 1).lastUsage, freshness: "stale" } as UsageSnapshot;
    expect(computeSyncStatus([account("a", 1), account("b", 1, { lastUsage: staleUsage })], NOW, 15).tone).toBe("stale");
  });

  it("shows red rather than amber when both problems are present", () => {
    const accounts = [account("a", 90), account("b", 1, { authRequired: true })];
    expect(computeSyncStatus(accounts, NOW, 15).tone).toBe("sign-in");
  });
});

describe("splitSyncLabel", () => {
  it("separates the elapsed time so it can wrap on its own", () => {
    expect(splitSyncLabel("All accounts updated: 4m ago")).toEqual({ title: "All accounts updated:", elapsed: "4m ago" });
    expect(splitSyncLabel("All accounts updated: just now")).toEqual({ title: "All accounts updated:", elapsed: "just now" });
  });

  it("leaves labels without an elapsed time whole", () => {
    expect(splitSyncLabel("Not synced yet")).toEqual({ title: "Not synced yet", elapsed: null });
    expect(splitSyncLabel("All accounts updated:")).toEqual({ title: "All accounts updated:", elapsed: null });
  });
});

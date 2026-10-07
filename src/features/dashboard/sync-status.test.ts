import { describe, expect, it } from "vitest";
import { computeSyncStatus } from "./sync-status";
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
    expect(computeSyncStatus([], NOW, 15)).toEqual({ tone: "none", label: "Not synced yet", detail: null });
    expect(computeSyncStatus([account("a", null)], NOW, 15)).toEqual({ tone: "none", label: "Not synced yet", detail: null });
  });

  it("reports the oldest refresh, the moment every account had been synced", () => {
    const status = computeSyncStatus([account("a", 5), account("b", 2)], NOW, 15);
    expect(status).toEqual({ tone: "fresh", label: "Accounts synced 5m ago", detail: null });
  });

  it("uses 'just now' inside the first minute", () => {
    expect(computeSyncStatus([account("a", 0)], NOW, 15).label).toBe("Accounts synced just now");
  });

  it("flags accounts older than twice the refresh interval", () => {
    const status = computeSyncStatus([account("a", 1), account("b", 31)], NOW, 15);
    expect(status.tone).toBe("stale");
    expect(status.label).toBe("Accounts synced 31m ago");
    expect(status.detail).toBe("1 account out of date");
  });

  it("does not flag an account just under the threshold", () => {
    expect(computeSyncStatus([account("a", 29)], NOW, 15).tone).toBe("fresh");
    expect(computeSyncStatus([account("a", 30)], NOW, 15).tone).toBe("stale");
  });

  it("never treats data under ten minutes old as stale, even with a very short interval", () => {
    expect(computeSyncStatus([account("a", 9)], NOW, 1).tone).toBe("fresh");
    expect(computeSyncStatus([account("a", 10)], NOW, 1).tone).toBe("stale");
  });

  it("pluralizes the out-of-date count", () => {
    const status = computeSyncStatus([account("a", 60), account("b", 90)], NOW, 15);
    expect(status.label).toBe("Accounts synced 1h ago");
    expect(status.detail).toBe("2 accounts out of date");
  });

  it("ignores accounts that are not refreshed automatically", () => {
    const status = computeSyncStatus([account("a", 1), account("b", 300, { authRequired: true })], NOW, 15);
    expect(status.tone).toBe("fresh");
  });
});

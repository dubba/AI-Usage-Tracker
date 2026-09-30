import { describe, expect, it, vi } from "vitest";
import { getLatestSnapshot, onSnapshot, publishSnapshot } from "./snapshot-store";
import type { DashboardSnapshot } from "./types";

const snapshot = (id: string) => ({ accounts: [{ id }], buckets: [], bridge: {} }) as unknown as DashboardSnapshot;

describe("snapshot store", () => {
  it("keeps the latest snapshot and notifies subscribers", () => {
    const listener = vi.fn();
    const unsubscribe = onSnapshot(listener);
    publishSnapshot(snapshot("a"));
    publishSnapshot(snapshot("b"));
    expect(getLatestSnapshot()?.accounts[0].id).toBe("b");
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    publishSnapshot(snapshot("c"));
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

import { describe, expect, it } from "vitest";
import { getLatestSnapshot, publishSnapshot } from "./snapshot-store";
import type { DashboardSnapshot } from "../../types";

const snapshot = (id: string) => ({ accounts: [{ id }], buckets: [], bridge: {} }) as unknown as DashboardSnapshot;

describe("snapshot store", () => {
  it("keeps the latest snapshot", () => {
    publishSnapshot(snapshot("a"));
    publishSnapshot(snapshot("b"));
    expect(getLatestSnapshot()?.accounts[0].id).toBe("b");
  });
});

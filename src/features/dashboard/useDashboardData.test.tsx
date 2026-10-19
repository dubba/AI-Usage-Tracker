// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  snapshot: vi.fn(),
  refreshAll: vi.fn(),
}));
vi.mock("../../shared/lib/api", () => ({ bridgeApi: api }));

import { mount, settle, type Mounted } from "../../test-utils/react";
import { UI_EVENTS } from "../../shared/lib/events";
import { beginReordering, DROP_COOLDOWN_MS, endReordering, resetReorderingForTests } from "../../shared/lib/reorder-activity";
import type { Account, DashboardSnapshot } from "../../types";
import { CREDENTIAL_PROTECTION_ERROR_SOURCE } from "./credential-protection";
import { getLatestSnapshot } from "./snapshot-store";
import { useDashboardData } from "./useDashboardData";

const NOW = new Date("2026-03-01T12:00:00Z");

function makeAccount(id: string, fetchedAt: string | null): Account {
  return {
    id,
    label: id,
    provider: "openai",
    lastUsage: fetchedAt ? { fetchedAt, windows: [] } : null,
    lastError: null,
    authRequired: false,
  } as unknown as Account;
}

function makeSnapshot(tag: string, accounts: Account[] = [], unprotectedCredentials = 0): DashboardSnapshot {
  return {
    accounts: accounts.length ? accounts : [makeAccount(tag, NOW.toISOString())],
    buckets: [],
    bridge: {} as DashboardSnapshot["bridge"],
    unprotectedCredentials,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const reportError = vi.fn();
const clearError = vi.fn();
let latest: ReturnType<typeof useDashboardData>;

function capture(value: ReturnType<typeof useDashboardData>) {
  latest = value;
}

function Harness({ accountRefreshMinutes }: { accountRefreshMinutes?: number }) {
  capture(useDashboardData({ reportError, clearError, accountRefreshMinutes }));
  return null;
}

let mounted: Mounted | null = null;

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function setVisibility(state: "hidden" | "visible") {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  resetReorderingForTests();
  api.snapshot.mockReset();
  api.refreshAll.mockReset();
  api.refreshAll.mockResolvedValue([]);
  reportError.mockReset();
  clearError.mockReset();
});

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  resetReorderingForTests();
  vi.useRealTimers();
});

describe("useDashboardData", () => {
  it("loads the snapshot on mount and publishes it", async () => {
    const first = makeSnapshot("first");
    api.snapshot.mockResolvedValue(first);
    mounted = mount(<Harness />);
    expect(latest.snapshot).toBeNull();
    await settle();
    expect(latest.snapshot).toBe(first);
    expect(getLatestSnapshot()).toBe(first);
    expect(clearError).toHaveBeenCalledWith("load");
  });

  it("reports a failed load and keeps the previous snapshot", async () => {
    const first = makeSnapshot("first");
    api.snapshot.mockResolvedValueOnce(first).mockRejectedValueOnce(new Error("backend down"));
    mounted = mount(<Harness />);
    await settle();
    await act(async () => {
      await latest.load();
    });
    expect(reportError).toHaveBeenCalledWith("load", expect.any(Error));
    expect(latest.snapshot).toBe(first);
  });

  it("raises the credential-protection banner once for a changed count", async () => {
    api.snapshot.mockResolvedValue(makeSnapshot("a", [], 2));
    mounted = mount(<Harness />);
    await settle();
    expect(reportError).toHaveBeenCalledWith(CREDENTIAL_PROTECTION_ERROR_SOURCE, expect.stringContaining("2 saved sign-ins"));
    await act(async () => {
      await latest.load();
    });
    const raised = reportError.mock.calls.filter(([source]) => source === CREDENTIAL_PROTECTION_ERROR_SOURCE);
    expect(raised).toHaveLength(1);
  });

  it("polls every 30 seconds and refreshes all accounts 3 seconds after launch", async () => {
    api.snapshot.mockResolvedValue(makeSnapshot("a"));
    mounted = mount(<Harness />);
    await settle();
    expect(api.snapshot).toHaveBeenCalledTimes(1);
    expect(api.refreshAll).not.toHaveBeenCalled();

    await advance(3_000);
    expect(api.refreshAll).toHaveBeenCalledTimes(1);
    const afterStartup = api.snapshot.mock.calls.length;
    expect(afterStartup).toBe(2);

    await advance(26_999);
    expect(api.snapshot).toHaveBeenCalledTimes(afterStartup);
    await advance(1);
    expect(api.snapshot).toHaveBeenCalledTimes(afterStartup + 1);
    await advance(30_000);
    expect(api.snapshot).toHaveBeenCalledTimes(afterStartup + 2);
  });

  it("reports a failed startup refresh", async () => {
    api.snapshot.mockResolvedValue(makeSnapshot("a"));
    api.refreshAll.mockRejectedValue(new Error("offline"));
    mounted = mount(<Harness />);
    await settle();
    await advance(3_000);
    expect(reportError).toHaveBeenCalledWith("refresh-all", expect.any(Error), "Couldn't refresh accounts");
  });

  it("skips loads while dragging and runs one as soon as the drag has ended", async () => {
    api.snapshot.mockResolvedValue(makeSnapshot("a"));
    mounted = mount(<Harness />);
    await settle();
    expect(api.snapshot).toHaveBeenCalledTimes(1);

    beginReordering();
    let result: DashboardSnapshot | null | undefined;
    await act(async () => {
      result = await latest.load();
    });
    expect(result).toBeNull();
    expect(api.snapshot).toHaveBeenCalledTimes(1);

    endReordering();
    await settle();
    // Still inside the cooldown after the drop.
    expect(api.snapshot).toHaveBeenCalledTimes(1);
    await advance(DROP_COOLDOWN_MS + 1);
    expect(api.snapshot).toHaveBeenCalledTimes(2);
  });

  it("does not load again after a drag when nothing was skipped", async () => {
    api.snapshot.mockResolvedValue(makeSnapshot("a"));
    mounted = mount(<Harness />);
    await settle();
    beginReordering();
    endReordering();
    await advance(DROP_COOLDOWN_MS + 1);
    expect(api.snapshot).toHaveBeenCalledTimes(1);
  });

  it("loads again when the dashboard asks for a resync", async () => {
    api.snapshot.mockResolvedValue(makeSnapshot("a"));
    mounted = mount(<Harness />);
    await settle();
    act(() => {
      window.dispatchEvent(new Event(UI_EVENTS.dashboardResync));
    });
    await settle();
    expect(api.snapshot).toHaveBeenCalledTimes(2);
  });

  describe("refresh when due on return", () => {
    const stale = makeAccount("stale", "2026-03-01T10:00:00Z");
    const fresh = makeAccount("fresh", "2026-03-01T11:59:00Z");

    afterEach(() => setVisibility("visible"));

    async function hideThenShow() {
      setVisibility("hidden");
      setVisibility("visible");
      await settle();
    }

    it("refreshes all accounts when one is older than the refresh interval", async () => {
      api.snapshot.mockResolvedValue(makeSnapshot("x", [stale, fresh]));
      mounted = mount(<Harness accountRefreshMinutes={15} />);
      await settle();
      await hideThenShow();
      expect(api.refreshAll).toHaveBeenCalledTimes(1);
      expect(clearError).toHaveBeenCalledWith("refresh-due");
    });

    it("does nothing when every account is recent enough", async () => {
      api.snapshot.mockResolvedValue(makeSnapshot("x", [fresh]));
      mounted = mount(<Harness accountRefreshMinutes={15} />);
      await settle();
      await hideThenShow();
      expect(api.snapshot).toHaveBeenCalledTimes(2);
      expect(api.refreshAll).not.toHaveBeenCalled();
    });

    it("uses the default interval while settings have not loaded", async () => {
      api.snapshot.mockResolvedValue(makeSnapshot("x", [stale]));
      mounted = mount(<Harness />);
      await settle();
      await hideThenShow();
      expect(api.refreshAll).toHaveBeenCalledTimes(1);
    });

    it("does nothing when the window was never hidden", async () => {
      api.snapshot.mockResolvedValue(makeSnapshot("x", [stale]));
      mounted = mount(<Harness accountRefreshMinutes={15} />);
      await settle();
      setVisibility("visible");
      await settle();
      expect(api.snapshot).toHaveBeenCalledTimes(1);
      expect(api.refreshAll).not.toHaveBeenCalled();
    });

    it("reports a failed refresh", async () => {
      api.snapshot.mockResolvedValue(makeSnapshot("x", [stale]));
      mounted = mount(<Harness accountRefreshMinutes={15} />);
      await settle();
      api.refreshAll.mockRejectedValueOnce(new Error("offline"));
      await hideThenShow();
      expect(reportError).toHaveBeenCalledWith("refresh-due", expect.any(Error), "Couldn't refresh accounts");
    });

    it("ignores a second return while the first refresh is still running", async () => {
      api.snapshot.mockResolvedValue(makeSnapshot("x", [stale]));
      mounted = mount(<Harness accountRefreshMinutes={15} />);
      await settle();
      const pending = deferred<Account[]>();
      api.refreshAll.mockReturnValueOnce(pending.promise);
      await hideThenShow();
      await hideThenShow();
      expect(api.refreshAll).toHaveBeenCalledTimes(1);
      pending.resolve([]);
      await settle();
    });
  });

  describe("overlapping loads", () => {
    async function startTwoLoads() {
      const older = deferred<DashboardSnapshot>();
      const newer = deferred<DashboardSnapshot>();
      api.snapshot.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
      mounted = mount(<Harness />);
      await settle();
      act(() => {
        window.dispatchEvent(new Event(UI_EVENTS.dashboardResync));
      });
      await settle();
      expect(api.snapshot).toHaveBeenCalledTimes(2);
      return { older, newer };
    }

    it("keeps the newest snapshot when an earlier load answers last", async () => {
      const { older, newer } = await startTwoLoads();

      const newest = makeSnapshot("newest");
      newer.resolve(newest);
      await settle();
      expect(latest.snapshot).toBe(newest);

      older.resolve(makeSnapshot("older"));
      await settle();
      expect(latest.snapshot).toBe(newest);
      expect(getLatestSnapshot()).toBe(newest);
    });

    it("shows both answers in order when they arrive in order", async () => {
      const { older, newer } = await startTwoLoads();
      const first = makeSnapshot("first");
      const second = makeSnapshot("second");

      older.resolve(first);
      await settle();
      expect(latest.snapshot).toBe(first);
      newer.resolve(second);
      await settle();
      expect(latest.snapshot).toBe(second);
    });

    it("does not report a failure of an older load once a newer answer is shown", async () => {
      const { older, newer } = await startTwoLoads();
      newer.resolve(makeSnapshot("newest"));
      await settle();
      older.reject(new Error("timed out"));
      await settle();
      expect(reportError).not.toHaveBeenCalled();
    });

    it("reports a failure when nothing newer has been shown", async () => {
      const { older } = await startTwoLoads();
      older.reject(new Error("backend down"));
      await settle();
      expect(reportError).toHaveBeenCalledWith("load", expect.any(Error));
    });
  });
});

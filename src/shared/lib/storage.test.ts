import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installFakeWindow } from "../../test-utils/fakeWindow";
import { clearAppStorage, hintStorageKeys, isStringArray, readJson, storageGet, storageKeys, storageRemove, storageSet, writeJson } from "./storage";

beforeEach(() => {
  installFakeWindow();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("storage helpers", () => {
  it("stores, reads, and removes values", () => {
    expect(storageGet("k")).toBeNull();
    expect(storageSet("k", "v")).toBe(true);
    expect(storageGet("k")).toBe("v");
    storageRemove("k");
    expect(storageGet("k")).toBeNull();
  });

  it("keeps local and session storage separate", () => {
    storageSet("k", "local");
    storageSet("k", "session", "session");
    expect(storageGet("k")).toBe("local");
    expect(storageGet("k", "session")).toBe("session");
  });

  it("clears every key the app wrote, in both storages, and nothing else", () => {
    for (const key of [
      "ai-usage-tracker:theme",
      "ai-usage-tracker:card-collapsed:abc",
      "ai-subscription-tracker:provider-order",
      "paseo-usage-bridge:sidebar-width",
      "somebody-else:theme",
    ]) {
      storageSet(key, "x");
    }
    storageSet("ai-usage-tracker:login-attempt", "x", "session");
    storageSet("somebody-else:session", "x", "session");

    clearAppStorage();

    expect(storageKeys("ai-usage-tracker:")).toEqual([]);
    expect(storageKeys("ai-subscription-tracker:")).toEqual([]);
    expect(storageKeys("paseo-usage-bridge:")).toEqual([]);
    expect(storageKeys("ai-usage-tracker:", "session")).toEqual([]);
    expect(storageGet("somebody-else:theme")).toBe("x");
    expect(storageGet("somebody-else:session", "session")).toBe("x");
  });

  it("lists keys by prefix", () => {
    storageSet("a:1", "x");
    storageSet("a:2", "x");
    storageSet("b:1", "x");
    expect(storageKeys("a:").sort()).toEqual(["a:1", "a:2"]);
  });

  it("round-trips JSON", () => {
    writeJson("list", ["a", "b"]);
    expect(readJson("list", [], isStringArray)).toEqual(["a", "b"]);
  });

  it("falls back for missing, malformed, or invalid JSON", () => {
    expect(readJson("missing", ["fallback"])).toEqual(["fallback"]);
    storageSet("bad", "{not json");
    expect(readJson("bad", ["fallback"])).toEqual(["fallback"]);
    writeJson("wrong", [1, 2]);
    expect(readJson("wrong", ["fallback"], isStringArray)).toEqual(["fallback"]);
  });
});

describe("hintStorageKeys", () => {
  it("names the keys earlier versions wrote, so saved hint progress carries over", () => {
    expect(hintStorageKeys("reorder", "accounts")).toEqual({
      seen: "ai-usage-tracker:reorder-hint-seen",
      openCount: "ai-usage-tracker:reorder-hint-open-count",
      sessionCounted: "ai-usage-tracker:reorder-hint-session-counted",
      sessionDismissed: "ai-usage-tracker:reorder-hint-session-dismissed",
    });
    expect(hintStorageKeys("reorder", "activity").seen).toBe("ai-usage-tracker:activity-reorder-hint-seen");
    expect(hintStorageKeys("pull-refresh", "accounts").openCount).toBe("ai-usage-tracker:pull-refresh-hint-open-count");
    expect(hintStorageKeys("pull-refresh", "activity")).toEqual({
      seen: "ai-usage-tracker:activity-pull-refresh-hint-seen",
      openCount: "ai-usage-tracker:activity-pull-refresh-hint-open-count",
      sessionCounted: "ai-usage-tracker:activity-pull-refresh-hint-session-counted",
      sessionDismissed: "ai-usage-tracker:activity-pull-refresh-hint-session-dismissed",
    });
  });
});

describe("when storage is unavailable", () => {
  it("returns safe defaults instead of throwing, and reports it only once", async () => {
    const throwing = {
      get length(): number {
        throw new Error("blocked");
      },
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
      key: () => {
        throw new Error("blocked");
      },
    };
    vi.stubGlobal("window", { localStorage: throwing, sessionStorage: throwing });
    vi.resetModules();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fresh = await import("./storage");

    expect(fresh.storageGet("k")).toBeNull();
    expect(fresh.storageSet("k", "v")).toBe(false);
    expect(fresh.storageKeys("k")).toEqual([]);
    expect(fresh.readJson("k", "fallback")).toBe("fallback");
    expect(() => fresh.storageRemove("k")).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installFakeWindow } from "../../test-utils/fakeWindow";
import { isStringArray, readJson, storageGet, storageKeys, storageRemove, storageSet, writeJson } from "./storage";

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

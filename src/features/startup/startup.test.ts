import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("../../shared/lib/storage", () => ({
  STORAGE_KEYS: {},
  storageGet: () => null,
  storageRemove: () => {},
  storageSet: () => true,
}));

import { loadStartupIssue, retryStartup } from "./startup";

beforeEach(() => {
  invoke.mockReset();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("loadStartupIssue", () => {
  it("returns the problem the backend reported", async () => {
    invoke.mockResolvedValue({ message: "Could not load saved data.", dataDir: "/data" });
    await expect(loadStartupIssue()).resolves.toEqual({ message: "Could not load saved data.", dataDir: "/data" });
    expect(invoke).toHaveBeenCalledWith("get_startup_issue");
  });

  it("returns null when the backend started fine", async () => {
    invoke.mockResolvedValue(null);
    await expect(loadStartupIssue()).resolves.toBeNull();
  });

  it("does not block the app when the command is unavailable", async () => {
    invoke.mockRejectedValue(new Error("command get_startup_issue not found"));
    await expect(loadStartupIssue()).resolves.toBeNull();
  });
});

describe("retryStartup", () => {
  it("returns null once startup succeeds", async () => {
    invoke.mockResolvedValue(null);
    await expect(retryStartup()).resolves.toBeNull();
    expect(invoke).toHaveBeenCalledWith("retry_startup");
  });

  it("returns the remaining problem", async () => {
    invoke.mockResolvedValue({ message: "Still broken.", dataDir: null });
    await expect(retryStartup()).resolves.toEqual({ message: "Still broken.", dataDir: null });
  });

  it("turns a failed retry into a readable problem", async () => {
    invoke.mockRejectedValue("ipc closed");
    await expect(retryStartup()).resolves.toEqual({ message: "Retrying failed: ipc closed", dataDir: null });
  });
});

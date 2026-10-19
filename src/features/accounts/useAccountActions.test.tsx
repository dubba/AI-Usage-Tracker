// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  refreshAccount: vi.fn(),
  refreshAll: vi.fn(),
  renameAccount: vi.fn(),
  removeAccount: vi.fn(),
  setApiIntegrationEnabled: vi.fn(),
  openApiIntegrationWindow: vi.fn(),
}));
vi.mock("../../shared/lib/api", () => ({ bridgeApi: api }));

import { mount, settle, type Mounted } from "../../test-utils/react";
import { createBusyTracker, REFRESH_ALL_KEY } from "../../shared/lib/busy";
import type { Account, BridgeStatus, DashboardSnapshot } from "../../types";
import { useAccountActions } from "./useAccountActions";

function makeAccount(id: string, label = `Account ${id}`): Account {
  return { id, label, provider: "openai", email: null, lastUsage: null, lastError: null, authRequired: false } as unknown as Account;
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

const load = vi.fn();
const setSnapshot = vi.fn();
const reportError = vi.fn();
const clearError = vi.fn();
let busyLog: string[][];
let busy: ReturnType<typeof createBusyTracker>;
let actions: ReturnType<typeof useAccountActions>;

function capture(value: ReturnType<typeof useAccountActions>) {
  actions = value;
}

function Harness() {
  capture(useAccountActions({ load, setSnapshot, busy, reportError, clearError }));
  return null;
}

let mounted: Mounted | null = null;

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset().mockResolvedValue(undefined);
  load.mockReset().mockResolvedValue(null);
  setSnapshot.mockReset();
  reportError.mockReset();
  clearError.mockReset();
  busyLog = [];
  busy = createBusyTracker((keys) => busyLog.push([...keys]));
  mounted = mount(<Harness />);
});

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

describe("refreshOne", () => {
  it("refreshes the account, reloads, clears its error and releases the busy key", async () => {
    await act(async () => {
      await actions.refreshOne("a1");
    });
    expect(api.refreshAccount).toHaveBeenCalledWith("a1");
    expect(load).toHaveBeenCalledTimes(1);
    expect(clearError).toHaveBeenCalledWith("refresh:a1");
    expect(busyLog).toEqual([["refresh:a1"], []]);
  });

  it("does nothing while a refresh of all accounts is running", async () => {
    busy.begin(REFRESH_ALL_KEY);
    await act(async () => {
      await actions.refreshOne("a1");
    });
    expect(api.refreshAccount).not.toHaveBeenCalled();
  });

  it("ignores a second request for the same account while the first runs", async () => {
    const pending = deferred<Account>();
    api.refreshAccount.mockReturnValue(pending.promise);
    let first!: Promise<void>;
    await act(async () => {
      first = actions.refreshOne("a1");
    });
    await act(async () => {
      await actions.refreshOne("a1");
    });
    expect(api.refreshAccount).toHaveBeenCalledTimes(1);
    pending.resolve(makeAccount("a1"));
    await act(async () => {
      await first;
    });
    expect(busy.has("refresh:a1")).toBe(false);
  });

  it("reports a failure under the account's key and still releases it", async () => {
    const cause = new Error("expired");
    api.refreshAccount.mockRejectedValue(cause);
    await act(async () => {
      await actions.refreshOne("a1");
    });
    expect(reportError).toHaveBeenCalledWith("refresh:a1", cause, "Couldn't refresh account");
    expect(clearError).not.toHaveBeenCalled();
    expect(busy.has("refresh:a1")).toBe(false);
  });
});

describe("refreshAll", () => {
  it("refreshes, reloads and clears the error", async () => {
    await act(async () => {
      await actions.refreshAll();
    });
    expect(api.refreshAll).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledTimes(1);
    expect(clearError).toHaveBeenCalledWith(REFRESH_ALL_KEY);
    expect(busy.has(REFRESH_ALL_KEY)).toBe(false);
  });

  it("is ignored while already running", async () => {
    busy.begin(REFRESH_ALL_KEY);
    await act(async () => {
      await actions.refreshAll();
    });
    expect(api.refreshAll).not.toHaveBeenCalled();
  });

  it("reports a failure", async () => {
    const cause = new Error("offline");
    api.refreshAll.mockRejectedValue(cause);
    await act(async () => {
      await actions.refreshAll();
    });
    expect(reportError).toHaveBeenCalledWith(REFRESH_ALL_KEY, cause, "Couldn't refresh accounts");
    expect(load).not.toHaveBeenCalled();
    expect(busy.has(REFRESH_ALL_KEY)).toBe(false);
  });
});

describe("rename", () => {
  it("saves the trimmed label and reloads", async () => {
    await act(async () => {
      await actions.rename(makeAccount("a1", "Old"), "  New name  ");
    });
    expect(api.renameAccount).toHaveBeenCalledWith("a1", "New name");
    expect(load).toHaveBeenCalledTimes(1);
    expect(busy.has("rename:a1")).toBe(false);
  });

  it.each([["empty", "   "], ["unchanged", " Old "]])("does nothing for an %s label", async (_name, label) => {
    await act(async () => {
      await actions.rename(makeAccount("a1", "Old"), label);
    });
    expect(api.renameAccount).not.toHaveBeenCalled();
  });

  it("lets the failure reach the card and releases the busy key", async () => {
    api.renameAccount.mockRejectedValue(new Error("name taken"));
    await act(async () => {
      await expect(actions.rename(makeAccount("a1", "Old"), "New")).rejects.toThrow("name taken");
    });
    expect(reportError).not.toHaveBeenCalled();
    expect(busy.has("rename:a1")).toBe(false);
  });
});

describe("remove", () => {
  it("runs onStarted, removes, reloads and clears the error", async () => {
    const onStarted = vi.fn();
    await act(async () => {
      await actions.remove(makeAccount("a1"), onStarted);
    });
    expect(onStarted).toHaveBeenCalledTimes(1);
    expect(api.removeAccount).toHaveBeenCalledWith("a1");
    expect(load).toHaveBeenCalledTimes(1);
    expect(clearError).toHaveBeenCalledWith("remove:a1");
    expect(busy.has("remove:a1")).toBe(false);
  });

  it("is ignored, without running onStarted, while the same removal is in flight", async () => {
    busy.begin("remove:a1");
    const onStarted = vi.fn();
    await act(async () => {
      await actions.remove(makeAccount("a1"), onStarted);
    });
    expect(onStarted).not.toHaveBeenCalled();
    expect(api.removeAccount).not.toHaveBeenCalled();
  });

  it("names the account in the error message", async () => {
    const cause = new Error("locked");
    api.removeAccount.mockRejectedValue(cause);
    await act(async () => {
      await actions.remove(makeAccount("a1", "Work"));
    });
    expect(reportError).toHaveBeenCalledWith("remove:a1", cause, expect.stringContaining("Work"));
    expect(reportError.mock.calls[0][2]).toMatch(/^Couldn't remove /);
    expect(busy.has("remove:a1")).toBe(false);
  });
});

describe("API integration", () => {
  const status = { enabled: true } as unknown as BridgeStatus;

  it("stores the new bridge status in the snapshot", async () => {
    api.setApiIntegrationEnabled.mockResolvedValue(status);
    await act(async () => {
      await actions.setApiIntegrationEnabled(true);
    });
    expect(api.setApiIntegrationEnabled).toHaveBeenCalledWith(true);
    expect(clearError).toHaveBeenCalledWith("bridge");
    const update = setSnapshot.mock.calls[0][0] as (current: DashboardSnapshot | null) => DashboardSnapshot | null;
    expect(update(null)).toBeNull();
    const current = { accounts: [], buckets: [], bridge: { enabled: false }, unprotectedCredentials: 0 } as unknown as DashboardSnapshot;
    expect(update(current)).toEqual({ ...current, bridge: status });
    expect(busy.has("toggle-api-integration")).toBe(false);
  });

  it("reports a failed toggle without touching the snapshot", async () => {
    const cause = new Error("port in use");
    api.setApiIntegrationEnabled.mockRejectedValue(cause);
    await act(async () => {
      await actions.setApiIntegrationEnabled(true);
    });
    expect(reportError).toHaveBeenCalledWith("bridge", cause, "Couldn't change the API integration");
    expect(setSnapshot).not.toHaveBeenCalled();
    expect(busy.has("toggle-api-integration")).toBe(false);
  });

  it("opens the window, and reports a failure to do so", async () => {
    await act(async () => {
      await actions.openApiIntegrationWindow();
    });
    expect(api.openApiIntegrationWindow).toHaveBeenCalledTimes(1);
    expect(clearError).toHaveBeenCalledWith("bridge");

    const cause = new Error("no window");
    api.openApiIntegrationWindow.mockRejectedValue(cause);
    await act(async () => {
      await actions.openApiIntegrationWindow();
    });
    await settle();
    expect(reportError).toHaveBeenCalledWith("bridge", cause, "Couldn't open the API integration window");
    expect(busy.has("open-api-integration")).toBe(false);
  });
});

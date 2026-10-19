// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ refreshAccount: vi.fn() }));
vi.mock("../shared/lib/api", () => ({ bridgeApi: api }));

import { mount, type Mounted } from "../test-utils/react";
import type { Account, DashboardSnapshot } from "../types";
import { useAfterAccountAdded } from "./useAfterAccountAdded";

function account(overrides: Partial<Account> = {}): Account {
  return { id: "a1", label: "Work", provider: "anthropic", lastUsage: null, lastError: null, authRequired: false, ...overrides } as unknown as Account;
}

function usage(source = "oauth", windows: unknown[] = []) {
  return { source, windows, freshness: "live", fetchedAt: "2026-01-01T00:00:00Z" } as unknown as Account["lastUsage"];
}

function snapshotWith(...accounts: Account[]): DashboardSnapshot {
  return { accounts, buckets: [], bridge: {}, unprotectedCredentials: 0 } as unknown as DashboardSnapshot;
}

const closeAddDialog = vi.fn();
const selectGroup = vi.fn();
const load = vi.fn();
const reportError = vi.fn();
const openGoogleUsage = vi.fn();
let handle: (account: Account) => Promise<void>;

function capture(fn: (account: Account) => Promise<void>) {
  handle = fn;
}

function Probe() {
  capture(useAfterAccountAdded({ closeAddDialog, selectGroup, load, reportError, openGoogleUsage }));
  return null;
}

let mounted: Mounted | null = null;
beforeEach(() => {
  for (const fn of [closeAddDialog, selectGroup, load, reportError, openGoogleUsage, api.refreshAccount]) fn.mockReset();
  mounted = mount(<Probe />);
});
afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

describe("after an account is added", () => {
  it("closes the dialog and shows the provider's page before loading", async () => {
    load.mockResolvedValue(snapshotWith(account({ lastUsage: usage() })));
    const order: string[] = [];
    closeAddDialog.mockImplementation(() => order.push("close"));
    selectGroup.mockImplementation(() => order.push("select"));
    load.mockImplementation(async () => {
      order.push("load");
      return snapshotWith(account({ lastUsage: usage() }));
    });
    await handle(account({ provider: "openai" }));
    expect(order).toEqual(["close", "select", "load"]);
    expect(selectGroup).toHaveBeenCalledWith("provider:openai");
  });

  it("does not refresh when the load already has usage for the new account", async () => {
    load.mockResolvedValue(snapshotWith(account({ lastUsage: usage() })));
    await handle(account());
    expect(api.refreshAccount).not.toHaveBeenCalled();
    expect(openGoogleUsage).not.toHaveBeenCalled();
  });

  it("does not refresh an account that arrived with usage", async () => {
    load.mockResolvedValue(snapshotWith());
    await handle(account({ lastUsage: usage() }));
    expect(api.refreshAccount).not.toHaveBeenCalled();
  });

  it("refreshes once, then reloads, when there is no usage anywhere", async () => {
    load.mockResolvedValue(snapshotWith(account()));
    api.refreshAccount.mockResolvedValue(account({ lastUsage: usage() }));
    await handle(account());
    expect(api.refreshAccount).toHaveBeenCalledWith("a1");
    expect(load).toHaveBeenCalledTimes(2);
    expect(reportError).not.toHaveBeenCalled();
  });

  it("keeps the account and says the first refresh failed", async () => {
    load.mockResolvedValue(snapshotWith(account()));
    const cause = new Error("offline");
    api.refreshAccount.mockRejectedValue(cause);
    await handle(account({ label: "Work" }));
    expect(reportError).toHaveBeenCalledWith("refresh:a1", cause, "Added Work, but couldn't refresh it yet");
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("copes with a load that returns nothing", async () => {
    load.mockResolvedValue(null);
    api.refreshAccount.mockResolvedValue(account({ lastUsage: usage() }));
    await handle(account());
    expect(api.refreshAccount).toHaveBeenCalledTimes(1);
  });

  it("sends a Google AI Studio key without quota windows to the Cloud connection", async () => {
    const key = account({ provider: "google_ai_studio", lastUsage: usage("google_ai_studio_model_access") });
    load.mockResolvedValue(snapshotWith(key));
    await handle(key);
    expect(openGoogleUsage).toHaveBeenCalledWith(expect.objectContaining({ id: "a1" }));
  });

  it("leaves a Google AI Studio account that already has quota windows alone", async () => {
    const window = { id: "w", label: "Gemini", usedPercent: 10, remainingPercent: 90, resetsAt: null, windowSeconds: null };
    const connected = account({ provider: "google_ai_studio", lastUsage: usage("google_ai_studio_cloud_monitoring", [window]) });
    load.mockResolvedValue(snapshotWith(connected));
    await handle(connected);
    expect(openGoogleUsage).not.toHaveBeenCalled();
  });
});
